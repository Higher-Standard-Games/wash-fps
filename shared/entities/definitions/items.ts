/**
 * Armor & health pickup definitions.
 *
 * These describe the CLIENT-side visual pickup (model, glow, classname). The
 * actual gameplay (amounts, plate rules, caps, decay) is server-authoritative
 * and lives in shared/items/ItemGrants.ts, keyed by the classname→kind map in
 * shared/bsp/PickupTable.ts. Classnames follow Warsow conventions.
 *
 * The armor and health pickups draw packaged models from washoi_models.pk3,
 * which float, bob and turn like classic Quake items; the +5, +25 and +50 share
 * one health bubble, tinted by tier (world/pickups/HealthTint.ts). The ultra
 * health draws the megahealth with its blue core turned purple.
 */

import type { EntityDef } from "../../../../../shared/entities/EntityDef";
import { EntityType } from "../../../../../shared/entities/EntityType";

/** The packaged item models are about 1.9 units tall; this makes the megahealth about 34. */
const ITEM_MODEL_SCALE = 18;
/** The armors draw a tenth larger again: about 38 units; green a little smaller, red larger. */
const ARMOR_MODEL_SCALE = 19.8;
const GREEN_ARMOR_SCALE = ARMOR_MODEL_SCALE * 0.95;
const RED_ARMOR_SCALE = ARMOR_MODEL_SCALE * 1.1;
/** The armor shard is worth 5 and draws smaller than the armors: about 25 units. */
const SHARD_MODEL_SCALE = 13.2;
/** The health bubble is about 0.96 across; the +25 draws it about 26, the +50 a tenth larger, the +5 a tenth smaller. */
const HEALTH_BUBBLE_MODEL = "/data/models/health.glb";
const HEALTH_BUBBLE_SCALE = 27;

// ── Armor (unified plate model: shard +5, ga/ya/ra = 1/2/4 plates) ──

export const ARMOR_SHARD: EntityDef = {
  id: "armor_shard",
  name: "Armor Shard",
  type: EntityType.ARMOR,
  classname: "item_armor_shard",
  modelPath: "/data/models/armor_shard.glb",
  scale: SHARD_MODEL_SCALE,
  glowColor: { r: 0.3, g: 1.0, b: 0.3 },
};

export const ARMOR_GREEN: EntityDef = {
  id: "armor_ga",
  name: "Green Armor",
  type: EntityType.ARMOR,
  classname: "item_armor_ga",
  modelPath: "/data/models/ga.glb",
  scale: GREEN_ARMOR_SCALE,
  glowColor: { r: 0.2, g: 1.0, b: 0.2 },
};

export const ARMOR_YELLOW: EntityDef = {
  id: "armor_ya",
  name: "Yellow Armor",
  type: EntityType.ARMOR,
  classname: "item_armor_ya",
  modelPath: "/data/models/ya.glb",
  scale: ARMOR_MODEL_SCALE,
  glowColor: { r: 1.0, g: 0.85, b: 0.1 },
};

export const ARMOR_RED: EntityDef = {
  id: "armor_ra",
  name: "Red Armor",
  type: EntityType.ARMOR,
  classname: "item_armor_ra",
  modelPath: "/data/models/ra.glb",
  scale: RED_ARMOR_SCALE,
  glowColor: { r: 1.0, g: 0.2, b: 0.2 },
};

// ── Health (small +5 bubble, medium +25, large +50, mega/ultra +100 overheal→200) ──

export const HEALTH_SMALL: EntityDef = {
  id: "health_small",
  name: "Health (Small)",
  type: EntityType.HEALTH,
  classname: "item_health_small",
  modelPath: HEALTH_BUBBLE_MODEL,
  scale: HEALTH_BUBBLE_SCALE * 0.9,
  glowColor: { r: 0.4, g: 0.6, b: 1.0 },
};

export const HEALTH_MEDIUM: EntityDef = {
  id: "health_medium",
  name: "Health (Medium)",
  type: EntityType.HEALTH,
  classname: "item_health_medium",
  // Bare "item_health" is the Q3 default (+25) — behaves as medium.
  classnameAliases: ["item_health"],
  modelPath: HEALTH_BUBBLE_MODEL,
  scale: HEALTH_BUBBLE_SCALE,
  glowColor: { r: 1.0, g: 0.72, b: 0.15 },
};

export const HEALTH_LARGE: EntityDef = {
  id: "health_large",
  name: "Health (Large)",
  type: EntityType.HEALTH,
  classname: "item_health_large",
  modelPath: HEALTH_BUBBLE_MODEL,
  scale: HEALTH_BUBBLE_SCALE * 1.1,
  glowColor: { r: 1.0, g: 0.38, b: 0.1 },
};

export const HEALTH_MEGA: EntityDef = {
  id: "health_mega",
  name: "Mega Health",
  type: EntityType.HEALTH,
  classname: "item_health_mega",
  modelPath: "/data/models/mega.glb",
  scale: ITEM_MODEL_SCALE,
  // It floats higher than the armors, the prize it is
  floatLift: 10,
  glowColor: { r: 1.0, g: 0.3, b: 0.3 },
};

// Ultra is a distinct classname that behaves identically to mega (see PickupTable).
export const HEALTH_ULTRA: EntityDef = {
  id: "health_ultra",
  name: "Ultra Health",
  type: EntityType.HEALTH,
  classname: "item_health_ultra",
  modelPath: "/data/models/mega.glb",
  scale: ITEM_MODEL_SCALE,
  floatLift: 10,
  glowColor: { r: 0.75, g: 0.3, b: 1.0 },
};

// ── Powerups (timed; see shared/items/Powerups.ts for duration & effect) ──

/** Quad Damage. */
export const POWERUP_QUAD: EntityDef = {
  id: "powerup_quad",
  name: "Quad Damage",
  type: EntityType.POWERUP,
  classname: "item_quad",
  modelPath: "/data/models/quad.glb",
  // A tenth larger than the megahealth, and floating as high
  scale: ITEM_MODEL_SCALE * 1.1,
  floatLift: 10,
  glowColor: { r: 1.0, g: 0.7, b: 0.1 },
};

export const ARMOR_DEFS = [ARMOR_SHARD, ARMOR_GREEN, ARMOR_YELLOW, ARMOR_RED];
export const HEALTH_DEFS = [HEALTH_SMALL, HEALTH_MEDIUM, HEALTH_LARGE, HEALTH_MEGA, HEALTH_ULTRA];
export const POWERUP_DEFS = [POWERUP_QUAD];
