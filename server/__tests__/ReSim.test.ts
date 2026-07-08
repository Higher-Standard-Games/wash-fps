import type { QueuedInput } from "@shared/server/simulation/components/InputComponent";
import { describe, expect, it } from "vitest";
import { DEFAULT_VIEWHEIGHT } from "../../../../engine/physics/PlayerPhysicsConstants";
import { type RecordedCmd, type ReSimSpawn, resimulate, resimulateFull, verifyAgainst } from "../ReSim";

const FIRE_BUTTON = 1 << 8;

const spawns: ReSimSpawn[] = [{ entityId: 1, playerId: 1, x: 0, y: 500, z: 0 }];

function cmd(seq: number, o: Partial<QueuedInput> = {}): QueuedInput {
  return { forward: 0, right: 0, pitch: 0, yaw: 0, buttons: 0, sequence: seq, weaponSlot: 0, ...o };
}

/** A scripted 60-tick input log: move forward, strafe, look around. */
function makeLog(): RecordedCmd[] {
  const log: RecordedCmd[] = [];
  for (let t = 0; t < 60; t++) {
    log.push({
      tick: t,
      entityId: 1,
      cmd: cmd(t + 1, { forward: 1, right: t % 2 === 0 ? 1 : -1, yaw: t * 0.05 }),
    });
  }
  return log;
}

describe("ReSim — deterministic demo re-simulation (WO-AC4)", () => {
  it("is deterministic: two re-sims of the same log produce identical checksums", () => {
    const log = makeLog();
    const a = resimulate(spawns, log, 60);
    const b = resimulate(spawns, log, 60);
    expect(a.perTickChecksum).toEqual(b.perTickChecksum);
    expect(a.finalChecksum).toBe(b.finalChecksum);
  });

  it("reconciles a clean log against its own golden checksums", () => {
    const log = makeLog();
    const golden = resimulate(spawns, log, 60).perTickChecksum;
    const v = verifyAgainst(spawns, log, golden);
    expect(v.ok).toBe(true);
    expect(v.divergedAtTick).toBeNull();
  });

  it("detects a tampered input log (tamper-evidence)", () => {
    const golden = resimulate(spawns, makeLog(), 60).perTickChecksum;

    // Tamper: flip one command's strafe at tick 30.
    const tampered = makeLog();
    tampered[30] = { ...tampered[30], cmd: { ...tampered[30].cmd, right: 0 } };

    const v = verifyAgainst(spawns, tampered, golden);
    expect(v.ok).toBe(false);
    // Divergence appears at or shortly after the tampered tick.
    expect(v.divergedAtTick).not.toBeNull();
    expect(v.divergedAtTick!).toBeGreaterThanOrEqual(30);
  });

  it("detects a doctored golden checksum series", () => {
    const log = makeLog();
    const golden = resimulate(spawns, log, 60).perTickChecksum;
    golden[45] = (golden[45] ^ 0xdead) >>> 0; // doctor one recorded checksum

    const v = verifyAgainst(spawns, log, golden);
    expect(v.ok).toBe(false);
    expect(v.divergedAtTick).toBe(45);
  });

  it("actually moves the player (log isn't a no-op)", () => {
    const still = resimulate(spawns, [], 60).finalChecksum;
    const moving = resimulate(spawns, makeLog(), 60).finalChecksum;
    expect(moving).not.toBe(still);
  });
});

describe("ReSim — full combat-stack determinism (R10)", () => {
  // Player 2's centre sits at player 1's eye height + same z-line, so a level
  // machinegun ray from player 1 hits it (both fall together, so it stays aligned).
  const combatSpawns: ReSimSpawn[] = [
    { entityId: 1, playerId: 1, x: 0, y: 500, z: 0 },
    { entityId: 2, playerId: 2, x: 0, y: 500 + DEFAULT_VIEWHEIGHT, z: 100 },
  ];

  function firingLog(): RecordedCmd[] {
    const log: RecordedCmd[] = [];
    // Player 1 holds fire, aimed +z at player 2. Player 2 idle.
    for (let t = 0; t < 60; t++) {
      log.push({ tick: t, entityId: 1, cmd: cmd(t + 1, { buttons: FIRE_BUTTON, yaw: 0, pitch: 0 }) });
    }
    return log;
  }

  it("is deterministic across the full weapon+combat+projectile stack", () => {
    const a = resimulateFull(combatSpawns, firingLog(), 60);
    const b = resimulateFull(combatSpawns, firingLog(), 60);
    expect(a.perTickChecksum).toEqual(b.perTickChecksum);
    expect(a.finalChecksum).toBe(b.finalChecksum);
  });

  it("actually exercises combat (firing diverges from idle — a hit landed)", () => {
    const idle = resimulateFull(combatSpawns, [], 60).finalChecksum;
    const firing = resimulateFull(combatSpawns, firingLog(), 60).finalChecksum;
    // Damage + knockback move/hurt player 2, so the state (health/velocity/pos) differs.
    expect(firing).not.toBe(idle);
  });
});
