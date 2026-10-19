/**
 * Server-authoritative movement: one step per command, bounded by real time.
 *
 * Each command a client predicted is one movement step, so prediction and the
 * server take the same steps. A tick normally runs one; a starved player waits
 * and owes the tick, and owed ticks are repaid later by a second step a tick.
 * Guards against the input-rate exploits: no client (bot or human, slow, laggy
 * or malicious) can bank extra steps by sending more commands, or hang slowed
 * or frozen — "half gravity / moon jump" — for longer than the pause limit by
 * sending fewer.
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

/** Starved ticks a player waits before the server guesses for it (500 ms at 125 Hz). */
const MAX_PAUSE_TICKS = 62.5;
/** The input buffer holds two seconds of commands. */
const INPUT_BUFFER = 250;

// Always read the CURRENT tick's entity (sim swaps state each tick).
const cur = (sim: Simulation, id: EntityId) => sim.getStateMut().getEntity(id)!;
const vy = (sim: Simulation, id: EntityId) => cur(sim, id).physics!.velocity.y;
const buttons = (sim: Simulation, id: EntityId) => cur(sim, id).input!.buttons;

describe("Server-authoritative fixed-rate physics", () => {
  it("waits for a silent player, then lets gravity act once the pause runs out", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    const before = vy(sim, id);
    for (let i = 0; i < 10; i++) sim.tick();
    // Waiting for commands: no step yet, so no fall.
    expect(vy(sim, id)).toBe(before);
    for (let i = 0; i < MAX_PAUSE_TICKS + 10; i++) sim.tick();
    // Nobody hangs in the air for good by staying silent.
    expect(vy(sim, id)).toBeLessThan(before - 50);
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

  it("caps the input buffer at two seconds of commands", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(sim, id, ...Array.from({ length: INPUT_BUFFER + 50 }, (_, i) => cmd(i + 1)));
    sim.tick();
    // Buffer is capped (extras dropped), not hoarded.
    expect(cur(sim, id).input!.inputQueue.length).toBeLessThanOrEqual(INPUT_BUFFER);
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

    // Waiting for the next command: no step, buttons held through the grace.
    const waitingVy = vy(sim, id);
    for (let i = 0; i < 3; i++) sim.tick();
    expect(buttons(sim, id) & InputButtons.FIRE).not.toBe(0);
    expect(buttons(sim, id) & InputButtons.JUMP).not.toBe(0);
    expect(cur(sim, id).input!.forward).toBe(1);
    expect(cur(sim, id).input!.yaw).toBe(0.5);
    expect(vy(sim, id)).toBe(waitingVy);

    sim.tick();
    expect(buttons(sim, id) & InputButtons.FIRE).toBe(0);
    expect(buttons(sim, id) & InputButtons.JUMP).toBe(0);
    expect(buttons(sim, id) & InputButtons.FORWARD).not.toBe(0);
    expect(cur(sim, id).input!.forward).toBe(1);
    expect(cur(sim, id).input!.yaw).toBe(0.5);
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
    const id = spawnAirborne(sim, 1);

    for (let i = 0; i < 5; i++) {
      queueCmds(sim, id, cmd(i + 1, { forward: 1 }));
      sim.tick();
    }

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

    queueCmds(sim, id, cmd(1));
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
 * The effect clock counts movement steps, as client prediction does: a waiting
 * tick takes none, a catch-up tick takes two, a guess takes one. A command
 * sequence does not count steps — a guess reuses one, a flood skips them — so
 * deriving effect time from it froze or jumped the walljump window, slide,
 * ladder detach cooldown and water jump relative to the gravity acting on the
 * same body.
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

  it("counts movement steps: none while waiting, two in a catch-up tick", () => {
    const { sim, movement, id } = airborneWithMovement();
    queueCmds(sim, id, cmd(1));
    sim.tick();
    const clockAfterFirst = effectClockMs(movement, 1);
    for (let i = 0; i < 20; i++) sim.tick(); // waiting: 20 ticks owed
    expect(effectClockMs(movement, 1)).toBe(clockAfterFirst);

    queueCmds(sim, id, ...Array.from({ length: 30 }, (_, i) => cmd(i + 2)));
    sim.tick(); // a backlog this deep runs two commands
    expect(effectClockMs(movement, 1) - clockAfterFirst).toBe(2 * DT_MS);
    expect(cur(sim, id).input!.sequence).toBe(3);
  });

  it("keeps advancing while a silent client is guessed for", () => {
    const { sim, movement, id } = airborneWithMovement();
    queueCmds(sim, id, cmd(1));
    sim.tick();
    for (let i = 0; i < Math.ceil(MAX_PAUSE_TICKS); i++) sim.tick(); // the pause runs out
    const clockBefore = effectClockMs(movement, 1);
    const yBefore = cur(sim, id).transform!.position.y;
    for (let i = 0; i < 10; i++) sim.tick(); // ten guesses
    expect(cur(sim, id).transform!.position.y).toBeLessThan(yBefore);
    expect(effectClockMs(movement, 1) - clockBefore).toBe(10 * DT_MS);
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
    queueCmds(sim, id, ...Array.from({ length: 18 }, (_, i) => cmd(i + 1)));

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
  /** A burst six commands deeper than the buffer, so the six oldest are compacted. */
  const OVER = INPUT_BUFFER + 6;

  it("keeps a weapon switch that rode a command the cap discarded", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    const before = slot(sim, id);
    // One huge burst at once, the switch only on the first.
    queueCmds(sim, id, cmd(1, { weaponSlot: 3 }), ...Array.from({ length: OVER - 1 }, (_, i) => cmd(i + 2)));

    sim.tick();
    expect(slot(sim, id)).toBe(3);
    expect(slot(sim, id)).not.toBe(before);
  });

  it("still consumes exactly one command per tick, so nothing banks physics", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(sim, id, cmd(1, { weaponSlot: 3 }), ...Array.from({ length: OVER - 1 }, (_, i) => cmd(i + 2)));

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
      ...Array.from({ length: 16 }, (_, i) => cmd(i + 2)),
      cmd(18, { weaponSlot: 5 }),
      ...Array.from({ length: OVER - 18 }, (_, i) => cmd(i + 19)),
    );
    // seq 7 survives the cap and carries the 3; seq 18 asks for 5 afterwards.
    for (let i = 0; i < 12; i++) sim.tick();
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
      ...Array.from({ length: OVER - 2 }, (_, i) => cmd(i + 3)),
    );
    sim.tick();
    expect(slot(sim, id)).toBe(4);
  });

  it("invents no switch when the burst asked for none", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    const before = slot(sim, id);
    queueCmds(sim, id, ...Array.from({ length: OVER }, (_, i) => cmd(i + 1)));
    for (let i = 0; i < 6; i++) sim.tick();
    expect(slot(sim, id)).toBe(before);
  });
});

