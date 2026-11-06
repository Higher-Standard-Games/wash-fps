/**
 * Pure armor and health pickup calculations used by PickupSystem.
 *
 * Armor is a 0..100 pool with 25-point plate boundaries. Each inserted plate
 * advances armor to the next boundary: green inserts one (58 → 75), yellow
 * inserts two (58 → 100), and red fills to 100. Shards add 5 directly.
 *
 * Medium health adds 25 and large adds 50, capped at 100. Small health adds 5;
 * mega and ultra add 100, capped at 200. PickupSystem applies increases only
 * and decays health above 100 by 1 HP per second.
 */

export const ARMOR_MAX = 100;
export const ARMOR_PLATE = 25;
export const HEALTH_MAX = 100;
export const HEALTH_OVERHEAL_MAX = 200;

export type ArmorKind = "shard" | "ga" | "ya" | "ra";
export type HealthKind = "small" | "medium" | "large" | "mega" | "ultra";

/** Plates inserted per armor pickup kind (shard is handled as a flat +5). */
const ARMOR_PLATES: Record<Exclude<ArmorKind, "shard">, number> = {
  ga: 1,
  ya: 2,
  ra: 4,
};

/**
 * Resulting armor after picking up the given kind. Pure — does not check whether
 * it's an increase (callers gate pickups on `result > current`).
 */
export function armorAfterPickup(current: number, kind: ArmorKind): number {
  if (kind === "shard") {
    return Math.min(ARMOR_MAX, current + 5);
  }
  const plates = ARMOR_PLATES[kind];
  // Add the pickup's plate count to the number of complete plates.
  const filledPlates = Math.floor(current / ARMOR_PLATE);
  return Math.min(ARMOR_MAX, (filledPlates + plates) * ARMOR_PLATE);
}

/** Health amount added by each health kind. */
const HEALTH_AMOUNT: Record<HealthKind, number> = {
  small: 5,
  medium: 25,
  large: 50,
  mega: 100,
  ultra: 100, // ultra is an alias for mega
};

/** True if this health kind overheals past HEALTH_MAX (small, mega and ultra). */
export function healthOverheals(kind: HealthKind): boolean {
  return kind === "small" || kind === "mega" || kind === "ultra";
}

/**
 * Resulting health after picking up the given kind. medium/large cap at 100;
 * small and mega/ultra overheal to 200. Pure — callers gate on `result > current`.
 */
export function healthAfterPickup(current: number, kind: HealthKind): number {
  const cap = healthOverheals(kind) ? HEALTH_OVERHEAL_MAX : HEALTH_MAX;
  return Math.min(cap, current + HEALTH_AMOUNT[kind]);
}

/**
 * Overheal decay step: while health > HEALTH_MAX, bleed off `rate` HP (default
 * 1/sec) but never below HEALTH_MAX. Call once per second (server tick).
 */
export function decayOverheal(current: number, rate = 1): number {
  if (current <= HEALTH_MAX) return current;
  return Math.max(HEALTH_MAX, current - rate);
}
