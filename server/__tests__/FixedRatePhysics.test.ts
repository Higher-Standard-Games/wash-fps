/**
 * Server-authoritative fixed-rate physics.
 *
 * Physics must advance exactly one dt per SERVER tick, independent of how many
 * input commands a client sends. Guards against the input-rate exploit where a
 * client (bot or human, slow/laggy/malicious) could slow, skip, or bank its own
 * physics — e.g. "half gravity / moon jump" — by sending fewer/more commands.
 */

import { describe, expect, it, vi } from "vitest";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import { Simulation } from "../../../../engine/server/core/Simulation";
import { createPlayerEntity } from "../../../../engine/server/ecs/Entity";
import { type EntityId, entityId, playerId } from "../../../../engine/server/ecs/types";
import type { QueuedInput } from "../../../../shared/server/simulation/components/InputComponent";
import { FPSMovementSubsystem } from "../systems/FPSMovementSubsystem";
import { WeaponSystem } from "../systems/WeaponSystem";

function cmd(seq: number, overrides: Partial<QueuedInput> = {}): QueuedInput {
  return { forward: 0, right: 0, pitch: 0, yaw: 0, buttons: 0, sequence: seq, weaponSlot: 0, ...overrides };
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

// The movement profile's effect clock — the one walljump/slide/ladder/water-jump
// deadlines are set and compared against.
const effectClockMs = (movement: FPSMovementSubsystem, id: number) =>
  (movement as unknown as { movementProfiles: Map<number, { simNowMs: number }> }).movementProfiles.get(id)!.simNowMs;

// Always read the CURRENT tick's entity (sim swaps state each tick).
const cur = (sim: Simulation, id: EntityId) => sim.getStateMut().getEntity(id)!;
const vy = (sim: Simulation, id: EntityId) => cur(sim, id).physics!.velocity.y;
const buttons = (sim: Simulation, id: EntityId) => cur(sim, id).input!.buttons;

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

  it("keeps stale action buttons only through the starvation grace window", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(
      sim,
      id,
      cmd(1, {
        forward: 1,
        yaw: 0.5,
        buttons: InputButtons.FIRE | InputButtons.JUMP | InputButtons.FORWARD,
      }),
    );

    sim.tick();
    expect(buttons(sim, id) & InputButtons.FIRE).not.toBe(0);
    expect(buttons(sim, id) & InputButtons.JUMP).not.toBe(0);

    for (let i = 0; i < 3; i++) sim.tick();
    expect(buttons(sim, id) & InputButtons.FIRE).not.toBe(0);
    expect(buttons(sim, id) & InputButtons.JUMP).not.toBe(0);
    expect(cur(sim, id).input!.forward).toBe(1);
    expect(cur(sim, id).input!.yaw).toBe(0.5);

    const beforeStripVy = vy(sim, id);
    sim.tick();
    expect(buttons(sim, id) & InputButtons.FIRE).toBe(0);
    expect(buttons(sim, id) & InputButtons.JUMP).toBe(0);
    expect(buttons(sim, id) & InputButtons.FORWARD).not.toBe(0);
    expect(cur(sim, id).input!.forward).toBe(1);
    expect(cur(sim, id).input!.yaw).toBe(0.5);
    expect(vy(sim, id)).toBeLessThan(beforeStripVy);
  });

  it("does not keep firing from one stale FIRE command after the grace window", () => {
    const weaponSystem = new WeaponSystem();
    const sim = new Simulation({ tickMs: 8 });
    sim.addSubsystem(new FPSMovementSubsystem());
    sim.addSubsystem(weaponSystem);
    sim.initialize();

    const id = spawnAirborne(sim, 1);
    weaponSystem.initializeWeaponFromLoadout(
      1 as never,
      {
        weapons: ["machinegun"],
        ammo: { machinegun: 160 },
        health: 100,
        armor: 0,
      } as never,
    );
    weaponSystem.getWeaponState(1 as never)!.lastFireTick = -100;

    queueCmds(sim, id, cmd(1, { buttons: InputButtons.FIRE, forward: 0, right: 0 }));
    sim.tick();
    expect(weaponSystem.getPendingFireEvents()).toHaveLength(1);

    for (let i = 0; i < 20; i++) sim.tick();
    expect(weaponSystem.getPendingFireEvents()).toHaveLength(0);
  });

  it("does not log authority tripwire warnings for normal movement", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sim = makeSim();
    spawnAirborne(sim, 1);

    for (let i = 0; i < 5; i++) sim.tick();

    const authorityWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes("[Authority]"));
    expect(authorityWarnings).toHaveLength(0);
    warn.mockRestore();
  });

  it("logs authority tripwire warnings for impossible single-tick deltas", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const movement = new FPSMovementSubsystem();
    const sim = new Simulation({ tickMs: 8 });
    sim.addSubsystem(movement);
    sim.initialize();
    const id = spawnAirborne(sim, 1);

    // biome-ignore lint/suspicious/noExplicitAny: inject a test profile to force an impossible delta
    (movement as any).movementProfiles.set(id as unknown as number, {
      speedBonus: 0,
      simulate: (position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }) => ({
        position: { x: position.x + 5000, y: position.y, z: position.z },
        velocity: { ...velocity },
        grounded: false,
        isSliding: false,
        isCrouching: false,
        wallJumpState: "none",
        ledgeGrabState: "none",
        actualHorizSpeed: 0,
      }),
    });

    sim.tick();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[Authority] entity 1 moved 5000u in one tick"));
    // WO-AC2: the tripwire also bumps a per-entity counter for anti-cheat telemetry.
    expect(movement.getTripwireHits(id as unknown as number)).toBeGreaterThan(0);
    warn.mockRestore();
  });
});

