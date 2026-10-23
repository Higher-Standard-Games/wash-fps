/**
 * PickupTable — single source of truth for weapon-pickup identity.
 *
 * Both the server (PickupSystem) and the client (EntityManager) derive their
 * weapon-pickup list from the SAME BSP entity array via `extractWeaponPickups`,
 * so the per-pickup `id` is provably identical on both sides without any network
 * handshake. That id is the authoritative key used by the snapshot active-set
 * (see docs/research/SERVER_AUTHORITATIVE_PICKUPS.md).
 *
 * Previously the two sides assigned ids with separate parallel counters
 * (server: PickupSystem.setPickupItems, client: EntityManager.nextPickupId),
 * a fragile hand-maintained invariant that could drift and cause "ghost weapon"
 * desyncs.
 */

/** BSP weapon classname → game weapon id. Canonical map shared by client + server. */
export const CLASSNAME_TO_WEAPON: Record<string, string> = {
  weapon_machinegun: "machinegun",
  weapon_riotgun: "riotgun",
  weapon_grenadelauncher: "glauncher",
  weapon_rocketlauncher: "rlauncher",
  weapon_plasmagun: "plasmagun",
  weapon_voltaic: "voltaic",
  weapon_lasergun: "voltaic", // Warsow compatibility classname
  weapon_electrobolt: "electrobolt",
  weapon_instagun: "instagun",
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
  // Warsow per-weapon ammo classnames — what every shipped map actually uses.
  // (kind = the weapon's ammoType pool; see games/fps/shared/entities/definitions/weapons/*.)
  ammo_machinegun: { type: "ammo", kind: "bullets", amount: 50 },
  ammo_riotgun: { type: "ammo", kind: "shells", amount: 10 },
  ammo_grenadelauncher: { type: "ammo", kind: "grenades", amount: 10 },
  ammo_rocketlauncher: { type: "ammo", kind: "rockets", amount: 10 },
  ammo_plasmagun: { type: "ammo", kind: "cells", amount: 50 },
  // Lasers are the beam weapon's OWN pool — not shared with plasma cells.
  ammo_lasergun: { type: "ammo", kind: "lasers", amount: 100 },
  ammo_electrobolt: { type: "ammo", kind: "bolts", amount: 10 },
  ammo_instagun: { type: "ammo", kind: "instas", amount: 5 },
  // Legacy Quake-style names — a couple of old maps still use these.
  ammo_bullets: { type: "ammo", kind: "bullets", amount: 50 },
  ammo_shells: { type: "ammo", kind: "shells", amount: 10 },
  ammo_rockets: { type: "ammo", kind: "rockets", amount: 10 },
  // Quake's `cells` are plasma ammo; match the plasma box rather than the beam's.
  ammo_cells: { type: "ammo", kind: "cells", amount: 50 },
  ammo_grenades: { type: "ammo", kind: "grenades", amount: 10 },
  ammo_bolts: { type: "ammo", kind: "bolts", amount: 10 },
  ammo_instas: { type: "ammo", kind: "instas", amount: 5 },
  ammo_lasers: { type: "ammo", kind: "lasers", amount: 100 },
};

/**
 * Canonical map of every server-tracked pickup classname → {type, kind}.
 * Shared by client (visual spawn + id assignment) and server (tracking + grant).
 * Legacy Warsow/Quake armor & health classnames are mapped onto the unified
 * plate-armor and health systems (see ItemGrants.ts).
 */
/** Every map weapon's classname: what a mode with kits leaves off the map. */
export const WEAPON_PICKUP_CLASSNAMES: readonly string[] = Object.keys(CLASSNAME_TO_WEAPON);

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
  // Armor (kind = ArmorKind) — Warsow classnames
  item_armor_shard: { type: "armor", kind: "shard" },
  item_armor_ga: { type: "armor", kind: "ga" },
  item_armor_ya: { type: "armor", kind: "ya" },
  item_armor_ra: { type: "armor", kind: "ra" },
  // Health (kind = HealthKind) — Warsow classnames
  item_health_small: { type: "health", kind: "small" }, // +5 bubble
  item_health_medium: { type: "health", kind: "medium" }, // +25
  item_health: { type: "health", kind: "medium" }, // bare Q3 default (+25) → medium
  item_health_large: { type: "health", kind: "large" }, // +50
  item_health_mega: { type: "health", kind: "mega" },
  item_health_ultra: { type: "health", kind: "ultra" }, // alias → mega behavior
  // Powerups (kind = PowerupKind). Every shipped map places exactly one
  // item_quad; item_warshell / item_regen are present in map data but not yet
  // implemented, so they stay untracked and invisible rather than spawning an
  // item that does nothing when grabbed.
  item_quad: { type: "powerup", kind: "quad" },
};

export interface PickupEntry {
  /** Stable index in BSP order — authoritative pickup id on both client and server. */
  id: number;
  /** BSP classname, e.g. "weapon_rocketlauncher". */
  classname: string;
  /** Pickup type. */
  type: PickupType;
  /** Game-specific kind: weapon id, ammo type, ArmorKind, or HealthKind. */
  kind: string;
  /** Ammo amount, only for type === "ammo". */
  amount?: number;
  /** Babylon-space position (Q3 Y↔Z swapped), matching the BSP origin. */
  position: { x: number; y: number; z: number };
  /** Spawnflag 1: the map wants the item to hang where it is put, not drop to the floor. */
  suspended?: true;
}

/** Back-compat alias — weapon pickups are PickupEntry with type "weapon". */
export type WeaponPickupEntry = PickupEntry;

/**
 * Extract the ordered list of ALL server-tracked pickups (weapons, armor,
 * health, ammo) from BSP entities. Iterates in BSP order, keeps only classnames in
 * PICKUP_CLASSNAMES, and assigns sequential ids. Deterministic: identical input
 * → identical output, so server and client agree on every pickup id.
 */
export function extractPickups(
  entities: Array<{ classname: string; properties: Record<string, string> }>,
): PickupEntry[] {
  const out: PickupEntry[] = [];
  let id = 0;

  for (const entity of entities) {
    const info = PICKUP_CLASSNAMES[entity.classname];
    if (!info) continue;

    const origin = entity.properties.origin;
    if (!origin) continue;

    const [x, y, z] = origin.split(" ").map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

    const entry: PickupEntry = {
      id: id++,
      classname: entity.classname,
      type: info.type,
      kind: info.kind,
      amount: info.amount,
      position: { x, y: z, z: y }, // Q3→Babylon coord swap
    };
    if ((Number(entity.properties.spawnflags) || 0) & 1) entry.suspended = true;
    out.push(entry);
  }

  return out;
}

/**
 * Back-compat helper: extract only weapon pickups. Note ids are assigned over
 * the FULL pickup set (extractPickups) so they stay consistent with the active-
 * set mask once armor/health/ammo share the same id space.
 */
export function extractWeaponPickups(
  entities: Array<{ classname: string; properties: Record<string, string> }>,
): PickupEntry[] {
  return extractPickups(entities).filter((e) => e.type === "weapon");
}
