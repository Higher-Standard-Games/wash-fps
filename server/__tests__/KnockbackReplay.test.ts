/**
 * Knockback drag across reconciliation (T11).
 *
 * The server applies every impulse itself, and snapshots carry the result as
 * velocity. What velocity cannot carry is how far into its drag window the body
 * is — drag begins 50 steps after the impulse and ramps over 75 more — so a
 * client replaying unacked commands without that age skips drag the server
 * applied. The age now travels with the snapshot, to its owner only.
 *
 * These drive the REAL server movement subsystem and the REAL client, and
 * compare them straight after every reconcile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Vec3 } from "../../../../engine/network/components/TransformComponent";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { Simulation } from "../../../../engine/server/core/Simulation";
import { createPlayerEntity } from "../../../../engine/server/ecs/Entity";
import { type EntityId, entityId, playerId } from "../../../../engine/server/ecs/types";
import type { ServerPVS } from "../../../../engine/server/ServerPVS";
import { GameState } from "../../../../shared/net/GameState";
import type { QueuedInput } from "../../../../shared/server/simulation/components/InputComponent";
import { toClientKey } from "../../ClientEntityKey";
import { type ServerSnapshot, V2NetworkClient } from "../../client/V2NetworkClient";
import { KB_DRAG_DELAY_TICKS, KB_DRAG_RAMP_TICKS } from "../../simulation/Knockback";
import type { ClientInfo } from "../Client";
import { SnapshotBroadcaster } from "../SnapshotBroadcaster";
import { FPSMovementSubsystem } from "../systems/FPSMovementSubsystem";

// The server logs every impulse and periodic physics lines; neither is under test.
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const WINDOW = KB_DRAG_DELAY_TICKS + KB_DRAG_RAMP_TICKS;

/** The impulse lands on this command's tick. */
const IMPULSE_AT = 20;

interface Truth {
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  ack: number;
  age: number | null;
}

const idle = (sequence: number): QueuedInput => ({
  forward: 0,
  right: 0,
  pitch: 0,
  yaw: 0,
  buttons: 0,
  sequence,
  weaponSlot: 0,
});

/**
 * One airborne player on the real movement subsystem, one command per tick.
 * No collision world, so the body falls freely and only expiry — or a landing
 * forced onto the server entity — ends the drag.
 */
function authority(steps: number, opts: { impulseAt?: number; impulseAts?: number[]; landAt?: number } = {}): Truth[] {
  const sim = new Simulation({ tickMs: 8 });
  const movement = new FPSMovementSubsystem();
  sim.addSubsystem(movement);
  sim.initialize();
  const id: EntityId = entityId(1);
  sim.getStateMut().addEntity(createPlayerEntity(id, playerId(1), { x: 0, y: 5000, z: 0 }));
  const seed = sim.getStateMut().getEntityMut(id)!;
  seed.physics!.grounded = false;
  seed.physics!.velocity.y = 0;

  const read = (): Truth => {
    const e = sim.getState().getEntity(id)!;
    return {
      position: { ...e.transform!.position },
      velocity: { ...e.physics!.velocity },
      grounded: e.physics!.grounded,
      ack: e.input!.sequence,
      age: movement.getKnockbackAge(Number(id)),
    };
  };

  const truth: Truth[] = [read()];
  for (let seq = 1; seq <= steps; seq++) {
    const e = sim.getStateMut().getEntityMut(id)!;
    e.input!.inputQueue.push(idle(seq));
    for (const _at of (opts.impulseAts ?? [opts.impulseAt]).filter((at) => seq === at)) {
      movement.queueImpulse({ entityId: id, dirX: 0.8, dirY: 0.6, dirZ: 0, force: 600, stunFraction: 0.2 });
    }
    if (seq === opts.landAt) e.physics!.grounded = true;
    sim.tick();
    truth.push(read());
  }
  return truth;
}

