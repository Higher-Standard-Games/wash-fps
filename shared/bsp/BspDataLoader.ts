/**
 * Node BSP buffer loading and entity-data extraction for bot map knowledge.
 */

import * as path from "node:path";
import { extractSpawnPoints as extractSharedSpawnPoints } from "../../../../shared/bsp/SpawnPointTable";
import { extractPickups, type PickupEntry } from "./PickupTable";

// ── Types ────────────────────────────────────────────────────────────────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BspPickupItem {
  classname: string;
  position: Vec3;
}

export interface BspMapData {
  /** Spawn point positions (Babylon coordinate space) */
  spawnPoints: Vec3[];
  /** Weapon and item pickup positions */
  pickupItems: PickupEntry[];
  /** All entity classnames found in the BSP */
  entityClassnames: string[];
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_SPAWN_POINTS: Vec3[] = [
  { x: 0, y: 100, z: 0 },
  { x: 100, y: 100, z: 100 },
  { x: -100, y: 100, z: -100 },
];

// ── BSP Buffer Loading ──────────────────────────────────────────────────

/**
 * Resolve BSP bytes through the pk3 index using the process data directories.
 * Return null when the map is unavailable or indexed validation rejects it.
 */
export async function loadBspBuffer(mapName: string): Promise<ArrayBuffer | null> {
  const { resolveMapBspViaIndex } = await import("../../../../engine/loader/pk3/NodePk3");
  try {
    const indexed = await resolveMapBspViaIndex([path.resolve("./public/data"), path.resolve("./dist/data")], mapName);
    if (!indexed) console.warn(`[BspDataLoader] Could not find BSP for map: ${mapName}`);
    return indexed;
  } catch (error) {
    console.warn(`[BspDataLoader] pk3 index could not resolve ${mapName}:`, error);
    return null;
  }
}

// ── BSP Entity Extraction ───────────────────────────────────────────────

/**
 * Extract player-origin positions using the shared spawn rules.
 * Use the fallback positions when the map has no usable spawn entities.
 */
export function extractSpawnPoints(entities: Array<{ classname: string; properties: Record<string, string> }>): Vec3[] {
  const points = extractSharedSpawnPoints(entities);

  if (points.length === 0) {
    console.warn("[BspDataLoader] No spawn points found, using defaults");
    return [...DEFAULT_SPAWN_POINTS];
  }

  return points;
}

/**
 * Extract weapon and item pickup positions from BSP entities.
 * Converts BSP Z-up origins to the game's Y-up coordinates.
 */
export function extractPickupPositions(
  entities: Array<{ classname: string; properties: Record<string, string> }>,
): BspPickupItem[] {
  const items: BspPickupItem[] = [];

  for (const entity of entities) {
    if (entity.classname.startsWith("weapon_") || entity.classname.startsWith("item_")) {
      const origin = entity.properties.origin;
      if (origin) {
        const [x, y, z] = origin.split(" ").map(Number);
        items.push({
          classname: entity.classname,
          position: { x, y: z, z: y }, // Convert the BSP's Z-up origin to Y-up.
        });
      }
    }
  }

  return items;
}

/**
 * Extract all unique entity classnames from a BSP (for debugging).
 */
export function extractEntityClassnames(entities: Array<{ classname: string }>): string[] {
  const set = new Set<string>();
  for (const entity of entities) {
    set.add(entity.classname);
  }
  return [...set].sort();
}

/**
 * Full BSP map data extraction: spawn points + pickups + classnames.
 */
export function extractMapData(entities: Array<{ classname: string; properties: Record<string, string> }>): BspMapData {
  return {
    spawnPoints: extractSpawnPoints(entities),
    pickupItems: extractPickups(entities),
    entityClassnames: extractEntityClassnames(entities),
  };
}
