/**
 * Recipe-selection coverage: every health/armor/ammo kind resolves to a recipe
 * with the right family and a defined color; non-pickup ids resolve to null.
 */

import { describe, expect, it } from "vitest";
import {
  allProceduralPickupRecipes,
  getProceduralPickupRecipe,
  hasProceduralPickupRecipe,
} from "../ProceduralPickupRecipes";

const HEALTH_IDS = ["health_small", "health_medium", "health_large", "health_mega", "health_ultra"];
const ARMOR_IDS = ["armor_shard", "armor_ga", "armor_ya", "armor_ra"];
/** Must stay in step with the ids in `src/shared/entities/definitions/ammo/`. */
const AMMO_IDS = [
  "ammo_bullets",
  "ammo_shells",
  "ammo_grenades",
  "ammo_rockets",
  "ammo_plasmagun",
  "ammo_lasers",
  "ammo_bolts",
  "ammo_instas",
];

describe("getProceduralPickupRecipe", () => {
  it("resolves every health kind to a health recipe", () => {
    for (const id of HEALTH_IDS) {
      const recipe = getProceduralPickupRecipe(id);
      expect(recipe, id).not.toBeNull();
      expect(recipe?.id).toBe(id);
      expect(recipe?.family).toBe("health");
      expect(recipe?.color).toBeDefined();
    }
  });

  it("resolves every armor kind to an armor recipe", () => {
    for (const id of ARMOR_IDS) {
      const recipe = getProceduralPickupRecipe(id);
      expect(recipe, id).not.toBeNull();
      expect(recipe?.id).toBe(id);
      expect(recipe?.family).toBe("armor");
      expect(recipe?.color).toBeDefined();
    }
  });

  it("resolves every ammo kind to an ammo recipe carrying an icon path", () => {
    for (const id of AMMO_IDS) {
      const recipe = getProceduralPickupRecipe(id);
      expect(recipe, id).not.toBeNull();
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

  it("only marks health/armor/ammo ids as having a procedural recipe", () => {
    expect(hasProceduralPickupRecipe("health_mega")).toBe(true);
    expect(hasProceduralPickupRecipe("armor_ra")).toBe(true);
    expect(hasProceduralPickupRecipe("ammo_bolts")).toBe(true);
    expect(hasProceduralPickupRecipe("rlauncher")).toBe(false);
  });

  it("exposes exactly the health + armor + ammo entries", () => {
    const recipes = allProceduralPickupRecipes();
    expect(recipes).toHaveLength(HEALTH_IDS.length + ARMOR_IDS.length + AMMO_IDS.length);
    // High-tier flag is set for the expensive tiers only — no crate is high tier.
    const highTier = recipes
      .filter((r) => r.highTier)
      .map((r) => r.id)
      .sort();
    expect(highTier).toEqual(["armor_ra", "health_mega", "health_ultra"]);
  });

  it("keeps laser and plasma crates visually distinct (separate ammo pools)", () => {
    // Lasers used to share the plasmagun's `cells` pool, so the two crates were
    // the same object. They are separate pools now and must read as such.
    const plasma = getProceduralPickupRecipe("ammo_plasmagun");
    const lasers = getProceduralPickupRecipe("ammo_lasers");
    expect(plasma?.kind).toBe("cells");
    expect(lasers?.kind).toBe("lasers");
    expect(plasma?.iconTexture).not.toBe(lasers?.iconTexture);
    expect(plasma?.color).not.toEqual(lasers?.color);
  });
});
