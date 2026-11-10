import { describe, expect, it } from "vitest";
import { splitCore } from "../QuadCore";

/** A square ring of four quads around a small centred square: the ring and its core. */
function ringAroundCore() {
  const positions: number[] = [];
  const indices: number[] = [];
  const quad = (x0: number, y0: number, x1: number, y1: number) => {
    const base = positions.length / 3;
    positions.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad(-2, 1, 2, 2);
  quad(-2, -2, 2, -1);
  quad(-2, -1, -1, 1);
  quad(1, -1, 2, 1);
  quad(-0.5, -0.5, 0.7, 0.5); // the core, a little off centre
  return { positions, indices };
}

describe("quad core", () => {
  it("lifts the innermost part out about its own centre and leaves the rest", () => {
    const { positions, indices } = ringAroundCore();
    const uvs = positions.flatMap((_, i) => (i % 3 === 0 ? [i, i] : []));
    const split = splitCore(positions, null, uvs, indices)!;
    expect(split.rest).toEqual(indices.slice(0, 24));
    for (const [axis, value] of [0.1, 0, 0].entries()) expect(split.centre[axis]).toBeCloseTo(value);
    expect(split.core.indices).toEqual([0, 1, 2, 0, 2, 3]);
    // Centred on itself, so it turns in place
    for (const [axis, value] of [-0.6, -0.5, 0].entries()) expect(split.core.positions?.[axis]).toBeCloseTo(value);
    expect(split.core.uvs).toEqual(uvs.slice(32, 40));
  });

  it("leaves a model alone when nothing sits inside it", () => {
    const { positions, indices } = ringAroundCore();
    expect(splitCore(positions.slice(0, 48), null, null, indices.slice(0, 24))).toBeNull();
  });
});
