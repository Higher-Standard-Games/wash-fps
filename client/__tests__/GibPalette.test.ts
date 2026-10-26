/**
 * A gibbed body breaks down into its own colour: the colour the player was
 * drawn with, a lighter tint and a darker shade. In FFA every opponent has a
 * colour of their own, so the gibs differ per player.
 */

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { GibSystem, gibPalette } from "../GibSystem";

describe("gib palette", () => {
  it("keeps the player's hue exactly, with a lighter tint and a darker shade", () => {
    const [own, light, dark] = gibPalette({ r: 0.2, g: 0.6, b: 1 });
    expect([own.diffuse.r, own.diffuse.g, own.diffuse.b]).toEqual([0.2, 0.6, 1]);
    expect(light.diffuse.r).toBeGreaterThan(own.diffuse.r);
    expect(light.diffuse.g).toBeGreaterThan(own.diffuse.g);
    expect(dark.diffuse.b).toBeLessThan(own.diffuse.b);
    // Same hue in the shade: channel ratios unchanged
    expect(dark.diffuse.r / dark.diffuse.b).toBeCloseTo(0.2);
  });

  it("takes an over-bright model tint at full brightness without flattening its hue", () => {
    // The shipped ally tint is an emissive multiplier past 1.0
    const [own] = gibPalette({ r: 1.55, g: 0.2, b: 1.35 });
    expect(own.diffuse.r).toBeCloseTo(1);
    expect(own.diffuse.g).toBeCloseTo(0.2 / 1.55);
    expect(own.diffuse.b).toBeCloseTo(1.35 / 1.55);
  });
});

describe("gib materials", () => {
  let engine: NullEngine;
  let scene: Scene;
  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  it("gives each player colour its own materials, reused for that colour, and keeps the default without one", () => {
    engine = new NullEngine();
    scene = new Scene(engine);
    const gibs = GibSystem.create(scene);
    const colorsOf = (color?: { r: number; g: number; b: number }) => {
      gibs.spawn(0, 0, 0, 0, 0, 0, color);
      const active = (gibs as unknown as { gibs: Array<{ active: boolean; mesh: { material: StandardMaterial } }> })
        .gibs;
      const names = new Set(active.filter((g) => g.active).map((g) => g.mesh.material.name));
      gibs.clear();
      return names;
    };
    const red = colorsOf({ r: 1, g: 0, b: 0 });
    expect([...red].every((name) => name.startsWith("gib_mat_1.00,0.00,0.00"))).toBe(true);
    const materialsBefore = scene.materials.length;
    colorsOf({ r: 1, g: 0, b: 0 });
    expect(scene.materials.length).toBe(materialsBefore);
    const blue = colorsOf({ r: 0, g: 0, b: 1 });
    expect([...blue].some((name) => red.has(name))).toBe(false);
    expect([...colorsOf()].every((name) => /^gib_mat_\d$/.test(name))).toBe(true);
    gibs.dispose();
  });
});
