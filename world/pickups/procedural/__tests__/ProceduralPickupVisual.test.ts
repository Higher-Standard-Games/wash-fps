/**
 * ProceduralPickupVisual lifecycle (Babylon NullEngine): construction, the
 * fail-closed active-state machine, collection transients that survive the
 * persistent visual being hidden, the fixed anchor invariant, and clean disposal.
 */

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
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

  it("lets the emblem read through the health shell, in the tier colour", () => {
    // The orb rendered as a black hole ringed in colour. Two causes, both here:
    // the shell wrote depth, so its near hemisphere rejected the cross behind
    // it; and the face-on fresnel floors were low enough that whatever survived
    // carried no colour. Mega has the same shell, which is why it went black too.
    for (const id of ["health_large", "health_mega"]) {
      const recipe = getProceduralPickupRecipe(id);
      if (!recipe) throw new Error(`recipe missing: ${id}`);
      const visual = new ProceduralPickupVisual(scene, recipe, new Vector3(0, 50, 0), false, 1);

      const shell = scene.meshes.find((m) => m.name.startsWith("pp_shell_"));
      const material = shell?.material as StandardMaterial;
      expect(material).toBeTruthy();
      // Without this the cross is depth-rejected however the fresnels are tuned.
      expect(material.disableDepthWrite).toBe(true);

      // Face-on the shell must still carry its colour and enough alpha to show
      // it — emissive is multiplied by opacity, so a dark floor on either one is
      // enough to produce the hole.
      expect(material.emissiveFresnelParameters!.rightColor.r).toBeGreaterThan(0.3);
      expect(material.opacityFresnelParameters!.rightColor.r).toBeGreaterThan(0.3);
      // The rim stays hotter than the centre, or the orb flattens into a ball.
      expect(material.emissiveFresnelParameters!.leftColor.r).toBeGreaterThan(
        material.emissiveFresnelParameters!.rightColor.r,
      );
      expect(material.emissiveColor.r).toBeGreaterThan(0.5); // red for mega, orange for large

      visual.dispose();
    }
  });

  it("builds the v5 tier shapes: fresnel shell + capped cross for health, sculpted shell for armor", () => {
    const health = getProceduralPickupRecipe("health_large");
    const red = getProceduralPickupRecipe("armor_ra");
    if (!health || !red) throw new Error("recipe missing");

    const hv = new ProceduralPickupVisual(scene, health, new Vector3(0, 50, 0), false, 1);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_shell_"))).toBe(true);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_cross_"))).toBe(true);
    // The cross's up/down faces are a separate mesh in the tier colour.
    expect(scene.meshes.some((m) => m.name.startsWith("pp_cross_caps_"))).toBe(true);

    const av = new ProceduralPickupVisual(scene, red, new Vector3(100, 50, 0), false, 2);
    // Armor is ONE sculpted shell — tier reads from colour and size, so there
    // are no longer per-tier chevron bars to count.
    expect(scene.meshes.some((m) => m.name.startsWith("pp_armor_"))).toBe(true);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_chev_"))).toBe(false);

    hv.dispose();
    av.dispose();
    expect(cloneMeshes()).toHaveLength(0);
  });

  it("gives every health tier a ring whose gradient scrolls, and disposes it", () => {
    const small = getProceduralPickupRecipe("health_small");
    if (!small) throw new Error("recipe missing");

    const visual = new ProceduralPickupVisual(scene, small, new Vector3(0, 50, 0), false, 3);
    const ring = scene.meshes.find((m) => m.name.startsWith("pp_ring_"));
    expect(ring).toBeDefined();

    const mat = ring?.material as { emissiveTexture?: { uOffset: number } } | null;
    const before = mat?.emissiveTexture?.uOffset ?? 0;
    visual.update(1 / 60, 1.5);
    const after = mat?.emissiveTexture?.uOffset ?? 0;
    expect(after).not.toBe(before);

    visual.dispose();
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

describe("ProceduralPickupVisual — ammo crates", () => {
  it("builds a crate plus its four side decals, and cleans both up", () => {
    const recipe = getProceduralPickupRecipe("ammo_rockets");
    if (!recipe) throw new Error("recipe missing");

    const visual = new ProceduralPickupVisual(scene, recipe, new Vector3(0, 40, 0), false, 5);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_ammo_crate_"))).toBe(true);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_ammo_icon_"))).toBe(true);

    visual.dispose();
    expect(scene.meshes.filter((m) => m.name.startsWith("pp_ammo_"))).toHaveLength(0);
  });

  it("keeps the icon decal invisible until its texture resolves", () => {
    const recipe = getProceduralPickupRecipe("ammo_bullets");
    if (!recipe) throw new Error("recipe missing");

    const visual = new ProceduralPickupVisual(scene, recipe, new Vector3(0, 40, 0), false, 6);
    const icon = scene.meshes.find((m) => m.name.startsWith("pp_ammo_icon_"));
    // Headless: the pk3 loader never resolves, so the decal must stay fully
    // transparent rather than rendering as a white square.
    expect((icon?.material as { alpha?: number } | null)?.alpha).toBe(0);

    visual.dispose();
  });

  it("carries no health or armor geometry", () => {
    const recipe = getProceduralPickupRecipe("ammo_lasers");
    if (!recipe) throw new Error("recipe missing");

    const visual = new ProceduralPickupVisual(scene, recipe, new Vector3(0, 40, 0), false, 7);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_cross_"))).toBe(false);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_armor_"))).toBe(false);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_shell_"))).toBe(false);

    visual.dispose();
  });
});