/**
 * N04: gravity and the movement effect clock have to describe the same time.
 *
 * Physics advances exactly one dt per server tick. A command sequence does not:
 * the server repeats the last command when a client starves it and drops old
 * commands when one floods it. Deriving effect time from the sequence therefore
 * froze or jumped the walljump window, slide, ladder detach cooldown and water
 * jump relative to the gravity acting on the same body.
 */
describe("Server effect clock tracks simulated time, not command identity", () => {
  const DT_MS = 8;

  function airborneWithMovement(): { sim: Simulation; movement: FPSMovementSubsystem; id: EntityId } {
    const sim = new Simulation({ tickMs: DT_MS });
    const movement = new FPSMovementSubsystem(); // no collision world → free fall
    sim.addSubsystem(movement);
    sim.initialize();
    return { sim, movement, id: spawnAirborne(sim, 1) };
  }

  it("keeps advancing while a starved client's last command is repeated", () => {
    const { sim, movement, id } = airborneWithMovement();
    queueCmds(sim, id, cmd(1));

    const TICKS = 20;
    const yBefore = cur(sim, id).transform!.position.y;
    sim.tick();
    const clockAfterFirst = effectClockMs(movement, 1);
    for (let i = 1; i < TICKS; i++) sim.tick(); // 19 starved ticks, seq stays 1

    // Physics advanced for all 20 ticks...
    expect(cur(sim, id).transform!.position.y).toBeLessThan(yBefore);
    // ...so the effect clock must have advanced for all 20 too. It used to stop
    // at the repeated command's sequence while the body kept falling.
    expect(effectClockMs(movement, 1) - clockAfterFirst).toBe((TICKS - 1) * DT_MS);
    expect(cur(sim, id).input!.sequence).toBe(1); // the ACK is deliberately unchanged
  });

  it("does not jump ahead when the client's sequence skips", () => {
    const { sim, movement, id } = airborneWithMovement();
    queueCmds(sim, id, cmd(1));
    sim.tick();
    const before = effectClockMs(movement, 1);

    // A long gap in sequence numbers is one more simulated step, nothing more.
    queueCmds(sim, id, cmd(500));
    sim.tick();
    expect(effectClockMs(movement, 1) - before).toBe(DT_MS);
    expect(cur(sim, id).input!.sequence).toBe(500);
  });

  it("advances exactly one dt per tick across a burst the queue has to compact", () => {
    const { sim, movement, id } = airborneWithMovement();
    queueCmds(sim, id, ...Array.from({ length: 12 }, (_, i) => cmd(i + 1)));

    sim.tick();
    const before = effectClockMs(movement, 1);
    const TICKS = 6;
    for (let i = 0; i < TICKS; i++) sim.tick();
    expect(effectClockMs(movement, 1) - before).toBe(TICKS * DT_MS);
  });
});

/**
 * N10: a frame hitch makes the client emit a burst of commands, and a one-shot
 * request like a weapon switch rides only the first of them. Capping the input
 * queue — which is what stops a flooding client banking physics — then threw
 * that request away before anything could act on it.
 */
describe("Queue compaction drops physics, not intent", () => {
  const slot = (sim: Simulation, id: EntityId) => cur(sim, id).input!.weaponSlot;

  it("keeps a weapon switch that rode a command the cap discarded", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    const before = slot(sim, id);
    // One hitch: twelve commands at once, the switch only on the first.
    queueCmds(sim, id, cmd(1, { weaponSlot: 3 }), ...Array.from({ length: 11 }, (_, i) => cmd(i + 2)));

    sim.tick();
    expect(slot(sim, id)).toBe(3);
    expect(slot(sim, id)).not.toBe(before);
  });

  it("still consumes exactly one command per tick, so nothing banks physics", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(sim, id, cmd(1, { weaponSlot: 3 }), ...Array.from({ length: 11 }, (_, i) => cmd(i + 2)));

    const processed: number[] = [];
    for (let i = 0; i < 6; i++) {
      sim.tick();
      processed.push(cur(sim, id).input!.sequence);
    }
    // The six oldest are still dropped — only the request survived them.
    expect(processed).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it("lets a newer request win over one carried out of the dropped commands", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(
      sim,
      id,
      cmd(1, { weaponSlot: 3 }),
      ...Array.from({ length: 10 }, (_, i) => cmd(i + 2)),
      cmd(12, { weaponSlot: 5 }),
    );
    // seq 7 survives the cap and carries the 3; seq 12 asks for 5 afterwards.
    for (let i = 0; i < 6; i++) sim.tick();
    expect(slot(sim, id)).toBe(5);
  });

  it("carries the last request when the burst contains several", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(
      sim,
      id,
      cmd(1, { weaponSlot: 3 }),
      cmd(2, { weaponSlot: 4 }),
      ...Array.from({ length: 10 }, (_, i) => cmd(i + 3)),
    );
    sim.tick();
    expect(slot(sim, id)).toBe(4);
  });

  it("invents no switch when the burst asked for none", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    const before = slot(sim, id);
    queueCmds(sim, id, ...Array.from({ length: 12 }, (_, i) => cmd(i + 1)));
    for (let i = 0; i < 6; i++) sim.tick();
    expect(slot(sim, id)).toBe(before);
  });
});
