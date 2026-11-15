import { describe, expect, it } from "vitest";
import { Contents } from "../../../../shared/collision/CollisionWorld";
import { inHarmfulLiquid, liquidEscapeTarget } from "../LiquidEscape";

/** A pool of slime up to y = 0 over |x| < 500, with water beside it; walls only where `walls` says. */
function world(walls: (from: { x: number }, to: { x: number }) => boolean = () => false) {
  return {
    pointContents: ({ x, y }: { x: number; y: number }) =>
      y < 0 && Math.abs(x) < 500 ? Contents.SLIME | Contents.WATER : y < 0 && x > 1000 ? Contents.WATER : 0,
    trace: (from: { x: number }, to: { x: number }) =>
      walls(from, to) ? { hit: true, fraction: 0.5 } : { hit: false, fraction: 1 },
  } as never;
}

const at = (x: number, y = 24, z = 0) => ({ x, y, z });

describe("liquid escape", () => {
  it("knows slime and lava from water", () => {
    expect(inHarmfulLiquid(world(), at(0, -10))).toBe(true);
    expect(inHarmfulLiquid(world(), at(0, 40))).toBe(false);
    // Water hurts nobody
    expect(inHarmfulLiquid(world(), at(1200, -10))).toBe(false);
  });

  it("makes for the nearest bank in sight, not one under the pool", () => {
    const nodes = [at(-600), at(700), at(100, -10), at(50, -2000)].map((position) => ({ position }));
    expect(liquidEscapeTarget(world(), at(200, -10), nodes)).toEqual(at(700));
  });

  it("takes a bank out of sight only when none is in sight", () => {
    const nodes = [at(-600), at(700)].map((position) => ({ position }));
    const nearWalled = world((_from, to) => to.x === 700);
    expect(liquidEscapeTarget(nearWalled, at(200, -10), nodes)).toEqual(at(-600));
    const allWalled = world(() => true);
    expect(liquidEscapeTarget(allWalled, at(200, -10), nodes)).toEqual(at(700));
  });

  it("has nowhere to go with no dry node", () => {
    expect(liquidEscapeTarget(world(), at(0, -10), [{ position: at(100, -10) }])).toBeNull();
  });
});
