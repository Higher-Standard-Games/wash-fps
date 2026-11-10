/**
 * Recipe-selection coverage: every procedural health kind resolves to a recipe
 * with the right family and a defined color; items drawn from packaged models
 * and non-pickup ids resolve to null.
 */

import { describe, expect, it } from "vitest";
import {
  allProceduralPickupRecipes,
  ammoCrateRecipes,
  getProceduralPickupRecipe,
  hasProceduralPickupRecipe,
  healthBubbleRecipes,
  quadRecipe,
  ultraHealthRecipe,
} from "../ProceduralPickupRecipes";

/** Items drawn from packaged models instead (washoi_models.pk3). */
const MODEL_IDS = [
  "armor_shard",
  "armor_ga",
  "armor_ya",
  "armor_ra",
  "health_small",
  "health_medium",
  "health_large",
  "health_mega",
  "health_ultra",
  "powerup_quad",
];
/** Must stay in step with the ids in `shared/entities/definitions/ammo/`; all draw the ammo box. */
const AMMO_IDS = [
  "ammo_bullets",
  "ammo_shells",
  "ammo_grenades",
  "ammo_rockets",
  "ammo_plasmagun",
  "ammo_lasers",
  "ammo_bolts",
];
/** Powerups; quad is the only one implemented (see shared/items/Powerups.ts). */

describe("getProceduralPickupRecipe", () => {
  it("keeps an unregistered recipe for every health bubble", () => {
    expect(healthBubbleRecipes().map((r) => r.id)).toEqual(["health_small", "health_medium", "health_large"]);
    for (const recipe of healthBubbleRecipes()) expect(recipe.family).toBe("health");
  });

  it("keeps an unregistered crate recipe for every ammo kind, carrying an icon path", () => {
    const crates = new Map(ammoCrateRecipes().map((r) => [r.id, r]));
    for (const id of AMMO_IDS) {
      const recipe = crates.get(id);
      expect(recipe, id).toBeDefined();
      expect(recipe?.id).toBe(id);
      expect(recipe?.family).toBe("ammo");
      expect(recipe?.color).toBeDefined();
      // The crate stamps the Warsow simpleitem icon on its sides.
      expect(recipe?.iconTexture, id).toMatch(/^gfx\/hud\/icons\/ammo\//);
    }
  });

  it("returns null for weapons and unknown ids (no procedural recipe)", () => {
    // Weapons stay on their MD3 models — the pickup IS the gun you collect.
    expect(getProceduralPickupRecipe("plasmagun")).toBeNull();
    expect(getProceduralPickupRecipe("rlauncher")).toBeNull();
    expect(getProceduralPickupRecipe("does_not_exist")).toBeNull();
  });

  it("keeps the ultra health's and the quad's recipes unregistered", () => {
    expect(ultraHealthRecipe()).toMatchObject({ id: "health_ultra", family: "health", highTier: true });
    expect(quadRecipe()).toMatchObject({ id: "powerup_quad", family: "powerup", highTier: true });
    expect(quadRecipe().iconTexture).toBeUndefined();
  });

  it("leaves the armor, every health, the quad and ammo to their packaged models", () => {
    for (const id of [...MODEL_IDS, ...AMMO_IDS]) expect(hasProceduralPickupRecipe(id), id).toBe(false);
  });

  it("registers no recipe at all: every item has its packaged model", () => {
    expect(allProceduralPickupRecipes()).toHaveLength(0);
  });

  it("keeps laser and plasma crates visually distinct (separate ammo pools)", () => {
    // Lasers used to share the plasmagun's `cells` pool, so the two crates were
    // the same object. They are separate pools now and must read as such.
    const plasma = ammoCrateRecipes().find((r) => r.id === "ammo_plasmagun");
    const lasers = ammoCrateRecipes().find((r) => r.id === "ammo_lasers");
    expect(plasma?.kind).toBe("cells");
    expect(lasers?.kind).toBe("lasers");
    expect(plasma?.iconTexture).not.toBe(lasers?.iconTexture);
    expect(plasma?.color).not.toEqual(lasers?.color);
  });
});
