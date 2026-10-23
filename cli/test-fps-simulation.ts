/**
 * Test script for FPSSimulation initialization
 * Run with: npx vite-node src/games/fps/cli/test-fps-simulation.ts
 */

import type { TransformComponent } from "../../../engine/network/components/TransformComponent";
import type { VelocityComponent } from "../../../engine/network/components/VelocityComponent";
import { createBSPCollisionWorld } from "../simulation/collision/BSPCollisionWorld";
import { FPSSimulation } from "../simulation/FPSSimulation";

console.log("\n=== FPSSimulation Initialization Test ===\n");

// Create simulation
console.log("[TEST] Creating FPSSimulation...");
const sim = new FPSSimulation({
  tickRate: 60,
  tickDuration: 1 / 60,
  maxPlayers: 1,
  gameRules: {},
});

console.log("[TEST] Simulation created");

// Check if we can set collision world
console.log("[TEST] Testing setCollisionWorld...");

try {
  // BSPCollisionWorld constructor takes no args - uses CollisionManager singleton
  const collisionWorld = createBSPCollisionWorld();
  console.log("[TEST] BSPCollisionWorld created:", !!collisionWorld);

  sim.setCollisionWorld(collisionWorld);
  console.log("[TEST] setCollisionWorld called successfully");
} catch (err) {
  console.error("[TEST] Error setting collision world:", err);
}

// Test spawning a player
console.log("\n[TEST] Testing player spawn...");
try {
  const player = sim.spawnPlayer("test-player");
  console.log("[TEST] Player spawned:", !!player);
  console.log("[TEST] Player entity ID:", player.id);

  const transform = player.getComponent<TransformComponent>("transform");
  const velocity = player.getComponent<VelocityComponent>("velocity");
  console.log("[TEST] Player has transform:", !!transform);
  console.log("[TEST] Player has velocity:", !!velocity);
  if (transform) {
    console.log("[TEST] Player position:", transform.position);
  }
  if (velocity) {
    console.log("[TEST] Player velocity:", velocity.linear);
    console.log("[TEST] Player grounded:", velocity.grounded);
  }
} catch (err) {
  console.error("[TEST] Error spawning player:", err);
}

// Test simulation tick
console.log("\n[TEST] Testing simulation ticks with gravity...");
try {
  // Run 10 simulation ticks
  for (let i = 0; i < 10; i++) {
    sim.tick([]); // empty input commands
  }
  console.log("[TEST] 10 simulation ticks completed");

  // Check state after ticks
  const movementSystem = sim.getMovementSystem();
  console.log("[TEST] Movement system exists:", !!movementSystem);
  console.log("[TEST] Movement profile name:", movementSystem?.getProfileName?.());
} catch (err) {
  console.error("[TEST] Error during tick:", err);
}

console.log("\n=== Test Complete ===\n");
