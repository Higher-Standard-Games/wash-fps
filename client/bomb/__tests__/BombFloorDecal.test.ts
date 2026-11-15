import { describe, expect, it } from "vitest";
import { floorGlowAt, floorGlowPixels } from "../BombFloorDecal";

describe("bomb floor glow", () => {
  it("is brightest at the centre and fades to nothing at the edge", () => {
    expect(floorGlowAt(0, 0)).toBeGreaterThan(0.9);
    expect(floorGlowAt(0.5, 0)).toBeLessThan(floorGlowAt(0.1, 0));
    expect(floorGlowAt(0.97, 0)).toBeLessThan(0.02);
    expect(floorGlowAt(1, 0)).toBe(0);
  });

  it("has arms that vary with angle away from the centre, but not at it", () => {
    const around = (r: number) => Array.from({ length: 24 }, (_, i) => floorGlowAt(r, (i / 24) * Math.PI * 2));
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    expect(spread(around(0.5))).toBeGreaterThan(0.1);
    expect(spread(around(0.02))).toBeLessThan(0.02);
  });

  it("leaves the texture's corners transparent", () => {
    const pixels = floorGlowPixels(16);
    expect(pixels[3]).toBe(0);
    expect(pixels[pixels.length - 1]).toBe(0);
  });
});
