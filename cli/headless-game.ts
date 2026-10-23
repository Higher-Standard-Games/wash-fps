/**
 * Headless Game Runner - Run the game engine in CLI mode
 *
 * Mirrors the real game startup sequence but in headless mode:
 * - Uses NullEngine (no WebGL)
 * - readline for console input
 * - All engine commands available
 * - writeconsole to dump output
 * - quit to exit
 *
 * Usage:
 *   npx vite-node src/games/fps/cli/headless-game.ts
 *   npx vite-node src/games/fps/cli/headless-game.ts --exec "map wdm11; bsp info"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Node } from "@babylonjs/core/node";
import { Scene } from "@babylonjs/core/scene";
import { formatPreflight, preflightGameAssets, resolveGameAssetDir } from "../../../cli/_assetPreflight";
import { runCli } from "../../../cli/_runCli";
import { VANGUARD_MODEL, VANGUARD_ROOT } from "../../../engine/animation/PlayerModelAssets";
import { fail } from "../../../engine/console/Command";
// Static imports for command system
import { registerEngineCommands } from "../../../engine/console/commands/index";
import type { EngineConfig } from "../../../engine/core/GamePaths";
import { registerGameMapEntities } from "../../../engine/loader/map/GameMapEntities";
import { PK3Loader } from "../../../engine/loader/pk3/PK3Loader";
import { registerWeaponIdResolver } from "../../../engine/weapon/WeaponIdResolver";
import GiveWeaponCommand from "../console/commands/GiveWeaponCommand";
import NameCommand from "../console/commands/NameCommand";
import SpawnPickupCommand from "../console/commands/SpawnPickupCommand";
import SpectatorCommand from "../console/commands/SpectatorCommand";
import { canonicalWeaponId } from "../shared/entities/definitions/weapons/WeaponsTable";
import { fpsMapEntities } from "../world/FpsMapEntities";

// ============================================================================
// Console Output Capture
// ============================================================================

const consoleHistory: string[] = [];
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

function captureConsole(): void {
  console.log = (...args: unknown[]) => {
    const line = args.map((a) => String(a)).join(" ");
    consoleHistory.push(line);
    originalConsoleLog.apply(console, args);
  };
  console.warn = (...args: unknown[]) => {
    const line = `[WARN] ${args.map((a) => String(a)).join(" ")}`;
    consoleHistory.push(line);
    originalConsoleWarn.apply(console, args);
  };
  console.error = (...args: unknown[]) => {
    const line = `[ERROR] ${args.map((a) => String(a)).join(" ")}`;
    consoleHistory.push(line);
    originalConsoleError.apply(console, args);
  };
}

// ============================================================================
// Headless Game Context
// ============================================================================

interface HeadlessContext {
  engine: NullEngine;
  scene: Scene;
  camera: FreeCamera;
}

let context: HeadlessContext | null = null;

async function initializeEngine(): Promise<HeadlessContext> {
  console.log("\n=== Headless Game Engine ===\n");
  console.log("[Init] Creating NullEngine...");

  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 100, -200), scene);

  console.log(`[Init] Engine created: ${engine.description}`);

  // Initialize CameraSystem so commands can find the scene
  try {
    const { CameraSystem } = await import("../../../engine/camera/CameraSystem");
    const cameraSystem = CameraSystem.getInstance();
    cameraSystem.init(scene, null); // headless has no canvas
    cameraSystem.setCamera(camera);
    console.log("[Init] CameraSystem initialized");
  } catch (e) {
    console.warn("[Init] CameraSystem init failed:", e);
  }

  // Initialize core and scene services
  try {
    const { GamePaths } = await import("../../../engine/core/GamePaths");
    const { ServiceLocator } = await import("../../../engine/core/ServiceLocator");
    const { registerEngineServices } = await import("../../../engine/core/EngineServices");

    // GamePaths is browser-shared and normally loads /engine.json with fetch.
    // The headless composition root owns filesystem access and injects the
    // same config before ServiceLocator initializes the shared singleton.
    const engineConfigPath = path.resolve(process.cwd(), "public/engine.json");
    const engineConfig = JSON.parse(fs.readFileSync(engineConfigPath, "utf8")) as EngineConfig;
    GamePaths.getInstance().initFromConfig(engineConfig);

    // Register engine services
    registerEngineServices();
    console.log("[Init] Engine services registered");

    // Initialize core services
    await ServiceLocator.getInstance().initCore();
    console.log("[Init] Core services initialized");

    // Initialize scene services
    await ServiceLocator.getInstance().initScene(scene);
    console.log("[Init] Scene services initialized");
  } catch (e) {
    console.warn("[Init] Services init failed:", e);
  }

  // Ensure cvar-providing services are instantiated (even if ServiceLocator failed)
  // This triggers cvar registration in their constructors
  try {
    const { RenderVars } = await import("../../../engine/rendering/RenderVars");
    RenderVars.getInstance();

    const { AudioManager } = await import("../../../engine/AudioManager");
    AudioManager.getInstance();

    const { MovementVars } = await import("../../../engine/movement/MovementVars");
    MovementVars.getInstance();

    console.log("[Init] Cvar providers initialized");
  } catch (e) {
    console.warn("[Init] Cvar providers failed:", e);
  }

  // Note: Havok physics requires browser environment (uses fetch for WASM)
  // In headless mode, we skip physics initialization
  console.log("[Init] Skipping Havok physics (requires browser environment)");

  return { engine, scene, camera };
}

async function initializeGameSystems(ctx: HeadlessContext): Promise<void> {
  console.log("[Init] Loading game systems...");

  // Initialize PK3 loader with game path (shared resolution + preflight).
  const gamePath = resolveGameAssetDir();
  console.log(`[Init] Game path: ${gamePath}`);

  const preflight = preflightGameAssets(gamePath);
  if (!preflight.ok) {
    // Not fatal at startup — asset-free commands (headless info, determinism)
    // still run, and asset-dependent commands surface their own failure and
    // gate the exit code (QA-23). Run `assets` explicitly for a hard gate.
    console.warn(`[Init] ${formatPreflight(preflight)}`);
    console.warn("[Init] Some commands may not work without PK3 files");
  }

  // Import and initialize systems
  try {
    // Load all PK3 files into PK3Loader + PK3Index (shared headless bootstrap).
    if (fs.existsSync(gamePath)) {
      const { ingestPk3Dir } = await import("../../../engine/loader/pk3/NodePk3");
      const loadedCount = await ingestPk3Dir(gamePath);
      console.log(`[Init] Indexed ${loadedCount} PK3 files from ${gamePath}`);
    }

    // Load shaders
    const { Q3ShaderRegistry } = await import("../../../engine/loader/shader/Q3ShaderRegistry");
    const shaderRegistry = Q3ShaderRegistry.getInstance();
    const shaderCount = await shaderRegistry.loadShaders();
    console.log(`[Init] Loaded ${shaderCount} shaders`);

    // Initialize ModelLoader for spawnmodel command
    const { ModelLoader } = await import("../../../engine/loader/model/ModelLoader");
    ModelLoader.getInstance().init(ctx.scene);
    console.log("[Init] ModelLoader initialized");
  } catch (error) {
    console.warn("[Init] Some systems failed to initialize:", error);
  }
}

async function registerCommands(_ctx: HeadlessContext): Promise<void> {
  registerGameMapEntities(fpsMapEntities);
  registerWeaponIdResolver(canonicalWeaponId);
  console.log("[Init] Registering commands...");

  // Register all engine commands
  await registerEngineCommands();
  console.log("[Init] Engine commands registered");

  // ============================================================================
  // Headless-specific Commands (override/extend engine commands)
  // ============================================================================

  const { CommandRegistry } = await import("../../../engine/console/CommandRegistry");
  const registry = CommandRegistry.getInstance();

  // This FPS composition keeps its game-specific camera/inventory commands.
  registry.register(new SpectatorCommand());
  registry.register(new GiveWeaponCommand());
  registry.register(new NameCommand());
  registry.register(new SpawnPickupCommand());

  registry.register("writeconsole", (args: string[]) => {
    const outputPath = args[0] || "console.log";
    fs.writeFileSync(outputPath, consoleHistory.join("\n"));
    return `Console output written to ${outputPath} (${consoleHistory.length} lines)`;
  });

  registry.register("quit", () => {
    console.log("\n[Headless] Shutting down...");
    if (context) {
      context.scene.dispose();
      context.engine.dispose();
    }
    // Preserve a failure code set by an earlier batch command — never force 0.
    process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
  });

  registry.register(
    "assets",
    () => {
      // Explicit, exit-code-observable asset gate: fails (exit 1 via runBatch)
      // when the resolved game dir has no PK3 data (QA-WO11 step 3).
      const result = preflightGameAssets();
      return result.ok ? formatPreflight(result) : fail(formatPreflight(result));
    },
    "Verify the headless game asset dir has PK3 data (fails the run when missing)",
  );

  registry.register("headless", (args: string[]) => {
    const sub = args[0]?.toLowerCase();
    switch (sub) {
      case "info":
        return [
          "Headless Game Engine",
          `  Engine: ${context?.engine.description || "N/A"}`,
          `  Scene: ${context?.scene.uid || "N/A"}`,
          `  Console history: ${consoleHistory.length} lines`,
        ].join("\n");
      case "history": {
        const count = parseInt(args[1], 10) || 20;
        return consoleHistory.slice(-count).join("\n");
      }
      default:
        return "Subcommands: info, history [count]";
    }
  });

  // Override version for headless mode
  registry.register("version", () => {
    return [
      "SHAG Engine - Headless Mode",
      `Babylon.js: ${context?.engine.description}`,
      `Node.js: ${process.version}`,
    ].join("\n");
  });

  registry.register("leaktest", async (args: string[]) => {
    const sub = args[0]?.toLowerCase();
    if (sub !== "maprenderer" && sub !== "mapcycle") {
      return [
        "Leak test commands:",
        "  leaktest maprenderer <iterations> [mapName]",
        "  leaktest mapcycle <iterations> <mapA> [mapB]",
      ].join("\n");
    }

    if (!context?.scene) {
      process.exitCode = 1;
      return "No scene available";
    }

    if (sub === "mapcycle") {
      const iterations = Math.max(1, parseInt(args[1] || "5", 10) || 5);
      const mapA = args[2];
      const mapB = args[3] || mapA;

      if (!mapA) {
        process.exitCode = 1;
        return "Usage: leaktest mapcycle <iterations> <mapA> [mapB]";
      }

      const scene = context.scene;

      const snapshot = () => ({
        meshes: scene.meshes.length,
        nodes: scene.transformNodes.length,
        lights: scene.lights.length,
        materials: scene.materials.length,
        textures: scene.textures.length,
      });

      const same = (a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>) =>
        a.meshes === b.meshes &&
        a.nodes === b.nodes &&
        a.lights === b.lights &&
        a.materials === b.materials &&
        a.textures === b.textures;

      const fmt = (s: ReturnType<typeof snapshot>) =>
        `m=${s.meshes} n=${s.nodes} l=${s.lights} mat=${s.materials} tex=${s.textures}`;

      // Establish baseline from a cleared scene.
      // Note: `scene clear` primarily disposes meshes/materials/textures. If a map leaves
      // lights/nodes behind, we want this strict test to catch it.
      await registry.execute("scene clear");
      const baseline = snapshot();
      console.log(`[LeakTest] Baseline: ${fmt(baseline)}`);

      let failures = 0;
      for (let i = 0; i < iterations; i++) {
        const mapName = i % 2 === 0 ? mapA : mapB;
        const loadResult = await registry.execute(`map ${mapName}`);
        if (typeof loadResult === "string" && loadResult.toLowerCase().startsWith("failed")) {
          failures++;
          console.log(`[LeakTest] Map load failed on iter ${i + 1}/${iterations}: ${loadResult}`);
          break;
        }

        // Unload and clear.
        await registry.execute("map unload");
        await registry.execute("scene clear");

        if (typeof globalThis.gc === "function") {
          try {
            globalThis.gc();
          } catch {
            // ignore
          }
        }

        const after = snapshot();
        const ok = same(after, baseline);
        console.log(
          `[LeakTest] Iter ${i + 1}/${iterations} map='${mapName}': after=${fmt(after)} ${ok ? "OK" : "MISMATCH"}`,
        );
        if (!ok) {
          failures++;
        }
      }

      if (failures > 0) {
        process.exitCode = 1;
        return `LeakTest FAILED (mapcycle) iterations=${iterations} failures=${failures}`;
      }

      return `LeakTest OK (mapcycle) iterations=${iterations} baseline=${fmt(baseline)}`;
    }

    const iterations = Math.max(1, parseInt(args[1] || "5", 10) || 5);
    const mapName = args[2] || "leaktest";

    const scene = context.scene;
    const { MapRenderer } = await import("../../../engine/MapRenderer");
    const { MeshBuilder } = await import("@babylonjs/core/Meshes/meshBuilder");
    const { TransformNode } = await import("@babylonjs/core/Meshes/transformNode");

    const ownedCounts = () => {
      const isOwned = (m: Node) => m?.metadata?.mapOwned && m?.metadata?.mapName === mapName;
      const ownedMeshes = scene.meshes.filter(isOwned);
      const ownedNodes = scene.transformNodes.filter(isOwned);
      const ownedLights = scene.lights.filter(isOwned);
      return {
        meshes: ownedMeshes.length,
        nodes: ownedNodes.length,
        lights: ownedLights.length,
        total: ownedMeshes.length + ownedNodes.length + ownedLights.length,
      };
    };

    let failures = 0;
    for (let i = 0; i < iterations; i++) {
      await MapRenderer.renderEntities(
        [
          {
            classname: "light",
            properties: {
              origin: "0 0 0",
              light: "300",
            },
            brushes: [],
            patches: [],
          },
        ],
        scene,
        mapName,
      );

      const box = MeshBuilder.CreateBox(`leaktest_box_${i}`, { size: 1 }, scene);
      box.metadata = { mapOwned: true, mapName };

      const node = new TransformNode(`leaktest_node_${i}`, scene);
      node.metadata = { mapOwned: true, mapName };

      const before = ownedCounts();
      MapRenderer.clearMap(scene, mapName);
      const after = ownedCounts();

      console.log(
        `[LeakTest] Iter ${i + 1}/${iterations} map='${mapName}': before=${before.total} (m=${before.meshes},n=${before.nodes},l=${before.lights}) after=${after.total} (m=${after.meshes},n=${after.nodes},l=${after.lights})`,
      );

      if (after.total !== 0) {
        failures++;
      }

      const clustered = scene.metadata?.clusteredLightContainer;
      if (clustered) {
        failures++;
        console.log("[LeakTest] ClusteredLightContainer still present after clearMap");
      }
    }

    const final = ownedCounts();
    const ok = failures === 0 && final.total === 0;
    if (!ok) {
      process.exitCode = 1;
    }

    return ok
      ? `LeakTest OK (maprenderer) iterations=${iterations} map='${mapName}'`
      : `LeakTest FAILED (maprenderer) iterations=${iterations} map='${mapName}' remaining=${final.total} failures=${failures}`;
  });

  // Collision trace test command
  registry.register("trace_test", async (args: string[]) => {
    const sub = args[0]?.toLowerCase();

    // Import collision manager
    const { getCollisionManager } = await import("../../../engine/physics/CollisionManager");
    const cm = getCollisionManager();

    if (!cm.isInitialized()) {
      return "Collision not initialized. Load a map first with 'map <mapname>'";
    }

    if (sub === "point") {
      // trace_test point x y z dx dy dz [dist]
      const x = parseFloat(args[1]) || 0;
      const y = parseFloat(args[2]) || 0;
      const z = parseFloat(args[3]) || 0;
      const dx = parseFloat(args[4]) || 0;
      const dy = parseFloat(args[5]) || -1; // Default: trace down
      const dz = parseFloat(args[6]) || 0;
      const dist = parseFloat(args[7]) || 1000;

      const start = new Vector3(x, y, z);
      const dir = new Vector3(dx, dy, dz).normalize();
      const end = start.add(dir.scale(dist));

      console.log(`[TraceTest] Point trace from (${x}, ${y}, ${z}) dir (${dx}, ${dy}, ${dz}) dist ${dist}`);

      const result = cm.trace(start as never, end as never, { debug: true });

      return [
        `Start: (${start.x.toFixed(2)}, ${start.y.toFixed(2)}, ${start.z.toFixed(2)})`,
        `End: (${end.x.toFixed(2)}, ${end.y.toFixed(2)}, ${end.z.toFixed(2)})`,
        `Fraction: ${result.fraction.toFixed(4)}`,
        `Hit: ${result.fraction < 1.0 ? "YES" : "NO"}`,
        `StartSolid: ${result.startSolid}`,
        `EndPos: (${result.endPos.x.toFixed(2)}, ${result.endPos.y.toFixed(2)}, ${result.endPos.z.toFixed(2)})`,
        result.normal
          ? `Normal: (${result.normal.x.toFixed(3)}, ${result.normal.y.toFixed(3)}, ${result.normal.z.toFixed(3)})`
          : "Normal: none",
      ].join("\n");
    }

    if (sub === "box") {
      // trace_test box x y z dx dy dz [dist] [radius] [height]
      const x = parseFloat(args[1]) || 0;
      const y = parseFloat(args[2]) || 0;
      const z = parseFloat(args[3]) || 0;
      const dx = parseFloat(args[4]) || 0;
      const dy = parseFloat(args[5]) || -1;
      const dz = parseFloat(args[6]) || 0;
      const dist = parseFloat(args[7]) || 1000;
      const radius = parseFloat(args[8]) || 16;
      const height = parseFloat(args[9]) || 56;

      const start = new Vector3(x, y, z);
      const dir = new Vector3(dx, dy, dz).normalize();
      const end = start.add(dir.scale(dist));

      console.log(
        `[TraceTest] Box trace from (${x}, ${y}, ${z}) dir (${dx}, ${dy}, ${dz}) dist ${dist} radius=${radius} height=${height}`,
      );

      const result = cm.trace(start as never, end as never, { debug: true, radius, height });

      return [
        `Start: (${start.x.toFixed(2)}, ${start.y.toFixed(2)}, ${start.z.toFixed(2)})`,
        `End: (${end.x.toFixed(2)}, ${end.y.toFixed(2)}, ${end.z.toFixed(2)})`,
        `Hull: radius=${radius}, height=${height}`,
        `Fraction: ${result.fraction.toFixed(4)}`,
        `Hit: ${result.fraction < 1.0 ? "YES" : "NO"}`,
        `StartSolid: ${result.startSolid}`,
        `EndPos: (${result.endPos.x.toFixed(2)}, ${result.endPos.y.toFixed(2)}, ${result.endPos.z.toFixed(2)})`,
        result.normal
          ? `Normal: (${result.normal.x.toFixed(3)}, ${result.normal.y.toFixed(3)}, ${result.normal.z.toFixed(3)})`
          : "Normal: none",
      ].join("\n");
    }

    if (sub === "spawn") {
      // trace_test spawn - test collision at all spawn points
      const { MapLoader } = await import("../../../engine/loader/map/MapLoader");
      const bsp = MapLoader.getInstance().getCurrentBsp();
      if (!bsp) return "No BSP loaded";

      const spawns = bsp.entities.filter(
        (e) => e.classname === "info_player_deathmatch" || e.classname === "info_player_start",
      );

      if (spawns.length === 0) return "No spawn points found";

      const lines: string[] = [`Found ${spawns.length} spawn points:`, ""];

      for (let i = 0; i < Math.min(spawns.length, 5); i++) {
        const spawn = spawns[i];
        const origin = spawn.properties.origin?.split(" ").map(Number) || [0, 0, 0];
        // BSP entities are in Q3 coords, convert to Babylon
        const pos = new Vector3(origin[0], origin[2], origin[1]);

        // Trace down from spawn
        const downEnd = pos.add(new Vector3(0, -100, 0));
        const downResult = cm.trace(pos as never, downEnd as never, { debug: false, radius: 16, height: 56 });

        // Trace forward (Z in Babylon)
        const fwdEnd = pos.add(new Vector3(0, 0, 100));
        const fwdResult = cm.trace(pos as never, fwdEnd as never, { debug: false, radius: 16, height: 56 });

        lines.push(
          `Spawn ${i + 1}: Q3(${origin[0]}, ${origin[1]}, ${origin[2]}) → Babylon(${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)})`,
        );
        lines.push(`  Down: frac=${downResult.fraction.toFixed(3)}, startSolid=${downResult.startSolid}`);
        lines.push(`  Forward: frac=${fwdResult.fraction.toFixed(3)}, startSolid=${fwdResult.startSolid}`);
        lines.push("");
      }

      return lines.join("\n");
    }

    if (sub === "compare") {
      // trace_test compare - compare Q3 coords vs Babylon coords for brushes
      const { MapLoader } = await import("../../../engine/loader/map/MapLoader");
      const bsp = MapLoader.getInstance().getCurrentBsp();
      if (!bsp) return "No BSP loaded";

      const lines: string[] = ["BSP Coordinate Analysis:", ""];

      // Sample a few brushes and their planes
      const sampleBrushes = bsp.brushes.slice(0, 3);
      for (let bi = 0; bi < sampleBrushes.length; bi++) {
        const brush = sampleBrushes[bi];
        const texture = bsp.textures[brush.shaderIndex];
        lines.push(`Brush ${bi}: shader="${texture?.name}", sides=${brush.numSides}`);

        for (let si = 0; si < Math.min(brush.numSides, 3); si++) {
          const side = bsp.brushSides[brush.firstSide + si];
          const plane = bsp.planes[side.planeIndex];
          lines.push(
            `  Plane ${si}: normal=(${plane.normal[0].toFixed(3)}, ${plane.normal[1].toFixed(3)}, ${plane.normal[2].toFixed(3)}), dist=${plane.dist.toFixed(1)}`,
          );
        }
        lines.push("");
      }

      // Check first few vertices for coordinate reference
      if (bsp.vertices.length > 0) {
        lines.push("Sample vertices (Q3 format in BSP):");
        for (let vi = 0; vi < Math.min(5, bsp.vertices.length); vi++) {
          const v = bsp.vertices[vi];
          lines.push(
            `  V${vi}: (${v.position[0].toFixed(1)}, ${v.position[1].toFixed(1)}, ${v.position[2].toFixed(1)})`,
          );
        }
      }

      return lines.join("\n");
    }

    return [
      "Collision trace testing commands:",
      "  trace_test point x y z dx dy dz [dist] - Point trace",
      "  trace_test box x y z dx dy dz [dist] [radius] [height] - Box trace",
      "  trace_test spawn - Test traces at spawn points",
      "  trace_test compare - Compare coordinate systems",
    ].join("\n");
  });

  // ============================================================================
  // Animation Inspection (built-in — no scratch scripts needed!)
  // ============================================================================

  registry.register("anim", async (args: string[]) => {
    const sub = args[0]?.toLowerCase();

    if (sub === "inspect") {
      const fileName = args[1];
      const loader = PK3Loader.getInstance();

      // Determine files to inspect
      let files: string[];
      if (!fileName || fileName === "all") {
        files = loader.listFiles().filter((file) => file.startsWith(VANGUARD_ROOT) && file.endsWith(".glb"));
      } else {
        const fullPath = fileName.includes("/") || fileName.includes("\\") ? fileName : VANGUARD_ROOT + fileName;
        if (!loader.hasFile(fullPath) && !fs.existsSync(fullPath)) {
          return `File not found: ${fullPath}`;
        }
        files = [fullPath];
      }

      if (files.length === 0) return "No .glb files found.";

      // We need a fresh scene for inspection (don't pollute main scene)
      const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine");
      const { Scene } = await import("@babylonjs/core/scene");
      const { ImportAnimationsAsync, ImportMeshAsync } = await import("@babylonjs/core/Loading/sceneLoader");
      await import("@babylonjs/loaders/glTF");

      const inspectEngine = new NullEngine();
      const inspectScene = new Scene(inspectEngine);

      // Try loading the model first for bone names
      const modelBuf = await loader.getFile(VANGUARD_ROOT + VANGUARD_MODEL);
      if (modelBuf) {
        try {
          const modelB64 = Buffer.from(new Uint8Array(modelBuf)).toString("base64");
          await ImportMeshAsync(`data:;base64,${modelB64}`, inspectScene, { pluginExtension: ".glb" });
          // Stop embedded animations
          for (const g of inspectScene.animationGroups) g.stop();
          inspectScene.animationGroups.slice().forEach((g) => {
            g.dispose();
          });
        } catch {
          // Continue without model — targets will show as 'unknown'
        }
      }

      const results: string[] = [];
      results.push(`\n=== Animation Inspector (${files.length} files) ===\n`);

      for (const file of files) {
        try {
          const buf = loader.hasFile(file) ? await loader.getFile(file) : fs.readFileSync(file);
          if (!buf) throw new Error(`Player asset missing: ${file}`);
          const b64 = Buffer.from(new Uint8Array(buf)).toString("base64");
          await ImportAnimationsAsync(`data:;base64,${b64}`, inspectScene, {
            overwriteAnimations: false,
            pluginExtension: ".glb",
          });

          // Old static API returned the scene — iterate the scene's groups.
          for (const group of inspectScene.animationGroups) {
            const total = group.targetedAnimations.length;
            const positionTracks: string[] = [];

            for (const ta of group.targetedAnimations) {
              const targetName = ta.target?.name ?? "unknown";
              const prop = ta.animation.targetProperty;
              if (prop === "position") {
                const keys = ta.animation.getKeys();
                const first = keys[0]?.value;
                const last = keys[keys.length - 1]?.value;
                const drift = Math.sqrt(
                  ((last?.x ?? 0) - (first?.x ?? 0)) ** 2 +
                    ((last?.y ?? 0) - (first?.y ?? 0)) ** 2 +
                    ((last?.z ?? 0) - (first?.z ?? 0)) ** 2,
                );
                positionTracks.push(`    "${targetName}".position (${keys.length} keys, drift=${drift.toFixed(3)})`);
              }
            }

            const marker = positionTracks.length > 0 ? "⚠️" : "✅";
            results.push(
              `${marker} ${path.basename(file)} (${total} channels, ${positionTracks.length} position tracks)`,
            );
            for (const pt of positionTracks) {
              results.push(pt);
            }

            group.stop();
            group.dispose();
          }
        } catch (err) {
          results.push(`❌ ${path.basename(file)}: ${(err as Error).message}`);
        }
      }

      // Cleanup
      inspectScene.dispose();
      inspectEngine.dispose();

      return results.join("\n");
    }

    if (sub === "bones") {
      // List skeleton bones from model
      const modelBuf = await PK3Loader.getInstance().getFile(VANGUARD_ROOT + VANGUARD_MODEL);
      if (!modelBuf) {
        return "Player model not found in the loaded PK3 assets";
      }

      const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine");
      const { Scene } = await import("@babylonjs/core/scene");
      const { ImportMeshAsync } = await import("@babylonjs/core/Loading/sceneLoader");
      await import("@babylonjs/loaders/glTF");

      const inspectEngine = new NullEngine();
      const inspectScene = new Scene(inspectEngine);

      const modelB64 = Buffer.from(new Uint8Array(modelBuf)).toString("base64");
      const result = await ImportMeshAsync(`data:;base64,${modelB64}`, inspectScene, { pluginExtension: ".glb" });

      const lines: string[] = [`\nSkeleton Bones (${result.skeletons[0]?.bones.length ?? 0}):\n`];
      if (result.skeletons[0]) {
        for (const bone of result.skeletons[0].bones) {
          const depth = bone.getParent() ? "  " : "";
          lines.push(`${depth}${bone.name}`);
        }
      }

      inspectScene.dispose();
      inspectEngine.dispose();
      return lines.join("\n");
    }

    return [
      "Animation tools:",
      "  anim inspect [file|all]    Inspect animation channels (flags position/root-motion tracks)",
      "  anim bones                 List skeleton bones from model",
    ].join("\n");
  });

  // ============================================================================
  // Physics Simulation Replay
  // ============================================================================

  registry.register("sim", async (args: string[]) => {
    const sub = args[0]?.toLowerCase();

    if (sub === "replay") {
      // Parse input sequence: "W+CROUCH 60; JUMP 1; W 30"
      const inputStr = args.slice(1).join(" ");
      if (!inputStr) {
        return [
          "Usage: sim replay <input-sequence>",
          "",
          "Input format: KEY[+KEY...] TICKS[; KEY TICKS; ...]",
          "Keys: W, A, S, D, JUMP, CROUCH",
          "",
          "Examples:",
          "  sim replay W 60                        Run forward 60 ticks",
          "  sim replay W+CROUCH 60; JUMP 1; W 30   Crouch-run, jump, continue",
          "  sim replay W+JUMP 120                  Bunny hop for 2 seconds",
        ].join("\n");
      }

      try {
        const { Simulation } = await import("../../../engine/server/core/Simulation");
        const { createPlayerEntity } = await import("../../../engine/server/ecs/Entity");
        const { entityId, playerId } = await import("../../../engine/server/ecs/types");
        const { CharacterPhysicsSystem } = await import("../server/systems/CharacterPhysicsSystem");

        const sim = new Simulation({ tickMs: 8 }); // 125Hz
        sim.addSubsystem(new CharacterPhysicsSystem());
        sim.initialize();

        const state = sim.getStateMut();
        const player = createPlayerEntity(entityId(1), playerId(1), { x: 0, y: 100, z: 0 });
        state.addEntity(player);

        // Parse sequences
        const sequences = inputStr
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean);
        const lines: string[] = [`\n=== Simulation Replay (125Hz) ===\n`];
        lines.push(`Input: ${inputStr}\n`);
        lines.push("Tick   Position (x, y, z)                 Velocity (x, y, z)                 Grounded  State");
        lines.push("─".repeat(120));

        let totalTick = 0;

        for (const seq of sequences) {
          const parts = seq.trim().split(/\s+/);
          const keyStr = parts[0].toUpperCase();
          const ticks = parseInt(parts[1], 10) || 1;
          const keys = keyStr.split("+");

          for (let t = 0; t < ticks; t++) {
            // Set input
            const p = state.getEntityMut(player.id);
            if (p?.input) {
              p.input.forward = keys.includes("W") ? 1 : keys.includes("S") ? -1 : 0;
              p.input.right = keys.includes("D") ? 1 : keys.includes("A") ? -1 : 0;
              p.input.jump = keys.includes("JUMP");
              p.input.crouch = keys.includes("CROUCH");
            }

            sim.tick();
            totalTick++;

            // Print state at intervals or first/last tick of each sequence
            const finalState = sim.getState();
            const fp = finalState.getEntity(player.id);
            if (fp?.transform && fp?.physics) {
              const pos = fp.transform.position;
              const vel = fp.physics.velocity;
              const grounded = fp.physics.grounded ? "✓" : " ";
              const crouching = fp.physics.isCrouching ? "C" : " ";
              const sliding = fp.physics.isSliding ? "S" : " ";

              // Print every 10 ticks, plus first and last
              if (t === 0 || t === ticks - 1 || totalTick % 10 === 0) {
                lines.push(
                  `${totalTick.toString().padStart(5)}  ` +
                    `(${pos.x.toFixed(2).padStart(8)}, ${pos.y.toFixed(2).padStart(8)}, ${pos.z.toFixed(2).padStart(8)})  ` +
                    `(${vel.x.toFixed(2).padStart(8)}, ${vel.y.toFixed(2).padStart(8)}, ${vel.z.toFixed(2).padStart(8)})  ` +
                    `${grounded.padStart(8)}  ${crouching}${sliding}`,
                );
              }
            }
          }
        }

        lines.push("");
        lines.push(`Total: ${totalTick} ticks (${((totalTick * 8) / 1000).toFixed(2)}s)`);
        return lines.join("\n");
      } catch (err) {
        return `Simulation error: ${(err as Error).message}`;
      }
    }

    return [
      "Simulation tools:",
      "  sim replay <input-sequence>   Run physics simulation with specified inputs",
      "",
      "Input format: KEY[+KEY...] TICKS[; KEY TICKS; ...]",
      "Keys: W, A, S, D, JUMP, CROUCH",
    ].join("\n");
  });

  // Help command for headless mode
  registry.register("help", (args: string[]) => {
    const cmdName = args[0]?.toLowerCase();

    if (cmdName) {
      // Show help for specific command
      const def = registry.getDefinition(cmdName);
      if (!def) {
        return `Unknown command: ${cmdName}`;
      }

      let result = `${def.name}: ${def.description}`;
      if (def.usage) {
        result += `\nUsage: ${def.usage}`;
      }
      if (def.subcommands && def.subcommands.length > 0) {
        result += "\n\nSubcommands:";
        for (const sub of def.subcommands) {
          result += `\n  ${sub.name} - ${sub.description}`;
        }
      }
      return result;
    }

    // Show all commands
    const defs = registry.getAllDefinitions();
    const lines = ["Available commands:", ""];

    for (const def of defs.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))) {
      lines.push(`  ${def.name.padEnd(15)} ${def.description}`);
    }

    lines.push("");
    lines.push("Type 'help <command>' for detailed help");

    return lines.join("\n");
  });

  console.log(`[Init] Commands registered: ${registry.getCommands().size}`);
}

// ============================================================================
// REPL (Read-Eval-Print Loop)
// ============================================================================

async function runREPL(): Promise<void> {
  const { CommandRegistry } = await import("../../../engine/console/CommandRegistry");
  const registry = CommandRegistry.getInstance();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  console.log("\n[Ready] Type commands, 'help' for list, 'quit' to exit\n");
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();

    if (input) {
      try {
        const result = await registry.execute(input);
        if (result) {
          console.log(result);
        }
      } catch (error) {
        console.error("Error:", error);
      }
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\n[Headless] Goodbye!");
    process.exit(0);
  });
}

async function runBatch(commands: string): Promise<void> {
  const { CommandRegistry } = await import("../../../engine/console/CommandRegistry");
  const registry = CommandRegistry.getInstance();

  console.log(`\n[Batch] Executing: ${commands}\n`);

  const { splitCommandBatch } = await import("../../../engine/console/CommandBatch");
  const parts = splitCommandBatch(commands);

  for (const cmd of parts) {
    const { ok, output } = await registry.executeChecked(cmd);
    if (output) {
      console.log(output);
    }
    if (!ok) {
      // A required batch command failed — make the process observably fail
      // instead of exiting 0 (QA-23). Later commands still run (e.g. diagnostic
      // "bsp info; quit") but the failure code persists.
      console.error(`[Headless] Command failed: ${cmd}`);
      process.exitCode = 1;
    }
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  // Start capturing console output
  captureConsole();

  // Parse arguments
  const args = process.argv.slice(2);
  const commandList: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--exec" || args[i] === "--command") && args[i + 1]) {
      commandList.push(args[i + 1]);
      i++;
    }
  }

  const execCommands = commandList.length > 0 ? commandList.join("; ") : null;

  try {
    // Initialize engine
    context = await initializeEngine();

    // Initialize game systems (PK3, shaders, etc.)
    await initializeGameSystems(context);

    // Register commands
    await registerCommands(context);

    console.log("\n[Init] Startup complete!\n");

    if (execCommands) {
      // Batch mode - execute commands and exit
      await runBatch(execCommands);
      console.log("\n[Headless] Batch complete, exiting.");
      // Preserve a failure code set by a failed batch command (QA-23).
      process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
    } else {
      // Interactive mode - REPL
      await runREPL();
    }
  } catch (error) {
    console.error("[Fatal] Initialization failed:", error);
    process.exit(1);
  }
}

// Run
void runCli(main);
