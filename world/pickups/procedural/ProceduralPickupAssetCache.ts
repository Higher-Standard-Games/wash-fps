/**
 * Scene-scoped prototype geometry/material cache for procedural pickups
 * (docs/research/PROCEDURAL_ITEMS.md §"Geometry cache decision").
 *
 * Each recipe's prototype geometry and shared immutable materials are generated
 * lazily ONCE per scene, then cloned for every matching pickup — a whole map's
 * worth of `health_medium` items shares one cross/core geometry and one dark
 * structural material. Per-pickup mutable state (private energy materials,
 * transforms, lifecycle) is NOT cached; it lives on the individual visual.
 *
 * Ownership boundary:
 *   - THIS cache disposes prototype meshes + shared immutable materials.
 *   - Each visual disposes its own clones + private materials.
 * A `WeakMap<Scene, …>` does not free GPU resources on its own, so the cache
 * hooks `scene.onDisposeObservable` to explicitly dispose everything it built.
 */

import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import * as Geo from "./ProceduralPickupGeometry";
import { createEnergyMaterialTemplate, createStructuralMaterial } from "./ProceduralPickupMaterials";
import { PROCEDURAL_RECIPE_REVISION } from "./ProceduralPickupRecipes";
import type { ProceduralPickupRecipe } from "./types";

/** Prototype geometry + shared immutable materials for one recipe in one scene. */
export interface PrototypeSet {
  readonly recipeId: string;
  cross: Mesh | null;
  core: Mesh | null;
  hexCore: Mesh | null;
  ring: Mesh | null;
  plate: Mesh | null;
  petal: Mesh | null;
  mote: Mesh | null;
  satellite: Mesh | null;
  floorDisc: Mesh | null;
  floorRing: Mesh | null;
  glyph: Mesh | null;
  beacon: Mesh | null;
  /** Dark, lit relic material (shared, immutable). */
  structural: StandardMaterial;
  /** Vivid core-color emissive template (clone per pickup for private pulse). */
  energyCore: StandardMaterial;
  /** Accent-color emissive template (rings/plates/glyph). */
  energyAccent: StandardMaterial;
  /** Low-alpha soft emissive template (core shell, floor disc, beacon). */
  energySoft: StandardMaterial;
  dispose(): void;
}

const sceneCaches = new WeakMap<Scene, Map<string, PrototypeSet>>();

function cacheKey(recipe: ProceduralPickupRecipe): string {
  return `${recipe.id}:high:${PROCEDURAL_RECIPE_REVISION}`;
}

function buildPrototypeSet(scene: Scene, recipe: ProceduralPickupRecipe): PrototypeSet {
  const structural = createStructuralMaterial(scene, `pp_struct_${recipe.id}`, recipe.color);
  const energyCore = createEnergyMaterialTemplate(scene, `pp_core_${recipe.id}`, recipe.color, 1);
  const energyAccent = createEnergyMaterialTemplate(scene, `pp_accent_${recipe.id}`, recipe.accentColor, 1);
  const energySoft = createEnergyMaterialTemplate(scene, `pp_soft_${recipe.id}`, recipe.color, 0.32);

  const set: PrototypeSet = {
    recipeId: recipe.id,
    cross: recipe.family === "health" ? Geo.buildCrossProto(scene, recipe) : null,
    core: recipe.family === "health" ? Geo.buildCoreProto(scene, recipe) : null,
    hexCore: recipe.family === "armor" ? Geo.buildHexCoreProto(scene, recipe) : null,
    ring: recipe.ringCount > 0 ? Geo.buildRingProto(scene, recipe) : null,
    plate: recipe.plateCount > 0 ? Geo.buildPlateProto(scene, recipe) : null,
    petal: recipe.shellPieces > 0 ? Geo.buildShellPetalProto(scene, recipe) : null,
    mote: recipe.moteCount > 0 ? Geo.buildMoteProto(scene, recipe) : null,
    satellite: recipe.satelliteCount > 0 ? Geo.buildSatelliteProto(scene, recipe) : null,
    floorDisc: Geo.buildFloorDiscProto(scene, recipe),
    floorRing: Geo.buildFloorRingProto(scene, recipe),
    glyph: Geo.buildFloorGlyphProto(scene, recipe),
    beacon: recipe.beaconStrength > 0 ? Geo.buildBeaconProto(scene, recipe) : null,
    structural,
    energyCore,
    energyAccent,
    energySoft,
    dispose(): void {
      for (const m of [
        this.cross,
        this.core,
        this.hexCore,
        this.ring,
        this.plate,
        this.petal,
        this.mote,
        this.satellite,
        this.floorDisc,
        this.floorRing,
        this.glyph,
        this.beacon,
      ]) {
        m?.dispose();
      }
      this.structural.dispose();
      this.energyCore.dispose();
      this.energyAccent.dispose();
      this.energySoft.dispose();
    },
  };
  return set;
}

/**
 * Get (or lazily build) the prototype set for a recipe in a scene. The first
 * request generates the geometry; subsequent pickups of the same recipe reuse it.
 * Map load naturally prewarms every recipe used by the map before play.
 */
export function getPrototypeSet(scene: Scene, recipe: ProceduralPickupRecipe): PrototypeSet {
  let byRecipe = sceneCaches.get(scene);
  if (!byRecipe) {
    byRecipe = new Map<string, PrototypeSet>();
    sceneCaches.set(scene, byRecipe);
    // Free all GPU resources this scene accumulated when it disposes.
    scene.onDisposeObservable.addOnce(() => {
      disposeSceneCache(scene);
    });
  }
  const key = cacheKey(recipe);
  let set = byRecipe.get(key);
  if (!set) {
    set = buildPrototypeSet(scene, recipe);
    byRecipe.set(key, set);
  }
  return set;
}

/** Dispose all cached prototype sets for a scene (called on scene disposal). */
export function disposeSceneCache(scene: Scene): void {
  const byRecipe = sceneCaches.get(scene);
  if (!byRecipe) return;
  for (const set of byRecipe.values()) {
    try {
      set.dispose();
    } catch {
      /* best-effort teardown */
    }
  }
  byRecipe.clear();
  sceneCaches.delete(scene);
}
