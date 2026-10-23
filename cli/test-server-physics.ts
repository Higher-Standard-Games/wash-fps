/**
 * Headless Server Physics Test
 *
 * Tests the FPSMovementProfile and HeadlessBSPCollisionWorld in isolation
 * to verify server-side physics work correctly.
 *
 * Run with: npx vite-node src/games/fps/cli/test-server-physics.ts --map washoi_dm2
 */

import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";
import { runCli } from "../../../cli/_runCli";
import { createHeadlessCollisionWorld } from "../../../cli/HeadlessBSPCollisionWorld";
import { BspLoader } from "../../../engine/loader/bsp/BspLoader";
import { InputButtons } from "../../../engine/network/components/InputComponent";
import type { Vec3 } from "../../../engine/network/components/TransformComponent";
import type { MovementInput } from "../../../engine/network/systems/movement/MovementProfile";
import { MovementProfile as FPSMovementProfile } from "../simulation/MovementProfile";

// Parse command line args
const args = process.argv.slice(2);
let mapName = "washoi_dm2";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--map" || args[i].startsWith("--map=")) {
    mapName = args[i].startsWith("--map=") ? args[i].substring(6) : args[++i];
  } else if (!args[i].startsWith("-")) {
    mapName = args[i];
  }
}

console.log("");
console.log("╔═══════════════════════════════════════════════════════╗");
console.log("║          Headless Server Physics Test                 ║");
console.log("╚═══════════════════════════════════════════════════════╝");
console.log("");

async function loadBsp(mapName: string): Promise<ReturnType<typeof BspLoader.load>> {
  const possiblePaths = [
    // Canonical map-pk3 location (what the lobby/browser use)
    path.resolve("./public/data", `map_${mapName}.pk3`),
    // Legacy headless locations
    path.resolve("./public/games/default", `map_${mapName}.pk3`),
    path.resolve("./public/games/default/basewsw", `map_${mapName}.pk3`),
  ];

  for (const bspPath of possiblePaths) {
    if (fs.existsSync(bspPath)) {
      console.log(`[Test] Found BSP at: ${bspPath}`);
      const pk3Buffer = fs.readFileSync(bspPath);
      const zip = await JSZip.loadAsync(new Uint8Array(pk3Buffer));

      for (const filename of Object.keys(zip.files)) {
        if (filename.endsWith(".bsp")) {
          const bspBuffer = await zip.files[filename].async("arraybuffer");
          console.log(`[Test] Extracted: ${filename}`);
          return BspLoader.load(bspBuffer);
        }
      }
    }
  }

  throw new Error(`Could not find BSP for map: ${mapName}`);
}

