/**
 * Shared item facts for the goal considerations.
 *
 * Everything here reads the canonical weapon/ammo/powerup definitions rather
 * than restating them, so a balance change (a new ammo pool, a different
 * maxAmmo, a retuned quad) reaches bot reasoning automatically. The lasergun
 * cells→lasers pool split in v0.9.21 is exactly the kind of change that would
 * silently rot a hand-copied table.
 */

import { WEAPONS } from "../../../shared/entities/definitions/weapons/WeaponsTable";
import { QUAD_MULTIPLIER } from "../../../shared/items/Powerups";
import type { BotSelf } from "../../BotGameState";
import { clamp01 } from "../Consideration";

/** ammoType -> the weapon defs that consume it, built once from the table. */
const CONSUMERS_BY_AMMO = new Map<string, string[]>();
/** ammoType -> the largest reserve any consuming weapon can hold. */
const CAPACITY_BY_AMMO = new Map<string, number>();

for (const [weaponId, def] of Object.entries(WEAPONS)) {
  const ammoType = def.ammoType;
  if (!ammoType) continue;
  const list = CONSUMERS_BY_AMMO.get(ammoType);
  if (list) list.push(weaponId);
  else CONSUMERS_BY_AMMO.set(ammoType, [weaponId]);
  CAPACITY_BY_AMMO.set(ammoType, Math.max(CAPACITY_BY_AMMO.get(ammoType) ?? 0, def.maxAmmo ?? 0));
}

/** Weapon ids that draw from this ammo pool. */
export function ammoConsumers(ammoType: string): readonly string[] {
  return CONSUMERS_BY_AMMO.get(ammoType) ?? [];
}

/** Reserve capacity for an ammo pool (0 when unknown). */
export function ammoCapacity(ammoType: string): number {
  return CAPACITY_BY_AMMO.get(ammoType) ?? 0;
}

/**
 * How badly the bot needs this ammo, 0..1.
 *
 * `key` may be an ammo pool ("rockets") or a weapon id ("rlauncher"); both
 * resolve to the same pool. 1 means empty, 0 means full or unknown. When
 * `grantAmount` is given the result is capped by how much would not be wasted,
 * so a 10-rocket box at 18/20 rockets scores on the 2 that actually land.
 */
export function ammoNeedFraction(self: BotSelf, key: string, grantAmount?: number): number {
  const ammoType = WEAPONS[key]?.ammoType ?? key;
  const capacity = ammoCapacity(ammoType);
  if (capacity <= 0) return 0;

  // The bot's ammo record is keyed by weapon id; sum is wrong for shared pools,
  // so take the largest holding among consumers as the pool level.
  let held = 0;
  for (const weaponId of ammoConsumers(ammoType)) {
    held = Math.max(held, self.ammo[weaponId] ?? 0);
  }

  const room = Math.max(0, capacity - held);
  const usable = grantAmount === undefined ? room : Math.min(room, grantAmount);
  return clamp01(usable / capacity);
}

/**
 * Intrinsic worth of a powerup, 0..1.
 *
 * Quad is the most valuable thing on a map: a 4× damage multiplier for 30 s,
 * placed exactly once. It is scored just below 1 rather than at 1 so that a
 * genuinely desperate health need can still outrank it when the bot is about
 * to die — a quad you collect at 8 HP is a quad you hand to the enemy.
 */
export function powerupValue(kind: string): number {
  if (kind === "quad") return QUAD_MULTIPLIER >= 4 ? 0.95 : 0.8;
  // Unimplemented powerups (warshell, regen) are not tracked as pickups today;
  // if one is ever added without a value here, it reads as low-but-nonzero.
  return 0.4;
}

/**
 * How much the bot would rather the ENEMY did not get this, 0..1.
 *
 * Independent of the bot's own need — this is the reason to take Red Armor at
 * full armor, or to deny a Mega you cannot use. Scaled by tier only; making it
 * enemy-position-aware needs contested-item reasoning that is out of Phase 1
 * scope and belongs with map control.
 */
export function denialValue(type: string, kind: string): number {
  if (type === "powerup") return powerupValue(kind);
  if (type === "health") return kind === "mega" || kind === "ultra" ? 0.8 : 0.15;
  if (type === "armor") {
    if (kind === "ra") return 0.7;
    if (kind === "ya") return 0.4;
    return 0.1;
  }
  if (type === "weapon") return 0.25;
  return 0.05;
}

/** The armors, Mega Health and powerups: what an item route is planned around. */
export function isMajorItem(type: string, kind: string): boolean {
  if (type === "powerup") return true;
  if (type === "armor") return kind === "ga" || kind === "ya" || kind === "ra";
  return type === "health" && (kind === "mega" || kind === "ultra");
}
