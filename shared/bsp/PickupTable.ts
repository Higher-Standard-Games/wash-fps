/**
 * Shared pickup classification and deterministic ids for client and server.
 * Entries are extracted in BSP entity order; their ids index the authoritative
 * pickup active-set mask. Weapon-only extraction retains the full table's ids.
 */

/** BSP weapon classname → game weapon id. Canonical map shared by client + server. */
export const CLASSNAME_TO_WEAPON: Record<string, string> = {
  weapon_machinegun: "machinegun",
  weapon_riotgun: "riotgun",
  weapon_grenadelauncher: "glauncher",
  weapon_rocketlauncher: "rlauncher",
  weapon_plasmagun: "plasmagun",
  weapon_voltaic: "voltaic",
  weapon_lasergun: "voltaic", // Map classname alias for the beam weapon.
  weapon_electrobolt: "electrobolt",
};

/** Pickup type tracked by the server. */
export type PickupType = "weapon" | "ammo" | "armor" | "health" | "powerup";

/** Descriptor for a tracked pickup classname: its type + game-specific kind. */
interface PickupClassInfo {
  type: PickupType;
  /** For weapons: weapon id. For ammo: ammo type. For armor/health: grant kind. */
  kind: string;
  /** Ammo amount for ammo pickups. */
  amount?: number;
}

const AMMO_CLASSNAMES: Record<string, PickupClassInfo> = {
  // Weapon-specific ammo classnames; kind names the weapon's ammoType pool.
  ammo_machinegun: { type: "ammo", kind: "bullets", amount: 50 },
  ammo_riotgun: { type: "ammo", kind: "shells", amount: 10 },
  ammo_grenadelauncher: { type: "ammo", kind: "grenades", amount: 10 },
  ammo_rocketlauncher: { type: "ammo", kind: "rockets", amount: 10 },
  ammo_plasmagun: { type: "ammo", kind: "cells", amount: 50 },
  // The beam weapon uses its own lasers pool, separate from plasma cells.
  ammo_lasergun: { type: "ammo", kind: "lasers", amount: 100 },
  ammo_electrobolt: { type: "ammo", kind: "bolts", amount: 10 },
  // Ammo-pool classnames.
  ammo_bullets: { type: "ammo", kind: "bullets", amount: 50 },
  ammo_shells: { type: "ammo", kind: "shells", amount: 10 },
  ammo_rockets: { type: "ammo", kind: "rockets", amount: 10 },
  // Cells feed the plasma ammo pool.
  ammo_cells: { type: "ammo", kind: "cells", amount: 50 },
  ammo_grenades: { type: "ammo", kind: "grenades", amount: 10 },
  ammo_bolts: { type: "ammo", kind: "bolts", amount: 10 },
  ammo_lasers: { type: "ammo", kind: "lasers", amount: 100 },
};

/** Weapon classnames used by gametype pickup exclusions. */
export const WEAPON_PICKUP_CLASSNAMES: readonly string[] = Object.keys(CLASSNAME_TO_WEAPON);

/** Shared map from tracked pickup classnames to their types, kinds and amounts. */
export const PICKUP_CLASSNAMES: Record<string, PickupClassInfo> = {
  // Weapons (kind = weapon id)
  ...Object.fromEntries(
    Object.entries(CLASSNAME_TO_WEAPON).map(([classname, weaponId]) => [
      classname,
      { type: "weapon" as const, kind: weaponId },
    ]),
  ),
  // Ammo (kind = ammo type)
  ...AMMO_CLASSNAMES,
  // Armor (kind = ArmorKind)
  item_armor_shard: { type: "armor", kind: "shard" },
  item_armor_ga: { type: "armor", kind: "ga" },
  item_armor_ya: { type: "armor", kind: "ya" },
  item_armor_ra: { type: "armor", kind: "ra" },
  // Health (kind = HealthKind)
  item_health_small: { type: "health", kind: "small" }, // +5 bubble
  item_health_medium: { type: "health", kind: "medium" }, // +25
  item_health: { type: "health", kind: "medium" }, // Alias for medium health.
  item_health_large: { type: "health", kind: "large" }, // +50
  item_health_mega: { type: "health", kind: "mega" },
  item_health_ultra: { type: "health", kind: "ultra" }, // alias → mega behavior
  // Powerups (kind = PowerupKind). Unsupported powerups are omitted.
  item_quad: { type: "powerup", kind: "quad" },
};

export interface PickupEntry {
  /** Stable index in BSP order — authoritative pickup id on both client and server. */
  id: number;
  /** BSP classname, e.g. "weapon_rocketlauncher". */
  classname: string;
  /** Pickup type. */
  type: PickupType;
  /** Game-specific kind: weapon id, ammo type, ArmorKind, HealthKind or PowerupKind. */
  kind: string;
  /** Ammo amount, only for type === "ammo". */
  amount?: number;
  /** Position in the game's Y-up coordinate system. */
  position: { x: number; y: number; z: number };
  /** Spawnflag 1: the map wants the item to hang where it is put, not drop to the floor. */
  suspended?: true;
}

/** Weapon-oriented alias for the shared pickup entry shape. */
export type WeaponPickupEntry = PickupEntry;

/**
 * Extract tracked weapons, armor, health, ammo and powerups in BSP entity order.
 * Only registered classnames with valid origins receive sequential pickup ids.
 */
export function extractPickups(
  entities: Array<{ classname: string; properties: Record<string, string> }>,
): PickupEntry[] {
  const out: PickupEntry[] = [];
  let id = 0;

  for (const entity of entities) {
    const info: PickupClassInfo | undefined = Object.getOwnPropertyDescriptor(
      PICKUP_CLASSNAMES,
      entity.classname,
    )?.value;
    if (!info) continue;

    const origin = entity.properties.origin;
    if (!origin) continue;

    const parts = origin.trim().split(/\s+/).map(Number);
    if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) continue;
    const [x, y, z] = parts;

    const entry: PickupEntry = {
      id: id++,
      classname: entity.classname,
      type: info.type,
      kind: info.kind,
      amount: info.amount,
      position: { x, y: z, z: y }, // Convert the BSP's Z-up origin to Y-up.
    };
    if ((Number(entity.properties.spawnflags) || 0) & 1) entry.suspended = true;
    out.push(entry);
  }

  return out;
}

/**
 * Return only weapons, retaining their ids from the full pickup table.
 */
export function extractWeaponPickups(
  entities: Array<{ classname: string; properties: Record<string, string> }>,
): PickupEntry[] {
  return extractPickups(entities).filter((e) => e.type === "weapon");
}
