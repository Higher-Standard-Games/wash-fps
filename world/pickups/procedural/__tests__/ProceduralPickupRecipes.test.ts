/**
 * Recipe-selection coverage: every health/armor kind resolves to a recipe with
 * the right family and a defined color; non-pickup ids resolve to null.
 */

import { describe, expect, it } from "vitest";
import {
  allProceduralPickupRecipes,
  getProceduralPickupRecipe,
  hasProceduralPickupRecipe,
} from "../ProceduralPickupRecipes";

const HEALTH_IDS = ["health_small", "health_medium", "health_large", "health_mega", "health_ultra"];
const ARMOR_IDS = ["armor_shard", "armor_ga", "armor_ya", "armor_ra"];

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

  it("returns null for weapons/ammo/unknown ids (no procedural recipe)", () => {
    expect(getProceduralPickupRecipe("plasmagun")).toBeNull();
    expect(getProceduralPickupRecipe("ammo_rockets")).toBeNull();
    expect(getProceduralPickupRecipe("does_not_exist")).toBeNull();
  });

  it("only marks health/armor ids as having a procedural recipe", () => {
    expect(hasProceduralPickupRecipe("health_mega")).toBe(true);
    expect(hasProceduralPickupRecipe("armor_ra")).toBe(true);
    expect(hasProceduralPickupRecipe("rlauncher")).toBe(false);
  });

  it("exposes exactly the 9 health+armor tiers", () => {
    const recipes = allProceduralPickupRecipes();
    expect(recipes).toHaveLength(HEALTH_IDS.length + ARMOR_IDS.length);
    // High-tier flag is set for the expensive tiers only.
    const highTier = recipes
      .filter((r) => r.highTier)
      .map((r) => r.id)
      .sort();
    expect(highTier).toEqual(["armor_ra", "health_mega", "health_ultra"]);
  });
});
