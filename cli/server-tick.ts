/**
 * Server Tick Test CLI
 *
 * Usage: npm run server:tick
 *
 * Tests the new V2 simulation by running ticks and verifying determinism.
 */

import { Simulation } from "../../../engine/server/core/Simulation";
import { createPlayerEntity } from "../../../engine/server/ecs/Entity";
import { entityId, playerId } from "../../../engine/server/ecs/types";
import { CharacterPhysicsSystem } from "../server/systems/CharacterPhysicsSystem";

console.log("═══════════════════════════════════════════════════════════════════");
console.log(" V2 Server Tick Test");
console.log("═══════════════════════════════════════════════════════════════════");
console.log();

// Create simulation with 125Hz physics (8ms tick)
const sim = new Simulation({ tickMs: 8 });

// Add physics system
sim.addSubsystem(new CharacterPhysicsSystem());

// Initialize
sim.initialize();

console.log(`[SETUP] Created simulation at ${1000 / sim.tickMs} Hz`);
console.log(
  `[SETUP] Subsystems: ${sim
    .getSubsystems()
    .map((s) => s.name)
    .join(", ")}`,
);
console.log();

// Get mutable state for setup
const state = sim.getStateMut();

// Spawn a player
const player = createPlayerEntity(entityId(1), playerId(100), { x: 0, y: 100, z: 0 });
state.addEntity(player);

console.log(`[SPAWN] Created player entity ${player.id}`);
console.log(
  `[SPAWN] Position: (${player.transform?.position.x}, ${player.transform?.position.y}, ${player.transform?.position.z})`,
);
console.log();

// Set player input (moving forward)
const playerEntity = state.getEntityMut(player.id);
if (playerEntity?.input) {
  playerEntity.input.forward = 1; // Move forward
  playerEntity.input.yaw = 0; // Facing +Z
}

console.log("[INPUT] Set player input: forward=1, yaw=0");
console.log();

// Run simulation for 1 second (125 ticks)
console.log("[SIM] Running 125 ticks (1 second)...");
const startChecksum = sim.checksum();
const startTime = performance.now();

for (let i = 0; i < 125; i++) {
  sim.tick();
}

const elapsed = performance.now() - startTime;
const endChecksum = sim.checksum();

console.log(`[SIM] Completed in ${elapsed.toFixed(2)}ms (${(elapsed / 125).toFixed(3)}ms per tick)`);
console.log();

// Check final state
const finalState = sim.getState();
const finalPlayer = finalState.getEntity(player.id);

if (finalPlayer?.transform && finalPlayer?.physics) {
  console.log("[RESULT] Final player state:");
  console.log(
    `  Position: (${finalPlayer.transform.position.x.toFixed(2)}, ${finalPlayer.transform.position.y.toFixed(2)}, ${finalPlayer.transform.position.z.toFixed(2)})`,
  );
  console.log(
    `  Velocity: (${finalPlayer.physics.velocity.x.toFixed(2)}, ${finalPlayer.physics.velocity.y.toFixed(2)}, ${finalPlayer.physics.velocity.z.toFixed(2)})`,
  );
  console.log(`  Grounded: ${finalPlayer.physics.grounded}`);
}

console.log();
console.log(`[CHECKSUM] Start: ${startChecksum} -> End: ${endChecksum}`);
console.log();

// Determinism test: run again with same initial conditions
console.log("[DETERMINISM] Running determinism test...");

const sim2 = new Simulation({ tickMs: 8 });
sim2.addSubsystem(new CharacterPhysicsSystem());
sim2.initialize();

const state2 = sim2.getStateMut();
const player2 = createPlayerEntity(entityId(1), playerId(100), { x: 0, y: 100, z: 0 });
state2.addEntity(player2);

const player2Entity = state2.getEntityMut(player2.id);
if (player2Entity?.input) {
  player2Entity.input.forward = 1;
  player2Entity.input.yaw = 0;
}

for (let i = 0; i < 125; i++) {
  sim2.tick();
}

const checksum2 = sim2.checksum();

if (endChecksum === checksum2) {
  console.log(`[DETERMINISM] ✅ PASSED - Checksums match: ${endChecksum}`);
} else {
  console.log(`[DETERMINISM] ❌ FAILED - Checksums differ: ${endChecksum} vs ${checksum2}`);
}

console.log();
console.log("═══════════════════════════════════════════════════════════════════");
console.log(" Test Complete!");
console.log("═══════════════════════════════════════════════════════════════════");