function snapshotOf(truth: Truth[], at: number, replicateAge: boolean): ServerSnapshot {
  const t = truth[at];
  return {
    tick: at + 1, // published one past the movement tick; only ordering matters here
    ackedInputSeq: t.ack,
    position: { ...t.position },
    velocity: { ...t.velocity },
    grounded: t.grounded,
    ...(replicateAge ? { knockbackAgeTicks: t.age } : {}),
  };
}

const gap = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

interface Reconcile {
  step: number;
  ack: number;
  ackAge: number | null;
  position: number;
  velocity: number;
}

/**
 * The real client predicting the same idle commands, reconciling every `every`
 * steps against authority `lag` steps back. Error is read straight after each
 * reconcile, against authority at the step the client has predicted to.
 */
function predict(
  truth: Truth[],
  opts: { every: number; lag: number; replicateAge: boolean; dropAt?: number[] },
): Reconcile[] {
  const v2 = new V2NetworkClient({ tickRate: 125 });
  v2.bufferSnapshot(snapshotOf(truth, 0, opts.replicateAge));
  v2.processBufferedSnapshots();

  const out: Reconcile[] = [];
  for (let step = 1; step < truth.length; step++) {
    v2.processInput({ direction: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, buttons: 0, clientTick: step });
    const ack = step - opts.lag;
    if (step % opts.every !== 0 || ack < 1 || opts.dropAt?.includes(step)) continue;
    v2.bufferSnapshot(snapshotOf(truth, ack, opts.replicateAge));
    v2.processBufferedSnapshots();
    out.push({
      step,
      ack,
      ackAge: truth[ack].age,
      position: gap(v2.getPosition(), truth[step].position),
      velocity: gap(v2.getVelocity(), truth[step].velocity),
    });
  }
  // Every assertion is about the replay, so prove it was never skipped.
  expect(v2.getDebugInfo().resyncCount).toBe(0);
  return out;
}

/**
 * A reconcile the client can get right. One whose replay window contains the
 * impulse tick cannot: that snapshot predates the impulse, and the client does
 * not predict server impulses — the next snapshot carries it.
 */
const knowable = (at: number) => (r: Reconcile) => r.ack >= at || r.step < at;

