/**
 * Anti-cheat calibration harness (WO-AC3).
 *
 * The guardrail from ANTICHEAT_FEATURES.md §0.3: **no detection signal may gate
 * anything until we've measured its false-positive rate against labeled data.**
 * This produces that labeled data synthetically and sweeps thresholds for the
 * WO-AC1 accuracy signal.
 *
 * Method: run a controlled combat trial (full weapon+combat stack, no collision)
 * where a shooter tracks a target and fires a machinegun, with aim perturbed by a
 * per-trial noise level. A near-zero-noise shooter is a stand-in **aimbot**; a
 * several-degree-noise shooter is a **human**. We measure the resulting accuracy
 * (hits/shots), then for each candidate threshold report:
 *   - detection rate  = fraction of aimbot trials at/above the threshold
 *   - false-positive  = fraction of human trials at/above the threshold
 *
 * Caveat (tracked as risk R2): this synthetic human is a stand-in, and our real
 * demos are me-vs-bot. Treat the numbers as **directional** until calibrated
 * against real player demos — but the shape (where FP starts biting) is the point.
 */

import { Simulation } from "@engine/server/core/Simulation";
import { createPlayerEntity } from "@engine/server/ecs/Entity";
import { entityId, playerId } from "@engine/server/ecs/types";
import { DEFAULT_VIEWHEIGHT } from "../../../engine/physics/PlayerPhysicsConstants";
import { rngFrom } from "../../../shared/DeterministicRng";
import { CombatSystem } from "./systems/CombatSystem";
import { FPSMovementSubsystem } from "./systems/FPSMovementSubsystem";
import { ProjectileSystem } from "./systems/ProjectileSystem";
import { WeaponSystem } from "./systems/WeaponSystem";

const FIRE_BUTTON = 1 << 8;
const DEG = Math.PI / 180;

export interface TrialResult {
  shots: number;
  hits: number;
  accuracy: number;
}

/**
 * One controlled accuracy trial. Shooter tracks a stationary-in-XZ target
 * `distance` away and fires; aim is perturbed by `aimNoiseDeg` of uniform noise
 * (seeded → deterministic). Returns the shooter's single-ray hitscan accuracy.
 */
export function runAccuracyTrial(seed: number, aimNoiseDeg: number, ticks: number, distance = 400): TrialResult {
  const sim = new Simulation({ tickMs: 8 });
  const movement = new FPSMovementSubsystem();
  const weapon = new WeaponSystem();
  const combat = new CombatSystem();
  const projectile = new ProjectileSystem();
  weapon.setProjectileSystem(projectile);
  weapon.setMovementSubsystem(movement);
  combat.setMovementSubsystem(movement);
  for (const s of [movement, weapon, combat, projectile]) sim.addSubsystem(s);
  sim.initialize();

  const state = sim.getStateMut();
  state.addEntity(createPlayerEntity(entityId(1), playerId(1), { x: 0, y: 500, z: 0 }));
  state.addEntity(createPlayerEntity(entityId(2), playerId(2), { x: 0, y: 500, z: distance }));
  for (const id of [1, 2]) {
    weapon.initializeWeaponFromLoadout(entityId(id), {
      weapons: ["machinegun"],
      ammo: { machinegun: 100000 },
      health: 100000, // keep the target alive for the whole trial (we measure aim, not kills)
      armor: 0,
    } as never);
  }

  const noise = aimNoiseDeg * DEG;
  const rng = rngFrom(seed, 777, 0);

  for (let t = 0; t < ticks; t++) {
    const cur = sim.getStateMut();
    const shooter = cur.getEntityMut(entityId(1));
    const target = cur.getEntity(entityId(2));
    if (shooter?.input && shooter.transform && target?.transform) {
      // keep the target at full health so every shot has something to hit
      const th = cur.getEntityMut(entityId(2));
      if (th?.health) th.health.health = 100000;

      const ex = shooter.transform.position.x;
      const ey = shooter.transform.position.y + DEFAULT_VIEWHEIGHT;
      const ez = shooter.transform.position.z;
      const dx = target.transform.position.x - ex;
      const dy = target.transform.position.y - ey;
      const dz = target.transform.position.z - ez;
      const dist = Math.hypot(dx, dy, dz) || 1;

      const yaw = Math.atan2(dx, dz) + (rng() - 0.5) * 2 * noise;
      // input.pitch such that fire dir.y = sin(-input.pitch) = dy/dist
      const pitch = -Math.asin(Math.max(-1, Math.min(1, dy / dist))) + (rng() - 0.5) * 2 * noise;

      shooter.input.inputQueue.push({
        forward: 0,
        right: 0,
        pitch,
        yaw,
        buttons: FIRE_BUTTON,
        sequence: t + 1,
        weaponSlot: 0,
      });
    }
    sim.tick();
    for (const dmg of weapon.getPendingDamage()) combat.queueDamage(dmg);
    for (const dmg of projectile.getPendingDamage()) combat.queueDamage(dmg);
  }

  const acc = weapon.getAccuracy(entityId(1));
  return { shots: acc.shots, hits: acc.hits, accuracy: acc.shots > 0 ? acc.hits / acc.shots : 0 };
}

export interface CalibrationRow {
  threshold: number;
  detectionRate: number;
  falsePositiveRate: number;
}

export interface CalibrationResult {
  humanAccuracies: number[];
  aimbotAccuracies: number[];
  rows: CalibrationRow[];
}

export interface CalibrateOptions {
  trials?: number;
  ticks?: number;
  humanNoiseDeg?: number;
  aimbotNoiseDeg?: number;
  thresholds?: number[];
  seed?: number;
}

/**
 * Run `trials` human and `trials` aimbot trials, then for each threshold report
 * detection rate (aimbot ≥ threshold) and false-positive rate (human ≥ threshold).
 */
export function calibrateAccuracy(opts: CalibrateOptions = {}): CalibrationResult {
  const trials = opts.trials ?? 40;
  const ticks = opts.ticks ?? 1500;
  const humanNoiseDeg = opts.humanNoiseDeg ?? 6;
  const aimbotNoiseDeg = opts.aimbotNoiseDeg ?? 0.4;
  const thresholds = opts.thresholds ?? [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99];
  const baseSeed = opts.seed ?? 1;

  const humanAccuracies: number[] = [];
  const aimbotAccuracies: number[] = [];
  for (let i = 0; i < trials; i++) {
    humanAccuracies.push(runAccuracyTrial(baseSeed + i, humanNoiseDeg, ticks).accuracy);
    aimbotAccuracies.push(runAccuracyTrial(baseSeed + 100000 + i, aimbotNoiseDeg, ticks).accuracy);
  }

  const rate = (arr: number[], thr: number) => arr.filter((a) => a >= thr).length / arr.length;
  const rows: CalibrationRow[] = thresholds.map((threshold) => ({
    threshold,
    detectionRate: rate(aimbotAccuracies, threshold),
    falsePositiveRate: rate(humanAccuracies, threshold),
  }));

  return { humanAccuracies, aimbotAccuracies, rows };
}

/** Mean of a list (helper for reporting). */
export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
