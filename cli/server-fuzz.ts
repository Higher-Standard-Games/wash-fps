#!/usr/bin/env npx vite-node

/**
 * Server Fuzz Test
 *
 * Generates random player inputs and runs the simulation to detect:
 * - NaN/Infinity values in physics
 * - Crashes or exceptions
 * - Non-determinism (same seed → different results)
 *
 * Usage:
 *   npm run server:fuzz
 *   npm run server:fuzz -- --ticks 100000 --seed 42
 */

import { runCli } from "../../../cli/_runCli";
import { Simulation } from "../../../engine/server/core/Simulation";
import { createPlayerEntity } from "../../../engine/server/ecs/Entity";
import { EntityType, entityId, playerId } from "../../../engine/server/ecs/types";
import { CharacterPhysicsSystem } from "../server/systems/CharacterPhysicsSystem";

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

interface FuzzConfig {
  ticks: number;
  seed: number;
  players: number;
  verbose: boolean;
}

function parseArgs(): FuzzConfig {
  const args = process.argv.slice(2);
  const config: FuzzConfig = {
    ticks: 10000,
    seed: Date.now(),
    players: 4,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--ticks":
        config.ticks = parseInt(args[++i], 10);
        break;
      case "--seed":
        config.seed = parseInt(args[++i], 10);
        break;
      case "--players":
        config.players = parseInt(args[++i], 10);
        break;
      case "--verbose":
      case "-v":
        config.verbose = true;
        break;
    }
  }

  return config;
}

// ═══════════════════════════════════════════════════════════════════
// SEEDED RANDOM (deterministic)
// ═══════════════════════════════════════════════════════════════════

class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  /** Generate random number in [0, 1) */
  next(): number {
    // Mulberry32 PRNG
    this.seed += 0x6d2b79f5;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Random number in [min, max] */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Random boolean */
  bool(): boolean {
    return this.next() > 0.5;
  }
}

// ═══════════════════════════════════════════════════════════════════
// FUZZ INPUT GENERATOR
// ═══════════════════════════════════════════════════════════════════

function generateRandomInput(rng: SeededRandom): {
  forward: number;
  right: number;
  jump: boolean;
  yaw: number;
  pitch: number;
} {
  return {
    forward: rng.range(-1, 1),
    right: rng.range(-1, 1),
    jump: rng.bool(),
    yaw: rng.range(0, Math.PI * 2),
    pitch: rng.range(-Math.PI / 2, Math.PI / 2),
  };
}

