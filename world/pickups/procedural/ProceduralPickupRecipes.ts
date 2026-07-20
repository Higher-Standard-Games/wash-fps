/**
 * Per-tier procedural pickup recipes for the FPS health and armor families
 * (docs/research/PROCEDURAL_ITEMS.md §"Exact Effect Recipes"). These are the
 * single source of tunable data — geometry builders and the runtime visual read
 * a recipe and never hard-code a tier. All dimensions use Quake-scale units.
 *
 * Art direction (v2, per playtest feedback): clean, bright, modern sci-fi.
 *  - Health: a bright glowing core with a slow scrolling energy gradient
 *    (`color` → `accentColor`) and a small readable cross emblem. Warm palette:
 *    25 HP is bright yellow, 50 HP scrolls orange↔yellow. No floor pedestal.
 *  - Armor: clean hexagonal shield plates around a small bright core — no rings,
 *    no floor, minimal clutter.
 * Higher tiers add a thin ring / orbiting satellites / a faint beacon, not bulk.
 */

import type { ProceduralPickupRecipe } from "./types";

/** Cache/recipe revision — bump to invalidate scene-cached prototype geometry. */
export const PROCEDURAL_RECIPE_REVISION = "v2";

// Bob/pulse frequencies are cycles-per-second (slow, calm motion).
const RECIPE_LIST: ProceduralPickupRecipe[] = [
  // ── Health: glowing energy core + cross emblem, scrolling gradient ──────
  {
    id: "health_small",
    family: "health",
    kind: "small",
    color: { r: 0.3, g: 0.95, b: 1.0 },
    accentColor: { r: 0.8, g: 1.0, b: 1.0 },
    scale: 0.7,
    ringCount: 0,
    plateCount: 0,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 1.8,
    bobFrequency: 0.3,
    spinSpeed: 12,
    pulseFrequency: 0.26,
    figureEight: false,
    beaconStrength: 0,
    collectStyle: "collapse",
    respawnStyle: "materialize",
    highTier: false,
    unstable: false,
  },
  {
    // 25 HP — bright yellow.
    id: "health_medium",
    family: "health",
    kind: "medium",
    color: { r: 1.0, g: 0.88, b: 0.12 },
    accentColor: { r: 1.0, g: 1.0, b: 0.68 },
    scale: 0.82,
    ringCount: 0,
    plateCount: 0,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 2.2,
    bobFrequency: 0.28,
    spinSpeed: 12,
    pulseFrequency: 0.24,
    figureEight: false,
    beaconStrength: 0,
    collectStyle: "collapse",
    respawnStyle: "assemble",
    highTier: false,
    unstable: false,
  },
  {
    // 50 HP — orange scrolling to yellow.
    id: "health_large",
    family: "health",
    kind: "large",
    color: { r: 1.0, g: 0.48, b: 0.06 },
    accentColor: { r: 1.0, g: 0.86, b: 0.16 },
    scale: 0.95,
    ringCount: 1,
    plateCount: 0,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 2.6,
    bobFrequency: 0.26,
    spinSpeed: 14,
    pulseFrequency: 0.24,
    figureEight: false,
    beaconStrength: 0,
    collectStyle: "collapse",
    respawnStyle: "assemble",
    highTier: false,
    unstable: false,
  },
  {
    id: "health_mega",
    family: "health",
    kind: "mega",
    color: { r: 1.0, g: 0.2, b: 0.2 },
    accentColor: { r: 1.0, g: 0.5, b: 0.22 },
    scale: 1.1,
    ringCount: 2,
    plateCount: 0,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 3,
    bobAmplitude: 3,
    bobFrequency: 0.26,
    spinSpeed: 16,
    pulseFrequency: 0.3,
    figureEight: false,
    beaconStrength: 0.5,
    collectStyle: "collapse",
    respawnStyle: "assemble",
    highTier: true,
    unstable: false,
  },
  {
    id: "health_ultra",
    family: "health",
    kind: "ultra",
    color: { r: 1.0, g: 0.15, b: 0.6 },
    accentColor: { r: 1.0, g: 0.5, b: 0.9 },
    scale: 1.15,
    ringCount: 2,
    plateCount: 0,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 3,
    bobAmplitude: 3,
    bobFrequency: 0.26,
    spinSpeed: 22,
    pulseFrequency: 0.34,
    figureEight: false,
    beaconStrength: 0.6,
    collectStyle: "collapse",
    respawnStyle: "assemble",
    highTier: true,
    unstable: true,
  },

  // ── Armor: clean hexagonal shield plates around a small bright core ─────
  {
    id: "armor_shard",
    family: "armor",
    kind: "shard",
    color: { r: 0.35, g: 1.0, b: 0.4 },
    accentColor: { r: 0.75, g: 1.0, b: 0.78 },
    scale: 0.65,
    ringCount: 0,
    plateCount: 1,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 1.6,
    bobFrequency: 0.28,
    spinSpeed: 16,
    pulseFrequency: 0.28,
    figureEight: false,
    beaconStrength: 0,
    collectStyle: "shatter",
    respawnStyle: "materialize",
    highTier: false,
    unstable: false,
  },
  {
    id: "armor_ga",
    family: "armor",
    kind: "ga",
    color: { r: 0.2, g: 1.0, b: 0.3 },
    accentColor: { r: 0.6, g: 1.0, b: 0.7 },
    scale: 0.85,
    ringCount: 0,
    plateCount: 1,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 2,
    bobFrequency: 0.26,
    spinSpeed: 18,
    pulseFrequency: 0.26,
    figureEight: false,
    beaconStrength: 0,
    collectStyle: "shatter",
    respawnStyle: "assemble",
    highTier: false,
    unstable: false,
  },
  {
    id: "armor_ya",
    family: "armor",
    kind: "ya",
    color: { r: 1.0, g: 0.88, b: 0.12 },
    accentColor: { r: 1.0, g: 1.0, b: 0.6 },
    scale: 0.95,
    ringCount: 0,
    plateCount: 2,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 2.2,
    bobFrequency: 0.24,
    spinSpeed: 20,
    pulseFrequency: 0.26,
    figureEight: false,
    beaconStrength: 0,
    collectStyle: "shatter",
    respawnStyle: "assemble",
    highTier: false,
    unstable: false,
  },
  {
    id: "armor_ra",
    family: "armor",
    kind: "ra",
    color: { r: 1.0, g: 0.22, b: 0.22 },
    accentColor: { r: 1.0, g: 0.5, b: 0.25 },
    scale: 1.1,
    ringCount: 0,
    plateCount: 4,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 2.6,
    bobFrequency: 0.24,
    spinSpeed: 22,
    pulseFrequency: 0.3,
    figureEight: false,
    beaconStrength: 0.5,
    collectStyle: "shatter",
    respawnStyle: "assemble",
    highTier: true,
    unstable: false,
  },
];

const RECIPES_BY_ID = new Map<string, ProceduralPickupRecipe>(RECIPE_LIST.map((r) => [r.id, r]));

/** Look up a recipe by registry id. Returns null for ids with no procedural recipe. */
export function getProceduralPickupRecipe(id: string): ProceduralPickupRecipe | null {
  return RECIPES_BY_ID.get(id) ?? null;
}

/** True if a registry id has a procedural recipe (health/armor only). */
export function hasProceduralPickupRecipe(id: string): boolean {
  return RECIPES_BY_ID.has(id);
}

/** All recipes (for tests / tooling). */
export function allProceduralPickupRecipes(): readonly ProceduralPickupRecipe[] {
  return RECIPE_LIST;
}
