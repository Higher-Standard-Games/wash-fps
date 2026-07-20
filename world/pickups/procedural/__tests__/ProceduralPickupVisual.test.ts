/**
 * ProceduralPickupVisual lifecycle (Babylon NullEngine): construction, the
 * fail-closed active-state machine, collection transients that survive the
 * persistent visual being hidden, the fixed anchor invariant, and clean disposal.
 */

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProceduralPickupRecipe } from "../ProceduralPickupRecipes";
import { ProceduralPickupVisual } from "../ProceduralPickupVisual";

let engine: NullEngine;
let scene: Scene;

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
});

afterEach(() => {
  scene.dispose(); // triggers the asset-cache scene-dispose hook
  engine.dispose();
});

function cloneMeshes(): string[] {
  return scene.meshes.filter((m) => m.name.startsWith("pp_")).map((m) => m.name);
}
function transientMeshes(): number {
  return scene.meshes.filter((m) => m.name.startsWith("pp_transient")).length;
}

describe("ProceduralPickupVisual", () => {
  it("builds cloned geometry and disposes it cleanly (no clone/material leak)", () => {
    const recipe = getProceduralPickupRecipe("health_medium");
    if (!recipe) throw new Error("recipe missing");

    const visual = new ProceduralPickupVisual(scene, recipe, new Vector3(0, 50, 0), true, 7);
    expect(visual.root).toBeTruthy();
    expect(cloneMeshes().length).toBeGreaterThan(0);
    // Private soft material exists while alive.
    expect(scene.getMaterialByName("pp_soft_health_medium_7")).toBeTruthy();

    // Updating while hidden is safe.
    visual.update(1 / 60, 0.1);

    visual.dispose();
    // All per-pickup clones gone; prototypes (proto_*) stay in the cache.
    expect(cloneMeshes()).toHaveLength(0);
    expect(scene.getMaterialByName("pp_soft_health_medium_7")).toBeNull();
  });

  it("applies the first authoritative state silently (no collection burst)", () => {
    const recipe = getProceduralPickupRecipe("armor_ya");
    if (!recipe) throw new Error("recipe missing");

    const visual = new ProceduralPickupVisual(scene, recipe, new Vector3(0, 50, 0), true, 3);

    // First reconcile = inactive → silent, no transient.
    visual.setActive(false);
    expect(transientMeshes()).toBe(0);

    // First activation after an unknown/inactive start = no respawn burst either.
    visual.setActive(true);
    expect(transientMeshes()).toBe(0);

    visual.dispose();
  });

  it("spawns a collection transient on active→inactive that self-disposes", () => {
    const recipe = getProceduralPickupRecipe("armor_ya");
    if (!recipe) throw new Error("recipe missing");

    const visual = new ProceduralPickupVisual(scene, recipe, new Vector3(0, 50, 0), true, 5);
    visual.setActive(true); // first known state (silent show)

    visual.setActive(false); // real collection → transient
    expect(transientMeshes()).toBeGreaterThan(0);

    // The transient is parented to the fixed anchor, so it keeps animating after
    // the persistent visual is hidden. Advance well past its duration.
    for (let i = 0; i < 60; i++) visual.update(0.05, 1 + i * 0.05);
    expect(transientMeshes()).toBe(0);

    visual.dispose();
    expect(cloneMeshes()).toHaveLength(0);
  });

  it("builds the v4 tier shapes: fresnel shell for health, chevrons by armor tier", () => {
    const health = getProceduralPickupRecipe("health_large");
    const red = getProceduralPickupRecipe("armor_ra");
    if (!health || !red) throw new Error("recipe missing");

    const hv = new ProceduralPickupVisual(scene, health, new Vector3(0, 50, 0), false, 1);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_shell_"))).toBe(true);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_cross_"))).toBe(true);

    const av = new ProceduralPickupVisual(scene, red, new Vector3(100, 50, 0), false, 2);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_shield_"))).toBe(true);
    // Red armor = 4 glowing chevron bars on the shield face.
    expect(scene.meshes.filter((m) => m.name.startsWith("pp_chev_")).length).toBe(4);

    hv.dispose();
    av.dispose();
    expect(cloneMeshes()).toHaveLength(0);
  });

  it("never moves the authoritative anchor while animating", () => {
    const recipe = getProceduralPickupRecipe("health_mega");
    if (!recipe) throw new Error("recipe missing");

    const visual = new ProceduralPickupVisual(scene, recipe, new Vector3(10, 64, -20), false, 0);
    const before = visual.root.position.clone();

    for (let i = 0; i < 30; i++) visual.update(1 / 60, i / 60);

    expect(visual.root.position.x).toBe(before.x);
    expect(visual.root.position.y).toBe(before.y);
    expect(visual.root.position.z).toBe(before.z);

    visual.dispose();
  });
});