// ═══════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function validateState(sim: Simulation): ValidationResult {
  const errors: string[] = [];
  const state = sim.getState();

  for (const entity of state.entitiesByType(EntityType.Player)) {
    const transform = entity.transform;
    const physics = entity.physics;

    if (!transform || !physics) continue;

    // Check for NaN
    if (
      Number.isNaN(transform.position.x) ||
      Number.isNaN(transform.position.y) ||
      Number.isNaN(transform.position.z)
    ) {
      errors.push(`Entity ${entity.id}: Position is NaN`);
    }
    if (Number.isNaN(physics.velocity.x) || Number.isNaN(physics.velocity.y) || Number.isNaN(physics.velocity.z)) {
      errors.push(`Entity ${entity.id}: Velocity is NaN`);
    }

    // Check for Infinity
    if (
      !Number.isFinite(transform.position.x) ||
      !Number.isFinite(transform.position.y) ||
      !Number.isFinite(transform.position.z)
    ) {
      errors.push(`Entity ${entity.id}: Position is Infinite`);
    }
    if (
      !Number.isFinite(physics.velocity.x) ||
      !Number.isFinite(physics.velocity.y) ||
      !Number.isFinite(physics.velocity.z)
    ) {
      errors.push(`Entity ${entity.id}: Velocity is Infinite`);
    }

    // Check for extreme values (potential explosion)
    const MAX_POS = 100000;
    const MAX_VEL = 10000;
    if (
      Math.abs(transform.position.x) > MAX_POS ||
      Math.abs(transform.position.y) > MAX_POS ||
      Math.abs(transform.position.z) > MAX_POS
    ) {
      errors.push(`Entity ${entity.id}: Position out of bounds`);
    }
    if (
      Math.abs(physics.velocity.x) > MAX_VEL ||
      Math.abs(physics.velocity.y) > MAX_VEL ||
      Math.abs(physics.velocity.z) > MAX_VEL
    ) {
      errors.push(`Entity ${entity.id}: Velocity too high`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ═══════════════════════════════════════════════════════════════════
// SIMULATION SETUP
// ═══════════════════════════════════════════════════════════════════

function setupSimulation(config: FuzzConfig, rng: SeededRandom): Simulation {
  const sim = new Simulation({ tickMs: 8 });
  sim.addSubsystem(new CharacterPhysicsSystem());
  sim.initialize();

  const state = sim.getStateMut();
  for (let i = 0; i < config.players; i++) {
    const player = createPlayerEntity(entityId(i + 1), playerId(i + 1), {
      x: rng.range(-500, 500),
      y: rng.range(0, 200),
      z: rng.range(-500, 500),
    });
    state.addEntity(player);
  }

  return sim;
}

function applyRandomInputs(sim: Simulation, config: FuzzConfig, rng: SeededRandom): void {
  const state = sim.getStateMut();
  for (let i = 0; i < config.players; i++) {
    const entity = state.getEntityMut(entityId(i + 1));
    if (entity?.input) {
      const randomInput = generateRandomInput(rng);
      entity.input.forward = randomInput.forward;
      entity.input.right = randomInput.right;
      entity.input.jump = randomInput.jump;
      entity.input.yaw = randomInput.yaw;
      entity.input.pitch = randomInput.pitch;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const config = parseArgs();

  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(" V2 Server Fuzz Test");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log();
  console.log(`[CONFIG] Ticks: ${config.ticks}`);
  console.log(`[CONFIG] Seed: ${config.seed}`);
  console.log(`[CONFIG] Players: ${config.players}`);
  console.log();

  // Setup
  const rng = new SeededRandom(config.seed);
  const sim = setupSimulation(config, rng);

  console.log(`[SETUP] Created ${config.players} players at random positions`);
  console.log();
  console.log(`[FUZZ] Running ${config.ticks} ticks with random inputs...`);

  // Run simulation
  const startTime = performance.now();
  let errorsFound = 0;
  let lastProgressPct = 0;

  for (let tick = 0; tick < config.ticks; tick++) {
    // Generate random inputs
    applyRandomInputs(sim, config, rng);

    // Run tick
    try {
      sim.tick();
    } catch (e) {
      console.error(`[ERROR] Tick ${tick}: Exception thrown!`);
      console.error(e);
      errorsFound++;
      break;
    }

    // Validate state
    const validation = validateState(sim);
    if (!validation.valid) {
      for (const error of validation.errors) {
        console.error(`[ERROR] Tick ${tick}: ${error}`);
      }
      errorsFound += validation.errors.length;
      if (errorsFound > 10) {
        console.error(`[ABORT] Too many errors, stopping.`);
        break;
      }
    }

    // Progress
    const progressPct = Math.floor((tick / config.ticks) * 100);
    if (progressPct > lastProgressPct && progressPct % 10 === 0) {
      if (!config.verbose) {
        process.stdout.write(`\r[FUZZ] Progress: ${progressPct}%`);
      }
      lastProgressPct = progressPct;
    }
  }

  const endTime = performance.now();
  const duration = endTime - startTime;
  const ticksPerSec = Math.round(config.ticks / (duration / 1000));

  console.log();
  console.log();
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(" Fuzz Test Results");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log();
  console.log(`[PERFORMANCE] ${config.ticks} ticks in ${duration.toFixed(1)}ms (${ticksPerSec} ticks/sec)`);
  console.log(`[ERRORS] ${errorsFound} errors found`);
  console.log(`[SEED] ${config.seed} (use this to reproduce)`);
  console.log();

  if (errorsFound === 0) {
    console.log("✅ PASSED - No NaN, Infinity, or crashes detected");
  } else {
    console.log("❌ FAILED - Errors detected (see above)");
    process.exit(1);
  }

  // Determinism check
  console.log();
  console.log("[DETERMINISM] Running again with same seed...");

  const rng2 = new SeededRandom(config.seed);
  const sim2 = setupSimulation(config, rng2);

  for (let tick = 0; tick < config.ticks; tick++) {
    applyRandomInputs(sim2, config, rng2);
    sim2.tick();
  }

  const checksum1 = sim.getState().checksum();
  const checksum2 = sim2.getState().checksum();

  if (checksum1 === checksum2) {
    console.log(`[DETERMINISM] ✅ PASSED - Checksums match: ${checksum1}`);
  } else {
    console.log(`[DETERMINISM] ❌ FAILED - Checksums differ!`);
    console.log(`  Run 1: ${checksum1}`);
    console.log(`  Run 2: ${checksum2}`);
    process.exit(1);
  }

  console.log();
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(" Fuzz Test Complete!");
  console.log("═══════════════════════════════════════════════════════════════════");
}

void runCli(main);