describe("ProceduralPickupVisual — quad powerup", () => {
  it("builds the gem, the blades and a beacon, and cleans them all up", () => {
    const recipe = getProceduralPickupRecipe("powerup_quad");
    if (!recipe) throw new Error("recipe missing");

    const visual = new ProceduralPickupVisual(scene, recipe, new Vector3(0, 50, 0), false, 11);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_powerup_core_"))).toBe(true);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_powerup_blades_"))).toBe(true);
    // It is the only item on the map — it gets the arena-scale beacon.
    expect(scene.meshes.some((m) => m.name.startsWith("pp_beacon_"))).toBe(true);

    visual.dispose();
    expect(cloneMeshes()).toHaveLength(0);
  });

  it("borrows no health, armor or ammo geometry", () => {
    const recipe = getProceduralPickupRecipe("powerup_quad");
    if (!recipe) throw new Error("recipe missing");

    const visual = new ProceduralPickupVisual(scene, recipe, new Vector3(0, 50, 0), false, 12);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_cross_"))).toBe(false);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_armor_"))).toBe(false);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_ammo_"))).toBe(false);
    expect(scene.meshes.some((m) => m.name.startsWith("pp_shell_"))).toBe(false);

    visual.dispose();
  });

  it("counter-rotates the blade cage against the root spin", () => {
    const recipe = getProceduralPickupRecipe("powerup_quad");
    if (!recipe) throw new Error("recipe missing");

    const visual = new ProceduralPickupVisual(scene, recipe, new Vector3(0, 50, 0), false, 13);
    const pivot = scene.transformNodes.find((n) => n.name.startsWith("pp_bladepivot_"));
    const cosmetic = scene.transformNodes.find((n) => n.name.startsWith("pp_cosmetic_"));
    expect(pivot).toBeDefined();
    expect(cosmetic).toBeDefined();

    visual.update(1 / 60, 2);
    // Opposite signs = the cage turns against the body it sits on.
    expect(Math.sign(pivot?.rotation.y ?? 0)).toBe(-Math.sign(cosmetic?.rotation.y ?? 0));
    expect(pivot?.rotation.y).not.toBe(0);

    visual.dispose();
  });

  it("keeps the authoritative anchor fixed while animating", () => {
    const recipe = getProceduralPickupRecipe("powerup_quad");
    if (!recipe) throw new Error("recipe missing");

    const visual = new ProceduralPickupVisual(scene, recipe, new Vector3(64, 32, -16), false, 14);
    const before = visual.root.position.clone();
    for (let i = 0; i < 30; i++) visual.update(1 / 60, i / 60);
    expect(visual.root.position.x).toBe(before.x);
    expect(visual.root.position.y).toBe(before.y);
    expect(visual.root.position.z).toBe(before.z);

    visual.dispose();
  });
});
