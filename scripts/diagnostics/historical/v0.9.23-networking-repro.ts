/**
 * Investigation probes, NOT regression tests or a correctness gate.
 * Run: npx vite-node src/games/fps/scripts/diagnostics/historical/v0.9.23-networking-repro.ts
 * Open-item assertions confirm recorded defects still reproduce. Fixed N01/N02
 * now assert correct reconstruction, also covered by SnapshotBaseline.test.ts.
 * No sockets, browser, assets or changes to production code are required.
 */
import assert from "node:assert/strict";
import { Entity } from "../../../../../shared/net/Entity";
import { GameState } from "../../../../../shared/net/GameState";
import { SnapshotReceiver } from "../../../../../engine/network/client/SnapshotReceiver";
import { SnapshotBroadcaster } from "../../../server/SnapshotBroadcaster";
import { V2NetworkClient, type ServerSnapshot } from "../../../client/V2NetworkClient";
import { Simulation } from "../../../../../engine/server/core/Simulation";
import { createPlayerEntity } from "../../../../../engine/server/ecs/Entity";
import { entityId, playerId } from "../../../../../engine/server/ecs/types";

// Private inspection is intentional in this diagnostic: production behavior is
// invoked normally; these casts expose state that public diagnostics omit.
import { FPSMovementSubsystem } from "../../../server/systems/FPSMovementSubsystem";

const observations: Record<string, unknown> = {};
function state(tick: number, x: number): GameState {
  const value = new GameState();
  value.tick = tick;
  const entity = new Entity("player_1");
  entity.addComponent("position", {
    x, y: 0, z: 0, serialize() {}, deserialize() {}, clone() { return { ...this }; },
  });
  value.entities.set(entity.id, entity);
  return value;
}
function xOf(value: GameState): number | undefined {
  return (value.entities.get("player_1")?.getComponent("position") as { x: number } | undefined)?.x;
}
function broadcaster(pvs: boolean) {
  const packets: Uint8Array[] = [];
  const simulation = { getState: () => ({ getEntity: () => ({
    transform: { position: { x: 0, y: 0, z: 0 } }, input: { lastProcessedSeq: 0 },
  }) }) };
  const sender = new SnapshotBroadcaster(simulation as never);
  if (pvs) sender.setPVS({ enabled: true, isVisible: () => true } as never);
  const client = {
    id: "qa", entityId: 1, playerId: 1, lastInputSeq: 0, lastAckedTick: 0,
    connection: { sendDatagram: (packet: Uint8Array) => packets.push(packet.slice()) },
  };
  return { client, send: (value: GameState) => {
    sender.broadcast(new Map([["qa", client]]) as never, value);
    assert.ok(packets.length > 0);
    return packets.pop()!;
  } };
}

// N01 fixed: an intermediate snapshot is lost; reconstruction must still recover.
{
  const { client, send } = broadcaster(true);
  const receiver = new SnapshotReceiver();
  let received = receiver.receive(send(state(1, 0)))!;
  client.lastAckedTick = 1;
  send(state(2, 100)); // lost datagram
  for (let tick = 3; tick <= 8; tick++) {
    received = receiver.receive(send(state(tick, 100)))!;
  }
  observations.N01 = { authoritativeX: 100, decodedX: xOf(received), throughTick: received.tick };
  assert.equal(xOf(received), 100);
}

// N02: every snapshot arrives, in order. ACK 1 reaches server; ACK 2 is still
// in flight when tick 3 returns to tick 1's position. Fixed: exact baseline lookup.
{
  const { client, send } = broadcaster(false);
  const receiver = new SnapshotReceiver();
  receiver.receive(send(state(1, 0)));
  client.lastAckedTick = 1;
  receiver.receive(send(state(2, 100)));
  const received = receiver.receive(send(state(3, 0)))!;
  observations.N02 = { authoritativeX: 0, decodedX: xOf(received), lostPackets: 0 };
  assert.equal(xOf(received), 0);
}

