/**
 * Server-authoritative fixed-rate physics.
 *
 * Physics must advance exactly one dt per SERVER tick, independent of how many
 * input commands a client sends. Guards against the input-rate exploit where a
 * client (bot or human, slow/laggy/malicious) could slow, skip, or bank its own
 * physics — e.g. "half gravity / moon jump" — by sending fewer/more commands.
 */

import { describe, expect, it } from "vitest";
import { Simulation } from "../../../../engine/server/core/Simulation";
import { createPlayerEntity } from "../../../../engine/server/ecs/Entity";
import { type EntityId, entityId, playerId } from "../../../../engine/server/ecs/types";
import type { QueuedInput } from "../../../../shared/server/simulation/components/InputComponent";
import { FPSMovementSubsystem } from "../systems/FPSMovementSubsystem";

function cmd(seq: number): QueuedInput {
  return { forward: 0, right: 0, pitch: 0, yaw: 0, buttons: 0, sequence: seq, weaponSlot: 0 };
}

function makeSim() {
  const sim = new Simulation({ tickMs: 8 });
  sim.addSubsystem(new FPSMovementSubsystem()); // no collision world → free fall
  sim.initialize();
  return sim;
}

/** Spawn an airborne player; returns its entity id. */
function spawnAirborne(sim: Simulation, id: number, y = 5000): EntityId {
  const eid = entityId(id);
  const state = sim.getStateMut();
  state.addEntity(createPlayerEntity(eid, playerId(id), { x: 0, y, z: 0 }));
  const mut = state.getEntityMut(eid);
  if (mut?.physics) {
    mut.physics.grounded = false;
    mut.physics.velocity.y = 0;
  }
  return eid;
}

/** Push commands into an entity's input queue for the NEXT tick. */
function queueCmds(sim: Simulation, id: EntityId, ...cmds: QueuedInput[]) {
  const inp = sim.getStateMut().getEntityMut(id)?.input;
  if (inp) inp.inputQueue.push(...cmds);
}

// Always read the CURRENT tick's entity (sim swaps state each tick).
const cur = (sim: Simulation, id: EntityId) => sim.getStateMut().getEntity(id)!;
const vy = (sim: Simulation, id: EntityId) => cur(sim, id).physics!.velocity.y;

describe("Server-authoritative fixed-rate physics", () => {
  it("applies gravity every tick even with NO input commands (no skip)", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    const before = vy(sim, id);
    for (let i = 0; i < 10; i++) sim.tick();
    // Before the fix, an empty queue skipped physics → vy unchanged.
    expect(vy(sim, id)).toBeLessThan(before - 50); // fell under gravity
  });

  it("advances the SAME amount whether 1 or many commands arrive in a tick", () => {
    const sim = makeSim();
    const a = spawnAirborne(sim, 1);
    const b = spawnAirborne(sim, 2);
    queueCmds(sim, a, cmd(1));
    queueCmds(sim, b, cmd(1), cmd(2), cmd(3), cmd(4), cmd(5));

    sim.tick();

    // Both advanced exactly one dt of gravity — command count doesn't multiply it.
    expect(vy(sim, a)).toBeCloseTo(vy(sim, b), 5);
    // B's extra commands are buffered, not simulated this tick.
    expect(cur(sim, b).input!.inputQueue.length).toBeGreaterThan(0);
  });

  it("caps the input buffer so a flooding client can't bank physics", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(sim, id, ...Array.from({ length: 100 }, (_, i) => cmd(i + 1)));
    sim.tick();
    // Buffer is capped (extras dropped), not hoarded.
    expect(cur(sim, id).input!.inputQueue.length).toBeLessThanOrEqual(6);
  });

  it("acks the last SIMULATED command sequence, not the last received", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(sim, id, cmd(10), cmd(11), cmd(12));
    sim.tick();
    expect(cur(sim, id).input!.lastProcessedSeq).toBe(10); // consumed exactly one
    sim.tick();
    expect(cur(sim, id).input!.lastProcessedSeq).toBe(11);
  });
});
