/**
 * Per-tier procedural pickup recipes for the FPS health and armor families
 * (docs/research/PROCEDURAL_ITEMS.md §"Exact Effect Recipes"). These are the
 * single source of tunable data — geometry builders and the runtime visual read
 * a recipe and never hard-code a tier. All dimensions use Quake-scale units.
 *
 * Colors retain the existing item `glowColor` values so the procedural sculptures
 * read as the same items players already know. Values are initial targets meant
 * to be tuned in-map.
 */

import type { ProceduralPickupRecipe } from "./types";

/** Cache/recipe revision — bump to invalidate scene-cached prototype geometry. */
export const PROCEDURAL_RECIPE_REVISION = "v1";

// Bob/pulse frequencies are cycles-per-second; the doc quotes cycle seconds, so
// frequency = 1 / cycleSeconds.
const RECIPE_LIST: ProceduralPickupRecipe[] = [
  // ── Health: energy reliquary (3D cross + core, blue/cyan) ──────────────
  {
    id: "health_small",
    family: "health",
    kind: "small",
    color: { r: 0.4, g: 0.6, b: 1.0 },
    accentColor: { r: 0.55, g: 0.8, b: 1.0 },
    scale: 0.8,
    ringCount: 0,
    plateCount: 0,
    moteCount: 1,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 2,
    bobFrequency: 1 / 2.8,
    spinSpeed: 18,
    pulseFrequency: 1 / 2.4,
    figureEight: true,
    beaconStrength: 0,
    collectStyle: "collapse",
    respawnStyle: "materialize",
    highTier: false,
    unstable: false,
  },
  {
    id: "health_medium",
    family: "health",
    kind: "medium",
    color: { r: 0.45, g: 0.7, b: 1.0 },
    accentColor: { r: 0.6, g: 0.85, b: 1.0 },
    scale: 1.0,
    ringCount: 1,
    plateCount: 0,
    moteCount: 2,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 3,
    bobFrequency: 1 / 2.4,
    spinSpeed: 28,
    pulseFrequency: 1 / 2.0,
    figureEight: true,
    beaconStrength: 0,
    collectStyle: "collapse",
    respawnStyle: "assemble",
    highTier: false,
    unstable: false,
  },
  {
    id: "health_large",
    family: "health",
    kind: "large",
    color: { r: 0.5, g: 0.8, b: 1.0 },
    accentColor: { r: 0.7, g: 0.9, b: 1.0 },
    scale: 1.25,
    ringCount: 2,
    plateCount: 0,
    moteCount: 4,
    shellPieces: 4,
    satelliteCount: 0,
    bobAmplitude: 4,
    bobFrequency: 1 / 2.2,
    spinSpeed: 24,
    pulseFrequency: 1 / 1.8,
    figureEight: true,
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
    color: { r: 1.0, g: 0.3, b: 0.3 },
    accentColor: { r: 1.0, g: 0.55, b: 0.35 },
    scale: 1.5,
    ringCount: 3,
    plateCount: 0,
    moteCount: 8,
    shellPieces: 4,
    satelliteCount: 4,
    bobAmplitude: 5,
    bobFrequency: 1 / 1.9,
    spinSpeed: 30,
    pulseFrequency: 1 / 1.6,
    figureEight: true,
    beaconStrength: 0.6,
    collectStyle: "collapse",
    respawnStyle: "assemble",
    highTier: true,
    unstable: false,
  },
  {
    id: "health_ultra",
    family: "health",
    kind: "ultra",
    color: { r: 1.0, g: 0.2, b: 0.5 },
    accentColor: { r: 1.0, g: 0.5, b: 0.9 },
    scale: 1.55,
    ringCount: 3,
    plateCount: 0,
    moteCount: 8,
    shellPieces: 4,
    satelliteCount: 4,
    bobAmplitude: 5,
    bobFrequency: 1 / 1.9,
    spinSpeed: 40,
    pulseFrequency: 1 / 1.4,
    figureEight: true,
    beaconStrength: 0.7,
    collectStyle: "collapse",
    respawnStyle: "assemble",
    highTier: true,
    unstable: true,
  },

  // ── Armor: assembling force shield (hex core + plates, green/yellow/red) ──
  {
    id: "armor_shard",
    family: "armor",
    kind: "shard",
    color: { r: 0.3, g: 1.0, b: 0.3 },
    accentColor: { r: 0.55, g: 1.0, b: 0.55 },
    scale: 0.8,
    ringCount: 0,
    plateCount: 1,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 1.5,
    bobFrequency: 1 / 3.0,
    spinSpeed: 12,
    pulseFrequency: 1 / 2.8,
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
    color: { r: 0.2, g: 1.0, b: 0.2 },
    accentColor: { r: 0.5, g: 1.0, b: 0.5 },
    scale: 1.0,
    ringCount: 1,
    plateCount: 1,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 2,
    bobFrequency: 1 / 2.8,
    spinSpeed: 22,
    pulseFrequency: 1 / 2.4,
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
    color: { r: 1.0, g: 0.85, b: 0.1 },
    accentColor: { r: 1.0, g: 0.95, b: 0.4 },
    scale: 1.1,
    ringCount: 1,
    plateCount: 2,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 2.5,
    bobFrequency: 1 / 2.6,
    spinSpeed: 26,
    pulseFrequency: 1 / 2.2,
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
    color: { r: 1.0, g: 0.2, b: 0.2 },
    accentColor: { r: 1.0, g: 0.5, b: 0.25 },
    scale: 1.3,
    ringCount: 1,
    plateCount: 4,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 3,
    bobFrequency: 1 / 2.4,
    spinSpeed: 30,
    pulseFrequency: 1 / 1.6,
    figureEight: false,
    beaconStrength: 0.6,
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
