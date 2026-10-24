/**
 * Per-tier procedural pickup recipes for the FPS health and armor families
 * (docs/research/PROCEDURAL_ITEMS.md §"Exact Effect Recipes"). These are the
 * single source of tunable data — geometry builders and the runtime visual read
 * a recipe and never hard-code a tier. All dimensions use Quake-scale units.
 *
 * Art direction (per playtest feedback): lit solid objects, no outlines.
 *  - Health: a glowing energy shell with a slow `color` → `accentColor` flow and
 *    a readable cross emblem filled in the tier colour (25 HP yellow, 50 HP
 *    orange). Every tier carries a ring with a scrolling gradient band.
 *  - Armor: broad plates over a dark backer, tiered by color and size.
 *  - Ammo: colored panels and geometric marks over a dark chassis.
 *  - Quad: a legible Q badge, with no large beacon.
 */

import type { ProceduralPickupRecipe, RGB } from "./types";

/** Cache/recipe revision — bump to invalidate scene-cached prototype geometry. */
export const PROCEDURAL_RECIPE_REVISION = "v11";

/**
 * Global size multiplier applied on top of each recipe's per-tier `scale`
 * (geometry + placement). One knob for overall pickup size; ~1.9 roughly doubles
 * the v2 sizing for arena visibility.
 */
export const PROCEDURAL_GLOBAL_SCALE = 1.9;

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
    ringCount: 1,
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
    // 25 HP — bright yellow (gradient stays saturated, not washed to white).
    id: "health_medium",
    family: "health",
    kind: "medium",
    color: { r: 1.0, g: 0.82, b: 0.08 },
    accentColor: { r: 1.0, g: 0.95, b: 0.35 },
    scale: 0.82,
    ringCount: 1,
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
    ringCount: 1,
    plateCount: 0,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 3,
    bobFrequency: 0.26,
    spinSpeed: 16,
    pulseFrequency: 0.3,
    figureEight: false,
    beaconStrength: 0,
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
    ringCount: 1,
    plateCount: 0,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 3,
    bobFrequency: 0.26,
    spinSpeed: 22,
    pulseFrequency: 0.34,
    figureEight: false,
    beaconStrength: 0,
    collectStyle: "collapse",
    respawnStyle: "assemble",
    highTier: true,
    unstable: true,
  },

  // ── Armor: broad plates over a backer; tier = colour + size ───
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
    spinSpeed: 8,
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
    spinSpeed: 8,
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
    spinSpeed: 8,
    pulseFrequency: 0.3,
    figureEight: false,
    beaconStrength: 0,
    collectStyle: "shatter",
    respawnStyle: "assemble",
    highTier: true,
    unstable: false,
  },
  // ── Ammo: dark crates with colored panels and generated symbols ─
  ...ammoCrates(),

  // ── Powerup: a stable, two-sided badge ──
  {
    // Gold flowing to hot red. The gold is Warsow's own quad colour, sampled
    // from gfx/hud/icons/powerup/quad.tga (rgb 224,192,0) so the world item and
    // the HUD icon agree; the red accent is the danger colour a carrier glows.
    id: "powerup_quad",
    family: "powerup",
    kind: "quad",
    color: { r: 1.0, g: 0.84, b: 0.05 },
    accentColor: { r: 1.0, g: 0.25, b: 0.1 },
    scale: 1.15,
    ringCount: 0,
    plateCount: 0,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    bobAmplitude: 3,
    bobFrequency: 0.24,
    spinSpeed: 12,
    pulseFrequency: 0.4,
    figureEight: false,
    beaconStrength: 0,
    collectStyle: "collapse",
    respawnStyle: "assemble",
    highTier: true,
    unstable: false,
  },
];

/**
 * Ammo crates share a chassis; color and the geometric mark distinguish the
 * types. The shared fields are filled in once here instead of being
 * copy-pasted eight times. Colours are the weapon identity colours so a crate
 * reads as "rockets" from across the arena before the icon is legible.
 */
function ammoCrates(): ProceduralPickupRecipe[] {
  const crates: Array<{ id: string; kind: string; color: RGB; accent: RGB; icon: string }> = [
    // Machinegun — brass.
    {
      id: "ammo_bullets",
      kind: "bullets",
      color: { r: 1.0, g: 0.76, b: 0.26 },
      accent: { r: 1.0, g: 0.9, b: 0.6 },
      icon: "bulletsammo",
    },
    // Riotgun — burnt orange.
    {
      id: "ammo_shells",
      kind: "shells",
      color: { r: 1.0, g: 0.46, b: 0.18 },
      accent: { r: 1.0, g: 0.72, b: 0.42 },
      icon: "riotammo",
    },
    // Grenade launcher — olive green.
    {
      id: "ammo_grenades",
      kind: "grenades",
      color: { r: 0.55, g: 0.88, b: 0.32 },
      accent: { r: 0.78, g: 1.0, b: 0.6 },
      icon: "grenadeammo",
    },
    // Rocket launcher — red.
    {
      id: "ammo_rockets",
      kind: "rockets",
      color: { r: 1.0, g: 0.32, b: 0.22 },
      accent: { r: 1.0, g: 0.62, b: 0.5 },
      icon: "rocketammo",
    },
    // Plasmagun — teal cells.
    {
      id: "ammo_plasmagun",
      kind: "cells",
      color: { r: 0.3, g: 0.95, b: 0.78 },
      accent: { r: 0.7, g: 1.0, b: 0.92 },
      icon: "plasmaammo",
    },
    // Lasergun/voltaic — its OWN pool since the cells split, so its own colour
    // (violet, distinct from plasma teal) and its own simpleitem icon.
    {
      id: "ammo_lasers",
      kind: "lasers",
      color: { r: 0.62, g: 0.42, b: 1.0 },
      accent: { r: 0.84, g: 0.74, b: 1.0 },
      icon: "laserammo",
    },
    // Electrobolt — electric blue.
    {
      id: "ammo_bolts",
      kind: "bolts",
      color: { r: 0.36, g: 0.62, b: 1.0 },
      accent: { r: 0.7, g: 0.85, b: 1.0 },
      icon: "electroammo",
    },
  ];

  return crates.map(({ id, kind, color, accent, icon }) => ({
    id,
    family: "ammo" as const,
    kind,
    color,
    accentColor: accent,
    scale: 0.8,
    ringCount: 0,
    plateCount: 0,
    moteCount: 0,
    shellPieces: 0,
    satelliteCount: 0,
    // A crate is a heavy object: barely bobs, turns slowly, no pulse theatrics.
    bobAmplitude: 1.4,
    bobFrequency: 0.24,
    spinSpeed: 14,
    pulseFrequency: 0.2,
    figureEight: false,
    beaconStrength: 0,
    collectStyle: "shatter" as const,
    respawnStyle: "materialize" as const,
    highTier: false,
    unstable: false,
    iconTexture: `gfx/hud/icons/ammo/${icon}`,
  }));
}

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
