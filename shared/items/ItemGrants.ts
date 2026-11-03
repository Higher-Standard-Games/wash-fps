/**
 * ItemGrants — pure functions for armor/health pickup math.
 *
 * Server-authoritative (PickupSystem calls these), but kept pure and engine-free
 * so they're trivially unit-testable and shared. See the design discussion in
 * docs/research/SERVER_AUTHORITATIVE_PICKUPS.md.
 *
 * ARMOR (CoD-style plate model masked behind Quake armor names):
 *   One 0..100 pool (4 plates × 25). Damage depletes it continuously (so it
 *   lands on fractional values); plates only matter at PICKUP time. A "plate"
 *   tops the current partial plate up to its 25-boundary (CoD plate insertion),
 *   so e.g. 58 + green(1 plate) → 75, not 83.
 *     shard → +5 flat   ga → +1 plate   ya → +2 plates   ra → fill (4 plates)
 *
 * HEALTH (Warsow amounts):
 *   medium +25, large +50 — capped at 100, so they stay on the map until the
 *   player is hurt.
 *   small +5, mega/ultra +100 — overheal to 200, then decay 1 HP/s back toward
 *   100. A small bubble is therefore taken at full health too.
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
  // Insert N plates: round the current partial plate up to its boundary, +N plates.
  const filledPlates = Math.floor(current / ARMOR_PLATE);
  return Math.min(ARMOR_MAX, (filledPlates + plates) * ARMOR_PLATE);
}

/** Health amount added by each health kind. */
const HEALTH_AMOUNT: Record<HealthKind, number> = {
  small: 5, // Warsow bubble
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
