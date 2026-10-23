/**
 * HeadlessMapLoader — load a map's BSP + collision + spawns + pickups + PVS for
 * a headless GameServer, resolving the BSP through the same pk3 index the game
 * uses (see NodePk3). Shared by the dedicated server CLI and the demo recorder.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { markServerMemory } from "../../../cli/ServerMemoryMarker";
import type { BspEntity, BspModel } from "../../../engine/loader/bsp/BspLoader";
import { resolveMapBspViaIndex } from "../../../engine/loader/pk3/NodePk3";
import { PK3Loader } from "../../../engine/loader/pk3/PK3Loader";
import type { CollisionWorld } from "../../../engine/network/systems/collision/CollisionWorld";
import { extractSpawnPoints, extractTeamSpawnPoints, type SpawnVec3 } from "../../../shared/bsp/SpawnPointTable";
import type { TriggerVolume } from "../../../shared/bsp/TriggerTable";
import { extractTriggerVolumes } from "../../../shared/bsp/TriggerTable";
import type { PickupEntry } from "../shared/bsp/PickupTable";
import { extractPickups } from "../shared/bsp/PickupTable";
import { landMapPickups } from "../shared/items/ItemThrow";

export interface BspData {
  /** Exact map bytes used for this match, not a hash computed later during export. */
  bspSha256?: string;
  collision: CollisionWorld;
  spawnPoints: Array<{ x: number; y: number; z: number }>;
  /** Team-tagged spawns (Warsow team_CTF_*spawn), empty on non-team maps. */
  teamSpawnPoints: Map<string, SpawnVec3[]>;
  /** Authoritative pickup table (weapons/armor/health) shared with the client. */
  pickups: PickupEntry[];
  /** Trigger volumes (teleporters/jumppads) — shared TriggerTable, same ids as the client. */
  triggers: TriggerVolume[];
  /** PVS data for server-side network visibility culling */
  pvs: import("../../../engine/server/ServerPVS").ServerPVSData | null;
  /** Raw entity lump, for gametypes that read their own map authoring. */
  entities: BspEntity[];
  /** Raw model lump, for entities whose `model` is a `*N` brush reference. */
  models: BspModel[];
}

export async function loadBspCollision(mapName: string, gamePath = "./game"): Promise<BspData | null> {
  console.log(`[Map] Loading BSP: ${mapName}`);

  const gameDir = gamePath.endsWith(".json") ? path.dirname(gamePath) : gamePath;

  // Resolve the map's BSP through the SAME pk3 index the game uses (no ad-hoc
  // path search). Reads only the pk3(s) needed to find this map.
  const candidateDirs = [path.resolve("./public/data"), path.resolve("./dist/data"), gameDir];
  const bspBuffer = await resolveMapBspViaIndex(candidateDirs, mapName, PK3Loader.createTransient());

  if (!bspBuffer) {
    console.warn(`[Map] Could not find BSP for map "${mapName}" via pk3 index (dirs: ${candidateDirs.join(", ")})`);
    return null;
  }

  markServerMemory("bsp-extracted", { map: mapName, bspBytes: bspBuffer.byteLength });

  const { BspLoader } = await import("../../../engine/loader/bsp/BspLoader");
  const { createHeadlessCollisionWorld } = await import("../../../cli/HeadlessBSPCollisionWorld");

  const bsp = BspLoader.loadCollision(bspBuffer);
  markServerMemory("bsp-parsed", {
    map: mapName,
    vertices: bsp.vertices.length,
    faces: bsp.faces.length,
    brushes: bsp.brushes.length,
    patchControls: bsp.vertices.filter(Boolean).length,
  });
  console.log(`[Map] BSP parsed: ${bsp.header.isFBSP ? "FBSP" : "IBSP"} v${bsp.header.version}`);
  console.log(`[Map] Brushes: ${bsp.brushes.length}, Planes: ${bsp.planes.length}`);

  const collision = await createHeadlessCollisionWorld(bsp);
  markServerMemory("collision-ready", { map: mapName });
  console.log(`[Map] Collision world initialized`);

  // Extract spawn points via the shared table, which also understands Warsow's
  // team_CTF_*spawn entities — every team map's spawns were invisible before.
  const spawnPoints = extractSpawnPoints(bsp.entities);
  const teamSpawnPoints = extractTeamSpawnPoints(bsp.entities);
  if (teamSpawnPoints.size > 0) {
    const summary = [...teamSpawnPoints].map(([t, p]) => `${t}=${p.length}`).join(", ");
    console.log(`[Map] Team spawn points: ${summary}`);
  }

  if (spawnPoints.length === 0) {
    console.warn("[Map] No spawn points found in BSP, using defaults");
    spawnPoints.push({ x: 0, y: 100, z: 0 }, { x: 100, y: 100, z: 100 }, { x: -100, y: 100, z: -100 });
  }

  console.log(`[Map] Found ${spawnPoints.length} spawn points`);

  // Extract the authoritative pickup table (weapons/armor/health) — the shared
  // extractor guarantees ids match the client — with every item landed where
  // the server trigger and client visual belong (except suspended items).
  const pickups = landMapPickups(extractPickups(bsp.entities), collision);
  console.log(`[Map] Found ${pickups.length} tracked pickups (weapon/armor/health)`);

  // Extract trigger volumes (teleporters + jumppads) via the shared TriggerTable.
  const triggers = extractTriggerVolumes(bsp.entities, bsp.models);
  console.log(
    `[Map] Found ${triggers.length} trigger volumes (${triggers.filter((t) => t.type === "teleport").length} teleporters, ${triggers.filter((t) => t.type === "push").length} jumppads)`,
  );

  // Retain PVS data for server-side network visibility culling
  const pvs = bsp.visData
    ? {
        nodes: bsp.nodes,
        leafs: bsp.leafs,
        planes: bsp.planes,
        visData: bsp.visData,
      }
    : null;

  console.log(pvs ? `[Map] PVS data retained: ${bsp.visData!.numClusters} clusters` : "[Map] No PVS data in BSP");

  // Raw lumps, so gametypes can extract their own authoring (S&D reads
  // bombsites from them). Cheap: these are already parsed and held by `bsp`.
  return {
    bspSha256: createHash("sha256").update(new Uint8Array(bspBuffer)).digest("hex"),
    collision,
    spawnPoints,
    teamSpawnPoints,
    pickups,
    triggers,
    pvs,
    entities: bsp.entities,
    models: bsp.models,
  };
}