/**
 * A stalled link: a starved player waits, owing each tick, and a backlog
 * repays the debt two steps a tick, so the stall's commands all run and the
 * client's prediction stands. Past the pause limit the server guesses instead,
 * each guess standing in for the client's next command and advancing the ACK;
 * that command is dropped when it arrives, so a stall never replays on top of
 * its own guesses.
 */
describe("Waiting, catching up and guessing", () => {
  const ack = (sim: Simulation, id: EntityId) => cur(sim, id).input!.lastProcessedSeq;
  const queued = (sim: Simulation, id: EntityId) => cur(sim, id).input!.inputQueue.length;
  const PAUSE = Math.ceil(MAX_PAUSE_TICKS);

  it("waits for a starved client instead of guessing", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(sim, id, cmd(1));
    sim.tick();
    const y = cur(sim, id).transform!.position.y;
    const acks: number[] = [];
    for (let i = 0; i < 5; i++) {
      sim.tick();
      acks.push(ack(sim, id));
    }
    expect(acks).toEqual([1, 1, 1, 1, 1]);
    expect(cur(sim, id).transform!.position.y).toBe(y);
  });

  it("runs every stalled command once they arrive, two a tick while a backlog lasts", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(sim, id, cmd(1));
    sim.tick();
    for (let i = 0; i < 20; i++) sim.tick(); // 20 ticks owed
    queueCmds(sim, id, ...Array.from({ length: 30 }, (_, i) => cmd(i + 2)));
    const acks: number[] = [];
    for (let i = 0; i < 5; i++) {
      sim.tick();
      acks.push(ack(sim, id));
    }
    expect(acks).toEqual([3, 5, 7, 9, 11]);
  });

  it("repays only ticks it owes: a flood gains no steps", () => {
    const movement = new FPSMovementSubsystem();
    const flooded = new Simulation({ tickMs: 8 });
    flooded.addSubsystem(movement);
    flooded.initialize();
    const id = spawnAirborne(flooded, 1);
    queueCmds(flooded, id, cmd(1));
    flooded.tick();
    const before = effectClockMs(movement, 1);
    let seq = 2;
    for (let i = 0; i < 100; i++) {
      queueCmds(flooded, id, ...Array.from({ length: 4 }, () => cmd(seq++)));
      flooded.tick();
    }
    expect(effectClockMs(movement, 1) - before).toBe(100 * 8);
  });

  it("never takes more steps than ticks, a stall and its backlog included", () => {
    const s = new Simulation({ tickMs: 8 });
    const movement = new FPSMovementSubsystem();
    s.addSubsystem(movement);
    s.initialize();
    const id = spawnAirborne(s, 1);
    queueCmds(s, id, cmd(1));
    s.tick();
    const before = effectClockMs(movement, 1);
    for (let i = 0; i < 30; i++) s.tick(); // stalled
    let seq = 2;
    for (let i = 0; i < 100; i++) {
      queueCmds(s, id, ...Array.from({ length: i === 0 ? 30 : 3 }, () => cmd(seq++)));
      s.tick();
    }
    expect((effectClockMs(movement, 1) - before) / 8).toBeLessThanOrEqual(130);
  });

  it("guesses once the pause runs out, one command per tick", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(sim, id, cmd(1));
    sim.tick();
    for (let i = 0; i < PAUSE; i++) sim.tick();
    expect(ack(sim, id)).toBe(1);
    const acks: number[] = [];
    for (let i = 0; i < 4; i++) {
      sim.tick();
      acks.push(ack(sim, id));
    }
    expect(acks).toEqual([2, 3, 4, 5]);
  });

  it("drops the stalled commands its guesses already stood in for", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(sim, id, cmd(1));
    sim.tick();
    for (let i = 0; i < PAUSE + 3; i++) sim.tick(); // guesses stood in for 2, 3 and 4
    queueCmds(sim, id, ...Array.from({ length: 9 }, (_, i) => cmd(i + 2)));
    sim.tick();
    expect(cur(sim, id).input!.sequence).toBe(5);
    expect(ack(sim, id)).toBe(5);
    expect(queued(sim, id)).toBe(5);
  });

  it("takes aim and weapon requests from a late command, not the stale one", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(sim, id, cmd(1, { yaw: 0.1 }));
    sim.tick();
    for (let i = 0; i < PAUSE + 1; i++) sim.tick(); // a guess stood in for 2
    queueCmds(sim, id, cmd(2, { yaw: 0.7, weaponSlot: 4 }));
    sim.tick();
    expect(cur(sim, id).input!.yaw).toBe(0.7);
    expect(cur(sim, id).input!.weaponSlot).toBe(4);
  });

  it("stops guessing ahead of a client that lost frame time, so its commands run again", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(sim, id, cmd(1));
    sim.tick();
    for (let i = 0; i < PAUSE + 10; i++) sim.tick(); // guesses stood in for 2..11
    // The client resumes one command per tick from 2: it never sent the time it lost.
    const ran: number[] = [];
    for (let seq = 2; seq < 40; seq++) {
      queueCmds(sim, id, cmd(seq));
      sim.tick();
      ran.push(cur(sim, id).input!.sequence);
    }
    // Late commands are dropped until the client catches up, then each runs on its own tick.
    expect(ran.slice(-5)).toEqual([35, 36, 37, 38, 39]);
    expect(ack(sim, id)).toBe(39);
  });

  it("starts over when a resumed connection numbers its commands from 1", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    queueCmds(sim, id, cmd(500));
    sim.tick();
    for (let i = 0; i < 8; i++) sim.tick();
    queueCmds(sim, id, cmd(1, { yaw: 0.3 }));
    sim.tick();
    expect(cur(sim, id).input!.sequence).toBe(1);
    expect(ack(sim, id)).toBe(1);
  });

  it("gives up one command when the queue stayed deep for a whole second with nothing owed", () => {
    const sim = makeSim();
    const id = spawnAirborne(sim, 1);
    let seq = 1;
    queueCmds(sim, id, cmd(seq++), cmd(seq++), cmd(seq++), cmd(seq++));
    let depthAfter = 0;
    for (let i = 0; i < 125; i++) {
      queueCmds(sim, id, cmd(seq++));
      sim.tick();
      depthAfter = queued(sim, id);
    }
    // Steady input kept four waiting; the drain removed one in the window's last tick.
    expect(depthAfter).toBe(3);
  });

  it("catches one command up instead when the deep queue is owed ticks", () => {
    const s = new Simulation({ tickMs: 8 });
    const movement = new FPSMovementSubsystem();
    s.addSubsystem(movement);
    s.initialize();
    const id = spawnAirborne(s, 1);
    queueCmds(s, id, cmd(1));
    s.tick();
    const before = effectClockMs(movement, 1);
    for (let i = 0; i < 3; i++) s.tick(); // three ticks owed
    let seq = 2;
    queueCmds(s, id, cmd(seq++), cmd(seq++), cmd(seq++), cmd(seq++));
    // Two windows: the first still saw the empty queue of the stall.
    for (let i = 0; i < 250; i++) {
      queueCmds(s, id, cmd(seq++));
      s.tick();
    }
    // The drain repaid a tick: the queue is one shallower, and every command up
    // to the ACK took its own movement step — none was given up.
    expect(queued(s, id)).toBe(3);
    expect((effectClockMs(movement, 1) - before) / 8).toBe(ack(s, id) - 1);
  });

  it("never runs more than one step a tick when nothing is owed, whatever arrives", () => {
    const { sim, movement, id } = (() => {
      const s = new Simulation({ tickMs: 8 });
      const m = new FPSMovementSubsystem();
      s.addSubsystem(m);
      s.initialize();
      return { sim: s, movement: m, id: spawnAirborne(s, 1) };
    })();
    queueCmds(sim, id, cmd(1));
    sim.tick();
    const before = effectClockMs(movement, 1);
    let seq = 2;
    for (let i = 0; i < 60; i++) {
      if (i % 7 === 0) queueCmds(sim, id, ...Array.from({ length: 9 }, () => cmd(seq++)));
      sim.tick();
    }
    expect(effectClockMs(movement, 1) - before).toBe(60 * 8);
  });
});
