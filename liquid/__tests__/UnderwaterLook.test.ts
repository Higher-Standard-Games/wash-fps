/**
 * Underwater presentation (water Phase 3).
 *
 * Two rules worth protecting. Mechanics switch instantly and presentation does
 * not, because a camera skimming the surface would otherwise strobe the whole
 * screen. And the comfort setting must be able to remove the motion entirely
 * while leaving the colour, so nothing about being underwater is communicated
 * by movement alone.
 */

import { describe, expect, it } from "vitest";
import {
  approachSubmersion,
  fogDensityFor,
  fovWarpDegrees,
  lookFor,
  WARP_AMPLITUDE_DEGREES,
} from "../client/UnderwaterLook";

describe("liquid looks", () => {
  it("gives each liquid its own colour", () => {
    const water = lookFor("water");
    const slime = lookFor("slime");
    const lava = lookFor("lava");

    // Water reads blue-green, slime green, lava red — by channel dominance
    // rather than by exact values, so tuning does not break the test.
    expect(water.color[2]).toBeGreaterThan(water.color[0]);
    expect(slime.color[1]).toBeGreaterThan(slime.color[0]);
    expect(slime.color[1]).toBeGreaterThan(slime.color[2]);
    expect(lava.color[0]).toBeGreaterThan(lava.color[1]);
  });

  it("makes slime and lava thicker than water", () => {
    // You should be able to fight underwater. You should not be able to see
    // much of anything inside lava.
    expect(lookFor("slime").density).toBeGreaterThan(lookFor("water").density);
    expect(lookFor("lava").density).toBeGreaterThan(lookFor("slime").density);
  });

  it("keeps water playable rather than opaque", () => {
    // Exponential-squared fog at this density still shows a body at fighting
    // range; an order of magnitude more would not.
    expect(lookFor("water").density).toBeLessThan(0.01);
  });
});

describe("fogDensityFor", () => {
  it("is nothing when dry", () => {
    expect(fogDensityFor(lookFor("water"), 0)).toBe(0);
  });

  it("scales with how submerged the camera is", () => {
    const look = lookFor("water");

    expect(fogDensityFor(look, 0.5)).toBeCloseTo(look.density / 2, 6);
    expect(fogDensityFor(look, 1)).toBeCloseTo(look.density, 6);
  });
});

describe("approachSubmersion", () => {
  it("moves toward the target rather than snapping", () => {
    const next = approachSubmersion(0, 1, 1 / 60);

    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(1);
  });

  it("gets there in roughly 150ms", () => {
    let value = 0;
    for (let i = 0; i < 9; i++) value = approachSubmersion(value, 1, 1 / 60);

    // Nine frames at 60Hz is 150ms; most of the transition should be done.
    expect(value).toBeGreaterThan(0.6);
  });

  it("reaches the target exactly instead of asymptotically", () => {
    // Without the snap, fog density that should be off would haunt the scene
    // at a millionth of its value forever.
    let value = 1;
    for (let i = 0; i < 200; i++) value = approachSubmersion(value, 0, 1 / 60);

    expect(value).toBe(0);
  });

  it("survives a long frame without overshooting", () => {
    // A hitch must not push the mix past its target and invert the fade.
    expect(approachSubmersion(0, 1, 10)).toBe(1);
  });
});

describe("fovWarpDegrees", () => {
  it("is silent on dry land", () => {
    expect(fovWarpDegrees(1.234, 0, 1)).toBe(0);
  });

  it("oscillates around zero rather than drifting", () => {
    // The warp adds to a base FOV, so a non-zero mean would slowly zoom the
    // player's view for as long as they stayed under.
    let sum = 0;
    const samples = 400;
    for (let i = 0; i < samples; i++) sum += fovWarpDegrees((i / samples) * 5, 1, 1);

    expect(Math.abs(sum / samples)).toBeLessThan(0.05);
  });

  it("stays within one degree, as Quake had it", () => {
    for (let i = 0; i < 200; i++) {
      expect(Math.abs(fovWarpDegrees(i * 0.05, 1, 1))).toBeLessThanOrEqual(WARP_AMPLITUDE_DEGREES);
    }
  });

  it("stops entirely at comfort zero", () => {
    // The accessibility requirement: no motion at all, while tint and fog
    // still say you are underwater.
    for (let i = 0; i < 50; i++) {
      expect(fovWarpDegrees(i * 0.1, 1, 0)).toBe(0);
    }
  });

  it("scales smoothly with the comfort setting", () => {
    const full = Math.abs(fovWarpDegrees(0.625, 1, 1));
    const half = Math.abs(fovWarpDegrees(0.625, 1, 0.5));

    expect(half).toBeCloseTo(full / 2, 6);
  });

  it("fades in with submersion so surfacing does not jolt", () => {
    const deep = Math.abs(fovWarpDegrees(0.625, 1, 1));
    const shallow = Math.abs(fovWarpDegrees(0.625, 0.25, 1));

    expect(shallow).toBeCloseTo(deep / 4, 6);
  });
});
