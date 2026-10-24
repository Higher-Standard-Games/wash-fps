/**
 * Armor & health pickup definitions.
 *
 * These describe the CLIENT-side visual pickup (model, glow, classname). The
 * actual gameplay (amounts, plate rules, caps, decay) is server-authoritative
 * and lives in shared/items/ItemGrants.ts, keyed by the classname→kind map in
 * shared/bsp/PickupTable.ts. Classnames follow Warsow conventions.
 *
 * Models are the real Warsow item .md3s from the PK3 data (data0_21pure.pk3).
 * Their surface shaders (rotating glow / emissive effects) are resolved from the
 * PK3 scripts by the engine's Q3 shader parser automatically — no extra wiring.
 */

import type { EntityDef } from "../../../../../shared/entities/EntityDef";
import { EntityType } from "../../../../../shared/entities/EntityType";

// ── Armor (unified plate model: shard +5, ga/ya/ra = 1/2/4 plates) ──

export const ARMOR_SHARD: EntityDef = {
  id: "armor_shard",
  name: "Armor Shard",
  type: EntityType.ARMOR,
  classname: "item_armor_shard",
  scale: 1.0,
  glowColor: { r: 0.3, g: 1.0, b: 0.3 },
};

export const ARMOR_GREEN: EntityDef = {
  id: "armor_ga",
  name: "Green Armor",
  type: EntityType.ARMOR,
  classname: "item_armor_ga",
  scale: 1.0,
  glowColor: { r: 0.2, g: 1.0, b: 0.2 },
};

export const ARMOR_YELLOW: EntityDef = {
  id: "armor_ya",
  name: "Yellow Armor",
  type: EntityType.ARMOR,
  classname: "item_armor_ya",
  scale: 1.0,
  glowColor: { r: 1.0, g: 0.85, b: 0.1 },
};

export const ARMOR_RED: EntityDef = {
  id: "armor_ra",
  name: "Red Armor",
  type: EntityType.ARMOR,
  classname: "item_armor_ra",
  scale: 1.0,
  glowColor: { r: 1.0, g: 0.2, b: 0.2 },
};

// ── Health (small +5 bubble, medium +25, large +50, mega/ultra +100 overheal→200) ──

export const HEALTH_SMALL: EntityDef = {
  id: "health_small",
  name: "Health (Small)",
  type: EntityType.HEALTH,
  classname: "item_health_small",
  scale: 1.0,
  glowColor: { r: 0.4, g: 0.6, b: 1.0 },
};

export const HEALTH_MEDIUM: EntityDef = {
  id: "health_medium",
  name: "Health (Medium)",
  type: EntityType.HEALTH,
  classname: "item_health_medium",
  // Bare "item_health" is the Q3 default (+25) — behaves as medium.
  classnameAliases: ["item_health"],
  scale: 1.0,
  glowColor: { r: 0.45, g: 0.7, b: 1.0 },
};

export const HEALTH_LARGE: EntityDef = {
  id: "health_large",
  name: "Health (Large)",
  type: EntityType.HEALTH,
  classname: "item_health_large",
  scale: 1.0,
  glowColor: { r: 0.5, g: 0.8, b: 1.0 },
};

export const HEALTH_MEGA: EntityDef = {
  id: "health_mega",
  name: "Mega Health",
  type: EntityType.HEALTH,
  classname: "item_health_mega",
  scale: 1.0,
  glowColor: { r: 1.0, g: 0.3, b: 0.3 },
};

// Ultra is a distinct classname that behaves identically to mega (see PickupTable).
export const HEALTH_ULTRA: EntityDef = {
  id: "health_ultra",
  name: "Ultra Health",
  type: EntityType.HEALTH,
  classname: "item_health_ultra",
  scale: 1.0,
  glowColor: { r: 1.0, g: 0.2, b: 0.5 },
};

// ── Powerups (timed; see shared/items/Powerups.ts for duration & effect) ──

/** Quad Damage. */
export const POWERUP_QUAD: EntityDef = {
  id: "powerup_quad",
  name: "Quad Damage",
  type: EntityType.POWERUP,
  classname: "item_quad",
  scale: 1.0,
  glowColor: { r: 1.0, g: 0.7, b: 0.1 },
};

export const ARMOR_DEFS = [ARMOR_SHARD, ARMOR_GREEN, ARMOR_YELLOW, ARMOR_RED];
export const HEALTH_DEFS = [HEALTH_SMALL, HEALTH_MEDIUM, HEALTH_LARGE, HEALTH_MEGA, HEALTH_ULTRA];
export const POWERUP_DEFS = [POWERUP_QUAD];
