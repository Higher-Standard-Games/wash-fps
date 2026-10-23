/**
 * BspDataLoader — Shared BSP loading utilities
 *
 * Extracted from headless-netserver-v2.ts so both the game server
 * and the Bot Intelligence Server can load BSP files without duplication.
 *
 * Handles: file search (.bsp + .pk3), BSP parsing, spawn point extraction,
 * pickup position extraction, and CollisionWorld creation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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

const PLAYER_ORIGIN_HEIGHT = 24;

const SPAWN_CLASSNAMES = ["info_player_deathmatch", "info_player_start", "info_player_team1", "info_player_team2"];

const DEFAULT_SPAWN_POINTS: Vec3[] = [
  { x: 0, y: 100, z: 0 },
  { x: 100, y: 100, z: 100 },
  { x: -100, y: 100, z: -100 },
];

// ── BSP Buffer Loading ──────────────────────────────────────────────────

/**
 * Find and load a BSP file from disk (supports .bsp and .pk3 archives).
 * Searches common data paths for the map file.
 *
 * @returns Raw BSP ArrayBuffer, or null if not found
 */
export async function loadBspBuffer(mapName: string): Promise<ArrayBuffer | null> {
  // The pk3 index first, as the game server resolves maps: it also follows
  // SHAGGED's current-build pointer to the exact published package.
  const { resolveMapBspViaIndex } = await import("../../../../engine/loader/pk3/NodePk3");
  try {
    const indexed = await resolveMapBspViaIndex([path.resolve("./public/data"), path.resolve("./dist/data")], mapName);
    if (indexed) return indexed;
  } catch (error) {
    console.warn(`[BspDataLoader] pk3 index could not resolve ${mapName}:`, error);
  }

  const possiblePaths = [
    path.resolve("./public/data", `map_${mapName}.pk3`),
    path.resolve("./public/data/maps", `${mapName}.bsp`),
    path.resolve("./public/data", `${mapName}.bsp`),
    path.resolve("./public/data/basewsw", `map_${mapName}.pk3`),
    path.resolve("./public/games/default", `map_${mapName}.pk3`),
    path.resolve("./dist/games/default", `map_${mapName}.pk3`),
  ];

  for (const bspPath of possiblePaths) {
    if (fs.existsSync(bspPath)) {
      console.log(`[BspDataLoader] Found BSP at: ${bspPath}`);

      if (bspPath.endsWith(".pk3")) {
        // PK3 is a ZIP archive containing .bsp
        const JSZip = (await import("jszip")).default;
        const pk3Buffer = fs.readFileSync(bspPath);
        const zip = await JSZip.loadAsync(new Uint8Array(pk3Buffer));

        for (const filename of Object.keys(zip.files)) {
          if (filename.endsWith(".bsp")) {
            const bspFile = zip.files[filename];
            const buffer = await bspFile.async("arraybuffer");
            console.log(`[BspDataLoader] Extracted BSP from PK3: ${filename}`);
            return buffer;
          }
        }
      } else {
        const buffer = fs.readFileSync(bspPath);
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
      }
    }
  }

  console.warn(`[BspDataLoader] Could not find BSP for map: ${mapName}`);
  return null;
}

// ── BSP Entity Extraction ───────────────────────────────────────────────

/**
 * Extract spawn points from BSP entities.
 * Applies Q3→Babylon coordinate swap (Y↔Z) and player origin height offset.
 */
export function extractSpawnPoints(entities: Array<{ classname: string; properties: Record<string, string> }>): Vec3[] {
  const points: Vec3[] = [];

  for (const entity of entities) {
    if (SPAWN_CLASSNAMES.includes(entity.classname)) {
      const origin = entity.properties.origin;
      if (origin) {
        const [x, y, z] = origin.split(" ").map(Number);
        // Q3→Babylon: swap Y↔Z, add player origin height
        points.push({ x, y: z + PLAYER_ORIGIN_HEIGHT, z: y });
      }
    }
  }

  if (points.length === 0) {
    console.warn("[BspDataLoader] No spawn points found, using defaults");
    return [...DEFAULT_SPAWN_POINTS];
  }

  return points;
}

/**
 * Extract weapon and item pickup positions from BSP entities.
 * Applies Q3→Babylon coordinate swap (Y↔Z).
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
          position: { x, y: z, z: y }, // Q3→Babylon coord swap
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