async function runTest() {
  console.log(`[Test] Loading map: ${mapName}`);

  // Load BSP
  const bsp = await loadBsp(mapName);
  console.log(`[Test] BSP loaded: ${bsp.brushes.length} brushes, ${bsp.planes.length} planes`);

  // Create collision world (await it properly!)
  const collision = await createHeadlessCollisionWorld(bsp);
  console.log(`[Test] Collision world created`);

  // Create movement profile
  const movement = new FPSMovementProfile();
  console.log(`[Test] Movement profile created: ${movement.getName()}`);

  // Find a spawn point from entities
  let spawnPos: Vec3 = { x: 0, y: 100, z: 0 };
  for (const entity of bsp.entities) {
    if (entity.classname === "info_player_deathmatch") {
      const origin = entity.properties.origin;
      if (origin) {
        const [x, y, z] = origin.split(" ").map(Number);
        spawnPos = { x, y: z, z: y }; // Convert Quake coords (z-up) to Babylon (y-up)
        break;
      }
    }
  }
  console.log(`[Test] Spawn position: (${spawnPos.x}, ${spawnPos.y}, ${spawnPos.z})`);

  // === SIMULATION TEST ===
  console.log("");
  console.log("=== Running 3 Second Simulation ===");
  console.log("");

  const tickRate = 20; // Hz
  const deltaTime = 1 / tickRate;
  const totalTicks = 3 * tickRate; // 3 seconds

  let position = { ...spawnPos };
  let velocity: Vec3 = { x: 0, y: 0, z: 0 };

  // Create a simple input that moves forward
  let buttons = 0;
  const input: MovementInput = {
    direction: { x: 0, y: 0, z: 1 }, // Forward
    viewAngles: { pitch: 0, yaw: 0 },
    buttons: buttons,
    isPressed: (btn: number) => (buttons & btn) !== 0,
  };

  console.log("Tick | Position (X, Y, Z) | Velocity (X, Y, Z) | Grounded | HSpeed");
  console.log("-----|---------------------|--------------------|---------|---------");

  for (let tick = 0; tick < totalTicks; tick++) {
    // Jump at tick 20 (1 second in)
    if (tick === 20) {
      buttons = InputButtons.JUMP;
      console.log(`[Tick ${tick}] === JUMP PRESSED ===`);
    } else if (tick === 21) {
      buttons = 0;
    }

    // Sprint forward for first 40 ticks
    if (tick < 40) {
      buttons |= InputButtons.SPRINT;
      input.direction = { x: 0, y: 0, z: 1 };
    } else {
      input.direction = { x: 0, y: 0, z: 0 };
    }

    // Update input
    input.buttons = buttons;
    input.isPressed = (btn: number) => (buttons & btn) !== 0;

    // Run physics
    const result = movement.simulate(position, velocity, input, deltaTime, collision);

    // Update state
    position = result.position;
    velocity = result.velocity;

    // Log every 5 ticks
    if (tick % 5 === 0 || tick < 5 || (tick >= 18 && tick <= 25)) {
      const pos = `(${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`;
      const vel = `(${velocity.x.toFixed(1)}, ${velocity.y.toFixed(1)}, ${velocity.z.toFixed(1)})`;
      console.log(
        `${tick.toString().padStart(4)} | ${pos.padEnd(19)} | ${vel.padEnd(18)} | ${result.grounded ? "YES" : "NO ".padEnd(7)} | ${result.actualHorizSpeed.toFixed(1)}`,
      );
    }
  }

  console.log("");
  console.log("=== Test Complete ===");
  console.log("");
  console.log("Expected behavior:");
  console.log("- Position Y should stay at spawn level when grounded (not fall through)");
  console.log("- Jump should increase Y velocity at tick 20");
  console.log("- Grounded should be YES when on floor, NO when in air after jump");
  console.log("- Horizontal speed should increase when moving");
  console.log("");

  // === COLLISION TRACE TEST ===
  console.log("=== Direct Collision Test ===");
  console.log("");

  const testStart: Vec3 = { x: position.x, y: position.y + 100, z: position.z };
  const testEnd: Vec3 = { x: position.x, y: position.y - 100, z: position.z };

  const traceResult = collision.trace(testStart, testEnd);
  console.log(`Trace from ${testStart.y.toFixed(1)} to ${testEnd.y.toFixed(1)}:`);
  console.log(`  Hit: ${traceResult.hit}`);
  console.log(`  Fraction: ${traceResult.fraction.toFixed(4)}`);
  if (traceResult.hitPoint) {
    console.log(
      `  Hit point: (${traceResult.hitPoint.x.toFixed(1)}, ${traceResult.hitPoint.y.toFixed(1)}, ${traceResult.hitPoint.z.toFixed(1)})`,
    );
  }
  console.log("");

  // === STEP SLIDE MOVE TEST ===
  console.log("=== StepSlideMove Test ===");
  console.log("");

  const slideStart: Vec3 = { ...spawnPos };
  const slideVel: Vec3 = { x: 100, y: -200, z: 100 }; // Moving forward with downward velocity
  const bounds = {
    min: { x: -16, y: -24, z: -16 },
    max: { x: 16, y: 32, z: 16 },
  };

  const slideResult = collision.stepSlideMove(slideStart, slideVel, deltaTime, bounds);
  console.log(
    `StepSlideMove from (${slideStart.x.toFixed(1)}, ${slideStart.y.toFixed(1)}, ${slideStart.z.toFixed(1)})`,
  );
  console.log(`  Input velocity: (${slideVel.x.toFixed(1)}, ${slideVel.y.toFixed(1)}, ${slideVel.z.toFixed(1)})`);
  console.log(
    `  Output position: (${slideResult.endPos.x.toFixed(1)}, ${slideResult.endPos.y.toFixed(1)}, ${slideResult.endPos.z.toFixed(1)})`,
  );
  console.log(
    `  Output velocity: (${slideResult.velocity.x.toFixed(1)}, ${slideResult.velocity.y.toFixed(1)}, ${slideResult.velocity.z.toFixed(1)})`,
  );
  console.log(`  Grounded: ${slideResult.grounded}`);
  console.log("");

  // Expected vs actual
  const expectedY = slideStart.y; // Should stay on ground
  const actualY = slideResult.endPos.y;
  if (Math.abs(expectedY - actualY) > 1) {
    console.log(
      `[WARNING] Y position changed significantly: expected ${expectedY.toFixed(1)}, got ${actualY.toFixed(1)}`,
    );
    console.log("          This suggests collision is NOT working!");
  } else {
    console.log(`[OK] Y position maintained: ${actualY.toFixed(1)} (spawn was ${expectedY.toFixed(1)})`);
  }
}

void runCli(runTest);
