/**
 * Deterministic demo re-simulation (anti-cheat WO-AC4).
 *
 * The oracle: replay a recorded stream of usercmds through the authoritative
 * simulation and produce a per-tick state checksum. Because the sim is
 * RNG-deterministic (server-authority R3/R3b), the same input log always
 * reproduces the same checksums — so:
 *   - two re-sims of a log agree (determinism), and
 *   - any tampering with the log (or a doctored recorded checksum) shows up as a
 *     checksum divergence (tamper-evidence + a full-fidelity offline detector oracle).
 *
 * This is the computational core of a `demo:verify` tool. Wiring it to read the
 * usercmd track + golden checksums from an on-disk `.shagdemo` is the remaining
 * plumbing (WO-AC4b); this module proves the primitive on an in-memory log.
 *
 * Scope: movement (`FPSMovementSubsystem`) — the fixed-rate input path the
 * determinism work targeted. Weapons/combat re-sim (needs a collision world) is a
 * later extension.
 */

import { Simulation } from "@engine/server/core/Simulation";
import type { WorldState } from "@engine/server/core/WorldState";
import { createPlayerEntity } from "@engine/server/ecs/Entity";
import { entityId, playerId } from "@engine/server/ecs/types";
import type { QueuedInput } from "@shared/server/simulation/components/InputComponent";
import { CombatSystem } from "./systems/CombatSystem";
import { FPSMovementSubsystem } from "./systems/FPSMovementSubsystem";
import { ProjectileSystem } from "./systems/ProjectileSystem";
import { WeaponSystem } from "./systems/WeaponSystem";

/**
 * Richer state checksum than `WorldState.checksum()` (which hashes position only):
 * folds in velocity, grounded, and health/dead so **combat and knockback** are
 * observable for re-sim reconciliation — essential for full-stack verification.
 * Quantized to ints to avoid cross-run float noise. Deterministic (sorted by id).
 */
export function stateChecksum(state: Readonly<WorldState>): number {
  let hash = 2166136261;
  const prime = 16777619;
  const mix = (v: number) => {
    hash ^= v | 0;
    hash = Math.imul(hash, prime);
  };
  const ents = [...state.allEntities()].sort((a, b) => (a.id as number) - (b.id as number));
  for (const e of ents) {
    mix(e.id as number);
    if (e.transform) {
      mix(Math.round(e.transform.position.x * 100));
      mix(Math.round(e.transform.position.y * 100));
      mix(Math.round(e.transform.position.z * 100));
    }
    if (e.physics) {
      mix(Math.round(e.physics.velocity.x * 100));
      mix(Math.round(e.physics.velocity.y * 100));
      mix(Math.round(e.physics.velocity.z * 100));
      mix(e.physics.grounded ? 1 : 0);
    }
    if (e.health) {
      mix(Math.round(e.health.health));
      mix(e.health.dead ? 1 : 0);
    }
  }
  return hash >>> 0;
}

/** Initial spawn state for a re-simulated player. */
export interface ReSimSpawn {
  entityId: number;
  playerId: number;
  x: number;
  y: number;
  z: number;
}

/** One recorded usercmd, tagged with the sim tick it is enqueued at. */
export interface RecordedCmd {
  tick: number;
  entityId: number;
  cmd: QueuedInput;
}

export interface ReSimResult {
  /** State checksum after each tick (index = tick). */
  perTickChecksum: number[];
  finalChecksum: number;
}

/**
 * Replay `log` through a fresh movement simulation for `ticks` ticks, enqueuing
 * each cmd at its recorded tick. Deterministic function of (spawns, log, ticks).
 */
export function resimulate(spawns: ReSimSpawn[], log: RecordedCmd[], ticks: number): ReSimResult {
  const sim = new Simulation({ tickMs: 8 });
  sim.addSubsystem(new FPSMovementSubsystem());
  sim.initialize();

  const state = sim.getStateMut();
  for (const s of spawns) {
    state.addEntity(createPlayerEntity(entityId(s.entityId), playerId(s.playerId), { x: s.x, y: s.y, z: s.z }));
  }

  // Bucket cmds by the tick they are enqueued at.
  const byTick = new Map<number, RecordedCmd[]>();
  for (const c of log) {
    const arr = byTick.get(c.tick);
    if (arr) arr.push(c);
    else byTick.set(c.tick, [c]);
  }

  const perTickChecksum: number[] = [];
  for (let t = 0; t < ticks; t++) {
    const cmds = byTick.get(t);
    if (cmds) {
      const cur = sim.getStateMut();
      for (const { entityId: eid, cmd } of cmds) {
        const e = cur.getEntityMut(entityId(eid));
        if (e?.input) e.input.inputQueue.push({ ...cmd });
      }
    }
    sim.tick();
    perTickChecksum.push(stateChecksum(sim.getState()));
  }

  return { perTickChecksum, finalChecksum: stateChecksum(sim.getState()) };
}

