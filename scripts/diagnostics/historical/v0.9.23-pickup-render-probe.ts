/**
 * v0.9.23 pickup render probe: map weapons through the game's own spawn path.
 *
 * Run from the repository root:
 *   npx vite-node src/games/fps/scripts/diagnostics/historical/v0.9.23-pickup-render-probe.ts -- --map=wdm2
 *
 * Loads the map's real entities, preloads the weapon GLBs the way AssetPreloader
 * does, spawns every weapon through EntityManager.spawnEntity into real
 * FPSPickups on floors at the BSP's floor heights, and reconciles the server
 * active-set, including a bot taking a rocket launcher and it respawning. A real
 * DroppedWeaponRenderer drop is spawned beside it. Then a second join: the scene
 * clear loadClientMap runs, the map unload, and the same preload and spawn again.
 * Each item is rendered with a camera aimed at it and reported with pickup_audit's
 * own line. NullEngine compiles no shaders, so this checks geometry, transforms,
 * enabled state, culling and physics — not what a GPU draws.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Logger } from "@babylonjs/core/Misc/logger";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import "@babylonjs/core/Physics/v2/physicsEngineComponent";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";
import { Scene } from "@babylonjs/core/scene";
import HavokPhysics from "@babylonjs/havok";
import "@babylonjs/loaders/glTF";
import type { EntityData } from "../../../../../engine/core/EntityHandlerRegistry";
import { EntityManager } from "../../../../../engine/entities/EntityManager";
import { AssetPreloader } from "../../../../../engine/loader/AssetPreloader";
import { type BspFile, BspLoader } from "../../../../../engine/loader/bsp/BspLoader";
import { collectModelAttachmentPoints, type ModelLoadResult } from "../../../../../engine/loader/model/ModelLoader";
import type { ModelSourceCache } from "../../../../../engine/loader/model/ModelSourceCache";
import { resolveMapBspViaIndex } from "../../../../../engine/loader/pk3/NodePk3";
import { PhysicsSystem } from "../../../../../engine/physics/PhysicsSystem";
import { DroppedWeaponRenderer } from "../../../client/DroppedWeaponRenderer";
import { FPSPickup } from "../../../world/FPSPickup";
import { CLASSNAME_TO_WEAPON, extractPickups, type PickupEntry } from "../../../../../shared/bsp/PickupTable";
import { initializeEntityDefs } from "../../../../../shared/entities/index";
import type { EntityDef } from "../../../../../shared/entities/EntityDef";
import { EntityRegistry } from "../../../../../shared/entities/EntityRegistry";

Logger.LogLevels = 0;
const quiet = { log: console.log, warn: console.warn };
const print = (...args: unknown[]) => quiet.log(...args);

type V3 = [number, number, number];

/** Highest render-surface height under (x, y) no higher than `top`, in Q3 coordinates. */
function floorBelow(bsp: BspFile, x: number, y: number, top: number): number | null {
  let best: number | null = null;
  const pos = (i: number) => bsp.vertices[i].position as V3;
  const world = bsp.models[0];
  for (let f = world.firstFace; f < world.firstFace + world.numFaces; f++) {
    const face = bsp.faces[f];
    if (face.faceType !== 1 && face.faceType !== 3) continue;
    for (let k = 0; k + 2 < face.numMeshVerts; k += 3) {
      const [a, b, c] = [0, 1, 2].map((n) => pos(face.firstVertex + bsp.meshVerts[face.firstMeshVert + k + n]));
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
      const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const z = l1 * a[2] + l2 * b[2] + l3 * c[2];
      if (z <= top && (best === null || z > best)) best = z;
    }
  }
  return best;
}