const idle = { direction: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, buttons: 0, clientTick: 0 };
function snapshot(tick = 1, x = 0): ServerSnapshot {
  return { tick, ackedInputSeq: 0, position: { x, y: 5000, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, grounded: false };
}
function apply(client: V2NetworkClient, value: ServerSnapshot) {
  client.bufferSnapshot(value);
  client.processBufferedSnapshots();
}

// N03 fixed: no new inputs between reconciliations. The same authoritative
// state and input history must produce the same result, knockback drag age
// included. The age now arrives with the snapshot and every replay restores it.
{
  const client = new V2NetworkClient({ tickRate: 125 });
  apply(client, snapshot());
  for (let i = 0; i < 30; i++) client.processInput(idle);
  // Deep in the drag window, so the replay really applies drag.
  const authority = { ...snapshot(2), velocity: { x: 400, y: 400, z: 0 }, knockbackAgeTicks: 80 };
  apply(client, authority);
  const first = { ...client.getPosition() };
  apply(client, { ...authority, tick: 3 });
  const second = { ...client.getPosition() };
  observations.N03 = { first, second, replays: 2 };
  assert.deepEqual(first, second);
}

function simulation() {
  const sim = new Simulation({ tickMs: 8 });
  const movement = new FPSMovementSubsystem();
  sim.addSubsystem(movement);
  sim.initialize();
  const id = entityId(1);
  sim.getStateMut().addEntity(createPlayerEntity(id, playerId(1), { x: 0, y: 5000, z: 0 }));
  return { sim, movement, id };
}

// N04 fixed: the real server starvation path advances gravity, and the effect
// clock now advances with it instead of freezing on the repeated sequence.
{
  const { sim, movement, id } = simulation();
  sim.getStateMut().getEntityMut(id)!.input!.inputQueue.push({
    forward: 0, right: 0, pitch: 0, yaw: 0, buttons: 0, sequence: 1, weaponSlot: 0,
  });
  const profiles = (movement as unknown as { movementProfiles: Map<number, { simNowMs: number }> }).movementProfiles;
  sim.tick();
  const clockAfterFirst = profiles.get(1)!.simNowMs;
  for (let i = 1; i < 20; i++) sim.tick(); // 19 starved ticks, sequence stays 1
  const advancedMs = profiles.get(1)!.simNowMs - clockAfterFirst;
  const y = sim.getState().getEntity(id)!.transform!.position.y;
  observations.N04 = { physicsElapsedMs: 19 * 8, effectClockAdvancedMs: advancedMs, y };
  assert.equal(advancedMs, 19 * 8);
  assert.ok(y < 5000);
}

// N05 bounded: seed an eligible walljump state to isolate the correction gate.
// Suppression still exists — it is what keeps wall jumps from jittering — but it
// can no longer ignore authority indefinitely. A divergence this large is a
// discontinuity, not the sub-tick trace disagreement the gate is there for, so
// it is adopted on the first snapshot rather than after a hundred.
{
  const client = new V2NetworkClient({ tickRate: 125 });
  apply(client, snapshot());
  (client as unknown as { predictedMovement: { wallJumpState: string } }).predictedMovement.wallJumpState = "available";
  for (let tick = 2; tick <= 101; tick++) apply(client, snapshot(tick, 1000));
  observations.N05 = {
    serverX: 1000,
    predictedX: client.getPosition().x,
    release: client.getDebugInfo().lastSuppressionRelease,
  };
  assert.equal(client.getPosition().x, 1000);
  assert.equal(client.getDebugInfo().lastSuppressionRelease, "divergence");
}

// N06 fixed: a stale datagram arriving after a newer snapshot — in the same
// frame or a later one — must not regress prediction.
{
  const client = new V2NetworkClient({ tickRate: 125 });
  apply(client, snapshot(20, 200));
  apply(client, snapshot(18, 100));
  observations.N06 = { newestTick: 20, staleTick: 18, predictedX: client.getPosition().x };
  assert.equal(client.getPosition().x, 200);
}

// N07: removeEntity clears profiles but not lastInput. Reuse the id with a
// brand-new input component and no commands: the previous occupant moves it.
{
  const { sim, movement, id } = simulation();
  sim.getStateMut().getEntityMut(id)!.input!.inputQueue.push({
    forward: 1, right: 0, pitch: 0, yaw: 0.75, buttons: 0, sequence: 77, weaponSlot: 0,
  });
  sim.tick();
  movement.removeEntity(1);
  sim.getStateMut().removeEntity(id);
  sim.getStateMut().addEntity(createPlayerEntity(id, playerId(2), { x: 0, y: 5000, z: 0 }));
  sim.tick();
  const input = sim.getState().getEntity(id)!.input!;
  observations.N07 = { newOwner: 2, freshCommands: 0, forward: input.forward, yaw: input.yaw, ackedSeq: input.lastProcessedSeq };
  assert.equal(input.forward, 1);
  assert.equal(input.lastProcessedSeq, 77);
}

// N08 fixed: at 33 unacked inputs, unchanged free-fall authority used to move
// one full physics step. Control at 32 proves this is the replay cap boundary.
{
  const measure = (count: number) => {
    const client = new V2NetworkClient({ tickRate: 125 });
    apply(client, snapshot());
    for (let i = 0; i < count; i++) client.processInput(idle);
    const before = client.getPosition().y;
    // A newer tick carrying the same authoritative state: the client must not
    // move, because authority has not disagreed with the prediction.
    apply(client, snapshot(2));
    return { count, before, after: client.getPosition().y };
  };
  const control = measure(32);
  const truncated = measure(33);
  observations.N08 = { control, truncated, authoritativeY: 5000 };
  // Inside the replay budget, authority agrees and nothing moves.
  assert.equal(control.before, control.after);
  // Past it, the client resynchronises to authority exactly, instead of landing
  // on 4958.272 — a position produced by replaying 32 of 33 commands from a
  // state that precedes all of them.
  assert.equal(truncated.after, 5000);
}

// N10 fixed: one render-frame catch-up burst. FPSController puts a pending
// weapon slot only on its first command and the server still keeps only the
// newest six — the six oldest commands forfeit their physics, as they must, but
// the switch riding one of them is carried onto the oldest survivor.
{
  const { sim, id } = simulation();
  const queue = sim.getStateMut().getEntityMut(id)!.input!.inputQueue;
  for (let sequence = 1; sequence <= 12; sequence++) queue.push({
    forward: 0, right: 0, pitch: 0, yaw: 0, buttons: 0, sequence,
    weaponSlot: sequence === 1 ? 3 : 0,
  });
  const processed: number[] = [];
  const slots: number[] = [];
  for (let i = 0; i < 6; i++) {
    sim.tick();
    const input = sim.getState().getEntity(id)!.input!;
    processed.push(input.lastProcessedSeq);
    slots.push(input.weaponSlot);
  }
  observations.N10 = { sent: 12, requestedSlot: 3, processed, slots };
  assert.deepEqual(processed, [7, 8, 9, 10, 11, 12]); // physics rate unchanged
  assert.ok(slots.every((slot) => slot === 3));
}

console.log("QA_OBSERVATIONS=" + JSON.stringify(observations, null, 2));
console.log("N01-N06, N08 and N10 now assert the fixed behaviour; N07 still reproduces. Not a full correctness gate.");