describe("Knockback drag survives reconciliation", () => {
  // Past expiry, so a replay window crosses the end of the drag as well.
  const STEPS = IMPULSE_AT + WINDOW + 40;
  // every < lag, so windows overlap and the same steps are replayed repeatedly.
  const cadence = { every: 8, lag: 12 };

  it("matches the server after every reconcile, through the whole drag window", () => {
    const truth = authority(STEPS, { impulseAt: IMPULSE_AT });
    const runs = predict(truth, { ...cadence, replicateAge: true }).filter(knowable(IMPULSE_AT));

    // The windows must really cover drag and its expiry, or this proves nothing.
    expect(runs.some((r) => r.ackAge !== null && r.ackAge >= KB_DRAG_DELAY_TICKS)).toBe(true);
    expect(runs.some((r) => r.ackAge !== null && r.ackAge + cadence.lag > WINDOW)).toBe(true);
    for (const r of runs) {
      expect(r.position, `position at step ${r.step}, ack ${r.ack}`).toBe(0);
      expect(r.velocity, `velocity at step ${r.step}, ack ${r.ack}`).toBe(0);
    }
  });

  it("diverges without the replicated age, which is how live clients behaved before", () => {
    const truth = authority(STEPS, { impulseAt: IMPULSE_AT });
    const runs = predict(truth, { ...cadence, replicateAge: false }).filter(knowable(IMPULSE_AT));
    expect(Math.max(...runs.map((r) => r.velocity))).toBeGreaterThan(1);
  });

  it("restarts drag for successive and simultaneous impulses without doubling their velocity", () => {
    const impulses = [20, 85, 85, 110];
    const truth = authority(280, { impulseAts: impulses });
    const runs = predict(truth, { ...cadence, replicateAge: true }).filter((r) =>
      impulses.every((at) => knowable(at)(r)),
    );
    expect(truth[85].age).toBe(0);
    expect(truth[110].age).toBe(0);
    expect(runs.some((r) => r.ack > 160 && r.ackAge !== null)).toBe(true);
    for (const r of runs) {
      expect(r.position, `position at step ${r.step}`).toBe(0);
      expect(r.velocity, `velocity at step ${r.step}`).toBe(0);
    }
  });

  it("recovers after losing the first impulse and cancellation snapshots", () => {
    const landAt = 90;
    const truth = authority(140, { impulseAt: IMPULSE_AT, landAt });
    const runs = predict(truth, { ...cadence, replicateAge: true, dropAt: [32, 104] }).filter(
      (r) => knowable(IMPULSE_AT)(r) && knowable(landAt)(r),
    );
    expect(runs.some((r) => r.ackAge !== null)).toBe(true);
    expect(runs.some((r) => r.ack >= landAt && r.ackAge === null)).toBe(true);
    for (const r of runs) {
      expect(r.position, `position at step ${r.step}`).toBe(0);
      expect(r.velocity, `velocity at step ${r.step}`).toBe(0);
    }
  });

  it("clears drag on reset so a new life does not inherit an old impulse", () => {
    const client = new V2NetworkClient({ tickRate: 125 });
    client.bufferSnapshot({
      tick: 100,
      ackedInputSeq: 0,
      position: { x: 0, y: 5000, z: 0 },
      velocity: { x: 300, y: 200, z: 0 },
      grounded: false,
      knockbackAgeTicks: 100,
    });
    client.processBufferedSnapshots();
    client.reset({ x: 0, y: 5000, z: 0 });
    const fresh = new V2NetworkClient({ tickRate: 125 });
    fresh.reset({ x: 0, y: 5000, z: 0 });
    const input = { direction: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, buttons: 0, clientTick: 1 };
    client.processInput(input);
    fresh.processInput(input);
    expect(client.getPosition()).toEqual(fresh.getPosition());
    expect(client.getVelocity()).toEqual(fresh.getVelocity());
  });

  it("does not preserve cosmetic grounding over a small authoritative launch", () => {
    const client = new V2NetworkClient({ tickRate: 125 });
    const seed = {
      tick: 1,
      ackedInputSeq: 0,
      position: { x: 0, y: 5000, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      grounded: true,
      knockbackAgeTicks: null,
    };
    client.bufferSnapshot(seed);
    client.processBufferedSnapshots();
    expect(client.getState().grounded).toBe(true);
    client.bufferSnapshot({
      ...seed,
      tick: 2,
      position: { x: 0.2, y: 5000.2, z: 0 },
      velocity: { x: 25, y: 25, z: 0 },
      grounded: false,
      knockbackAgeTicks: 0,
    });
    client.processBufferedSnapshots();
    expect(client.getState().grounded).toBe(false);
    expect(client.getVelocity()).toEqual({ x: 25, y: 25, z: 0 });
    // A later authoritative landing cancels that impulse; subsequent jumping
    // must not revive its drag or preserve the old airborne cosmetic flag.
    client.bufferSnapshot({ ...seed, tick: 3 });
    client.processBufferedSnapshots();
    expect(client.getState().grounded).toBe(true);
  });

  it("adopts a cancellation it could not have predicted", () => {
    // The landing is forced onto the server entity, so the client's own replay
    // never sees ground. Once a snapshot reports the drag gone, it must stop too.
    const LAND = IMPULSE_AT + 70;
    const truth = authority(LAND + 40, { impulseAt: IMPULSE_AT, landAt: LAND });
    const runs = predict(truth, { ...cadence, replicateAge: true }).filter(
      (r) => knowable(IMPULSE_AT)(r) && knowable(LAND)(r),
    );
    expect(runs.some((r) => r.ack >= LAND)).toBe(true);
    for (const r of runs) {
      expect(r.position, `position at step ${r.step}, ack ${r.ack}`).toBe(0);
      expect(r.velocity, `velocity at step ${r.step}, ack ${r.ack}`).toBe(0);
    }
  });

  it("reconciling the same authoritative state twice lands in the same place", () => {
    const ACK = IMPULSE_AT + 70; // deep in the ramp
    const AHEAD = 20; // inside the 32-command replay budget
    const truth = authority(ACK + AHEAD, { impulseAt: IMPULSE_AT });
    const v2 = new V2NetworkClient({ tickRate: 125 });
    v2.bufferSnapshot(snapshotOf(truth, 0, true));
    v2.processBufferedSnapshots();
    for (let step = 1; step <= ACK + AHEAD; step++) {
      v2.processInput({ direction: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, buttons: 0, clientTick: step });
    }

    const snap = snapshotOf(truth, ACK, true);
    v2.bufferSnapshot(snap);
    v2.processBufferedSnapshots();
    const first = { ...v2.getPosition() };
    v2.bufferSnapshot({ ...snap, tick: snap.tick + 1 });
    v2.processBufferedSnapshots();

    expect(v2.getPosition()).toEqual(first);
    expect(gap(first, truth[ACK + AHEAD].position)).toBe(0);
    expect(v2.getDebugInfo().resyncCount).toBe(0);
  });
});

describe("Server knockback age", () => {
  it("is 0 on the impulse's tick, rises by one per tick, and ends after the window", () => {
    const truth = authority(IMPULSE_AT + WINDOW + 5, { impulseAt: IMPULSE_AT });
    expect(truth[IMPULSE_AT - 1].age).toBeNull();
    for (let age = 0; age <= WINDOW; age++) expect(truth[IMPULSE_AT + age].age).toBe(age);
    expect(truth[IMPULSE_AT + WINDOW + 1].age).toBeNull();
  });

  it("ends on a landing and does not return when the body leaves the ground", () => {
    const LAND = IMPULSE_AT + 60;
    const truth = authority(LAND + 20, { impulseAt: IMPULSE_AT, landAt: LAND });
    expect(truth[LAND - 1].age).toBe(LAND - 1 - IMPULSE_AT);
    expect(truth[LAND].grounded).toBe(false); // free fall lifts it straight off again
    for (let s = LAND; s <= LAND + 20; s++) expect(truth[s].age).toBeNull();
  });
});

describe("knockback_state is private to its owner", () => {
  function broadcastTo(pvs: boolean) {
    const packets = new Map<string, Uint8Array[]>();
    const simulation = {
      getState: () => ({
        getEntity: () => ({ transform: { position: { x: 0, y: 0, z: 0 } }, input: { lastProcessedSeq: 0 } }),
      }),
    } as unknown as Simulation;
    const broadcaster = new SnapshotBroadcaster(simulation);
    if (pvs) broadcaster.setPVS({ enabled: true, isVisible: () => true } as unknown as ServerPVS);

    const client = (n: number): ClientInfo => {
      packets.set(`c${n}`, []);
      return {
        id: `c${n}`,
        playerId: n,
        entityId: n,
        lastInputSeq: 0,
        lastAckedTick: 0,
        connection: { sendDatagram: (bytes: Uint8Array) => packets.get(`c${n}`)!.push(bytes) },
      } as unknown as ClientInfo;
    };
    const clients = new Map([
      ["c1", client(1)],
      ["c2", client(2)],
    ]);

    const state = new GameState();
    state.tick = 1;
    state.events = [
      { type: "knockback_state", entityId: toClientKey(entityId(1)), ageTicks: 12 },
      { type: "knockback_state", entityId: toClientKey(entityId(2)), ageTicks: null },
    ] as GameState["events"];
    broadcaster.broadcast(clients, state);

    const kb = (id: string) =>
      MessageCodec.decodeSnapshot(packets.get(id)![0]).events.filter((e) => e.type === "knockback_state");
    return { c1: kb("c1"), c2: kb("c2"), shared: state.events.length };
  }

  it.each([false, true])("each client receives only its own (PVS=%s)", (pvs) => {
    const { c1, c2, shared } = broadcastTo(pvs);
    expect(c1).toEqual([{ type: "knockback_state", entityId: toClientKey(entityId(1)), ageTicks: 12 }]);
    expect(c2).toEqual([{ type: "knockback_state", entityId: toClientKey(entityId(2)), ageTicks: null }]);
    // Filtering happens per client; the shared snapshot is left intact.
    expect(shared).toBe(2);
  });
});
