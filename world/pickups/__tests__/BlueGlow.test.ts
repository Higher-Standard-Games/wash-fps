import { describe, expect, it } from "vitest";
import { blueGlowMask, blueGlowWeight } from "../BlueGlow";

describe("blue glow mask", () => {
  it("glows strongly blue texels and leaves grey, white, black and red ones dark", () => {
    expect(blueGlowWeight(20, 140, 255)).toBe(1); // the megahealth's cyan-blue
    expect(blueGlowWeight(200, 200, 200)).toBe(0);
    expect(blueGlowWeight(255, 255, 255)).toBe(0);
    expect(blueGlowWeight(0, 0, 0)).toBe(0);
    expect(blueGlowWeight(255, 40, 40)).toBe(0);
  });

  it("fades in as blue pulls ahead of red and green", () => {
    const faint = blueGlowWeight(100, 100, 140);
    const clear = blueGlowWeight(100, 100, 170);
    expect(faint).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(faint);
    expect(clear).toBeLessThan(1);
  });

  it("keeps a glowing texel's own colour and blacks out the rest, opaque", () => {
    const mask = blueGlowMask(new Uint8Array([20, 140, 255, 0, 200, 200, 200, 255]));
    expect(Array.from(mask)).toEqual([20, 140, 255, 255, 0, 0, 0, 255]);
  });
});