/**
 * Full-stack re-sim: movement + weapons + combat + projectiles (the subsystems a
 * real match runs, minus network/gametype/collision). Proves the *combat* stack —
 * not just movement — is deterministic under replay, the key prerequisite for
 * verifying full recorded matches (R10). Each player gets a machinegun loadout;
 * pending weapon/projectile damage is forwarded to combat each tick exactly as
 * `GameServer.tick` does.
 *
 * Scope: no collision world (player-vs-player combat + gravity only) and no
 * gametype respawn — enough to exercise weapon→combat→health→knockback→movement
 * deterministically. Full parity (collision, respawns, pickups) is the remaining
 * R10 work.
 */
export function resimulateFull(spawns: ReSimSpawn[], log: RecordedCmd[], ticks: number): ReSimResult {
  const sim = new Simulation({ tickMs: 8 });
  const movement = new FPSMovementSubsystem();
  const weapon = new WeaponSystem();
  const combat = new CombatSystem();
  const projectile = new ProjectileSystem();
  weapon.setProjectileSystem(projectile);
  weapon.setMovementSubsystem(movement);
  combat.setMovementSubsystem(movement);
  movement.setCombatSystem(combat);
  sim.addSubsystem(movement);
  sim.addSubsystem(weapon);
  sim.addSubsystem(combat);
  sim.addSubsystem(projectile);
  sim.initialize();

  const state = sim.getStateMut();
  for (const s of spawns) {
    state.addEntity(createPlayerEntity(entityId(s.entityId), playerId(s.playerId), { x: s.x, y: s.y, z: s.z }));
    weapon.initializeWeaponFromLoadout(entityId(s.entityId), {
      weapons: ["machinegun"],
      ammo: { machinegun: 10000 },
      health: 100,
      armor: 0,
    } as never);
  }

  const byTick = new Map<number, RecordedCmd[]>();
  for (const c of log) {
    const arr = byTick.get(c.tick);
    if (arr) arr.push(c);
    else byTick.set(c.tick, [c]);
  }

  const perTickChecksum: number[] = [];
  for (let t = 0; t < ticks; t++) {
    const cmds = byTick.get(t);
    if (cmds) {
      const cur = sim.getStateMut();
      for (const { entityId: eid, cmd } of cmds) {
        const e = cur.getEntityMut(entityId(eid));
        if (e?.input) e.input.inputQueue.push({ ...cmd });
      }
    }
    sim.tick();
    // Forward weapon + projectile damage into combat (applied next tick), exactly
    // as GameServer.tick does — deterministic ordering.
    for (const dmg of weapon.getPendingDamage()) combat.queueDamage(dmg);
    for (const dmg of projectile.getPendingDamage()) combat.queueDamage(dmg);
    perTickChecksum.push(stateChecksum(sim.getState()));
  }

  return { perTickChecksum, finalChecksum: stateChecksum(sim.getState()) };
}

export interface VerifyResult {
  /** True if the re-sim's per-tick checksums equal the golden series. */
  ok: boolean;
  /** First tick whose checksum diverged, or null if fully reconciled. */
  divergedAtTick: number | null;
}

/**
 * Verify a recorded input log against a golden per-tick checksum series (as a
 * `.shagdemo` would carry). Re-simulates the log and compares tick-by-tick.
 * A mismatch means the log was tampered with, the demo's checksums were doctored,
 * or the sim is non-deterministic — all things `demo:verify` must catch.
 */
export function verifyAgainst(spawns: ReSimSpawn[], log: RecordedCmd[], goldenPerTickChecksum: number[]): VerifyResult {
  const result = resimulate(spawns, log, goldenPerTickChecksum.length);
  for (let i = 0; i < goldenPerTickChecksum.length; i++) {
    if (result.perTickChecksum[i] !== goldenPerTickChecksum[i]) {
      return { ok: false, divergedAtTick: i };
    }
  }
  return { ok: true, divergedAtTick: null };
}