async function main() {
  const map = process.argv.find((arg) => arg.startsWith("--map="))?.slice("--map=".length) ?? "wdm2";
  console.log = () => {};
  console.warn = () => {};

  const buffer = await resolveMapBspViaIndex([path.resolve("public/data")], map);
  if (!buffer) throw new Error(`${map}.bsp not found`);
  const bsp = BspLoader.load(buffer);
  initializeEntityDefs();
  const registry = EntityRegistry.getInstance();
  const weapons = bsp.entities.filter((e) => CLASSNAME_TO_WEAPON[e.classname] && e.properties.origin);

  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("probe_camera", new Vector3(0, 2000, 0), scene);
  camera.maxZ = 100000;
  scene.activeCamera = camera;

  // Havok as PhysicsSystem.enablePhysics sets it up, plus RagdollSystem's velocity limit.
  const wasmBinary = fs.readFileSync(path.resolve("node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm"));
  const havok = await (HavokPhysics as unknown as (options: object) => Promise<unknown>)({ wasmBinary });
  const plugin = new HavokPlugin(true, havok);
  scene.enablePhysics(new Vector3(0, -1000, 0), plugin);
  const physics = scene.getPhysicsEngine() as unknown as {
    _step(dt: number): void;
    setVelocityLimits(linear: number, angular: number): void;
  };
  physics.setVelocityLimits(10000, 100);
  Object.assign(PhysicsSystem.getInstance(), { havokInstance: havok, havokPlugin: plugin, scene, initialized: true });
  const frames = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      physics._step(1 / 60);
      scene.render();
    }
  };

  // Static trimesh floors where BspMeshBuilder puts world collision under each spawn.
  const buildFloors = () => {
    weapons.forEach((entity, i) => {
      const [x, y, z] = entity.properties.origin.split(" ").map(Number);
      const floor = floorBelow(bsp, x, y, z + 40) ?? z;
      const box = MeshBuilder.CreateBox(`probe_floor_${i}`, { width: 160, height: 8, depth: 160 }, scene);
      box.position.set(x, floor - 4, y);
      box.computeWorldMatrix(true);
      new PhysicsAggregate(box, PhysicsShapeType.MESH, { mass: 0 }, scene);
    });
  };

  // AssetPreloader.preloadFromBsp's GLB branch, fed from disk instead of a URL.
  const cache = (AssetPreloader.getInstance() as unknown as { modelCache: ModelSourceCache<ModelLoadResult> })
    .modelCache;
  const modelPaths = new Set(
    weapons
      .map((e) => (registry.getByClassname(e.classname) as { modelPath?: string } | undefined)?.modelPath)
      .filter((p): p is string => !!p),
  );
  const preload = async () => {
    for (const modelPath of modelPaths) {
      if (cache.has(modelPath)) continue;
      const glb = await ImportMeshAsync(new Uint8Array(fs.readFileSync(path.join("public", modelPath))), scene, {
        pluginExtension: ".glb",
      });
      const root = glb.meshes[0];
      const meshes = glb.meshes.filter((m) => m.getTotalVertices() > 0) as Mesh[];
      root.setEnabled(false);
      for (const mesh of meshes) {
        mesh.setEnabled(false);
        mesh.isVisible = false;
      }
      cache.set(modelPath, {
        root,
        meshes,
        animationGroups: glb.animationGroups,
        skeletons: glb.skeletons,
        lights: [],
        attachmentPoints: collectModelAttachmentPoints(glb.transformNodes),
      });
    }
  };

  // EntityManager's own map spawn, as MapLoader dispatches it.
  const table = extractPickups(bsp.entities);
  const entities = EntityManager.getInstance() as unknown as {
    pickupTable: PickupEntry[];
    spawnEntity(def: EntityDef, data: EntityData, scene: Scene): Promise<unknown>;
  };
  const mask = table.map(() => true);
  const spawn = async () => {
    entities.pickupTable = table;
    for (const entity of weapons) {
      const def = registry.getByClassname(entity.classname);
      if (def) await entities.spawnEntity(def, { classname: entity.classname, properties: entity.properties }, scene);
    }
    FPSPickup.reconcileActiveSet([...mask]);
    frames(3);
  };

  const P = FPSPickup as unknown as { allPickups: Set<FPSPickup>; describeForAudit(pickup: FPSPickup): string };
  const aimAt = (mesh: Mesh | null) => {
    if (!mesh) return;
    const at = mesh.getAbsolutePosition();
    camera.position.set(at.x + 120, at.y + 60, at.z + 120);
    camera.setTarget(at);
  };
  const report = (label: string) => {
    print(`\n-- ${map}: ${label}`);
    for (const pickup of P.allPickups) {
      aimAt((pickup as unknown as { mesh: Mesh | null }).mesh);
      scene.render();
      print(`   ${P.describeForAudit(pickup)}`);
    }
  };

  buildFloors();
  await preload();
  await spawn();
  report("weapons after spawning");

  const rockets = table.filter((entry) => entry.classname === "weapon_rocketlauncher");
  if (rockets.length > 0) {
    mask[rockets[0].id] = false;
    FPSPickup.reconcileActiveSet([...mask]);
    frames(1);
    mask[rockets[0].id] = true;
    FPSPickup.reconcileActiveSet([...mask]);
    frames(1);
    report(`after a bot takes rocket launcher #${rockets[0].id} and it respawns`);

    const dropped = new DroppedWeaponRenderer(scene);
    const spot = rockets[0].position;
    dropped.syncServerEntities(
      new Map([["item_90001", { x: spot.x + 64, y: spot.y + 40, z: spot.z, weaponId: "rlauncher" }]]),
    );
    const visual = () =>
      (dropped as unknown as { weapons: Map<string, { mesh: Mesh | null }> }).weapons.get("item_90001");
    for (let i = 0; i < 100 && !visual()?.mesh; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    frames(3);
    aimAt(visual()?.mesh ?? null);
    scene.render();
    print(`\n-- ${map}: a dropped rocket launcher beside it`);
    print(`   ${DroppedWeaponRenderer.auditModelState()}`);
    dropped.dispose();
  }

  // The next join. loadClientMap's scene clear disposes every mesh with its
  // materials and textures, and MapLoader.disposeCurrentMap then releases the
  // map's entities and preloaded models. The next map load preloads and spawns.
  for (const mesh of [...scene.meshes]) mesh.dispose(false, true);
  EntityManager.getInstance().disposeMapEntities();
  AssetPreloader.getInstance().clearCache();
  buildFloors();
  await preload();
  await spawn();
  report("after a second join");

  engine.dispose();
}

main()
  .catch((error) => {
    quiet.warn(error);
    process.exitCode = 1;
  })
  .finally(() => {
    // Settle checks and proximity timers would otherwise keep the process alive.
    setTimeout(() => process.exit(process.exitCode ?? 0), 100);
  });
