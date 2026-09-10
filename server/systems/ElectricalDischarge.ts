/**
 * Electrical discharge — firing an electrical weapon while submerged.
 *
 * Quake's lightning-gun rule, and one of the few pieces of environmental
 * interaction old players still quote: pull the trigger underwater and the
 * charge goes into the water instead of down the barrel. It kills the person
 * holding it and hurts everyone sharing the pool.
 *
 * Pure rules here — who discharges, who is caught, and how hard. The system
 * that applies damage owns the consequences.
 */

import type { WaterLevel } from "../../liquid/LiquidTypes";

/**
 * Weapons that discharge. Both are electrical; nothing else in the arsenal is.
 *
 * The blade's charged blast reuses the old gunblade art but is mechanical, and
 * the plasmagun is a plasma bolt rather than a current, so neither qualifies.
 */
export const DISCHARGING_WEAPONS: ReadonlySet<string> = new Set(["electrobolt", "voltaic"]);

/** Radius the charge spreads through the liquid, in world units. */
export const DISCHARGE_RADIUS = 384;

/**
 * Damage dealt to others caught in the same liquid, before falloff.
 *
 * Lethal against a full-health player at the centre and survivable at the
 * edge, so a discharge in a crowded pool is a disaster rather than a coin
 * flip. The shooter's own death is not a damage number — they are gibbed
 * outright, because arguing about whether 100 was enough is not interesting.
 */
export const DISCHARGE_DAMAGE = 150;

/** Would firing this weapon, at this depth, discharge into the water? */
export function dischargesInWater(weaponId: string, waterLevel: WaterLevel): boolean {
  // Level 2 and up: the weapon is under the surface with the player. Wading
  // with wet boots is not enough to complete a circuit.
  return waterLevel >= 2 && DISCHARGING_WEAPONS.has(weaponId);
}

/**
 * Is this bystander in the blast?
 *
 * Two conditions, both required. Being in the water is what connects you to
 * the charge — someone standing dry on the poolside is fine no matter how
 * close they are. Being within the radius is what bounds it, so a discharge
 * in one pool does not electrocute a swimmer in another one across the map.
 */
export function caughtInDischarge(
  targetWaterLevel: WaterLevel,
  distanceSquared: number,
  radius: number = DISCHARGE_RADIUS,
): boolean {
  return targetWaterLevel >= 1 && distanceSquared <= radius * radius;
}

/**
 * Damage at a distance, falling off linearly to nothing at the edge.
 *
 * Linear rather than the quadratic used for explosions: this is a current
 * spreading through a conductor, and the intuition players have about it is
 * "further is safer", not "one step back saves you".
 */
export function dischargeDamageAt(distance: number, radius: number = DISCHARGE_RADIUS): number {
  if (distance >= radius) return 0;
  return DISCHARGE_DAMAGE * (1 - distance / radius);
}
