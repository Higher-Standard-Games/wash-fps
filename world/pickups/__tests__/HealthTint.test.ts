import { describe, expect, it } from "vitest";
import { innermostPart, recolorBluePixels, tintPixels, tintTexel, triangleMask } from "../HealthTint";

describe("health bubble tint", () => {
  it("turns the bubble's blue to the tier's hue and keeps grey and white as they are", () => {
    const [r, g, b] = tintTexel(20, 140, 255, { hue: 0, lightness: 1 });
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(40);
    expect(b).toBeLessThan(40);
    expect(tintTexel(128, 128, 128, { hue: 28, lightness: 1 })).toEqual([128, 128, 128]);
    expect(tintTexel(255, 255, 255, { hue: 28, lightness: 1 })).toEqual([255, 255, 255]);
  });

  it("darkens by the tier's lightness and leaves the +5 untouched", () => {
    const [light] = tintTexel(20, 140, 255, { hue: 0, lightness: 1 });
    const [dark] = tintTexel(20, 140, 255, { hue: 0, lightness: 0.72 });
    expect(dark).toBeLessThan(light);
    expect(tintTexel(20, 140, 255, { hue: null, lightness: 1 })).toEqual([20, 140, 255]);
  });

  it("glows the strongly blue cross fully and the pale rest dimly", () => {
    const { glow } = tintPixels(new Uint8Array([20, 140, 255, 255, 200, 210, 220, 255]), { hue: 28, lightness: 1 });
    const cross = glow[0] + glow[1] + glow[2];
    const rim = glow[4] + glow[5] + glow[6];
    expect(cross).toBeGreaterThan(rim);
    expect(glow[3]).toBe(255);
  });

  it("gives fullbright texels no lit colour and their full colour as glow", () => {
    const pale = new Uint8Array([200, 210, 220, 255, 200, 210, 220, 255]);
    const { color, glow } = tintPixels(pale, { hue: 28, lightness: 1 }, new Uint8Array([255, 0]));
    expect([color[0], color[1], color[2]]).toEqual([0, 0, 0]);
    expect([glow[0], glow[1], glow[2]]).toEqual([color[4], color[5], color[6]]);
    expect(glow[4]).toBeLessThan(color[4]);
  });

  it("finds the innermost part of a model and masks its texels", () => {
    // A wide frame around the centre (two quads, left and right) and a small square in the middle
    const positions = [
      ...[-1, -1, 0, -0.8, -1, 0, -0.8, 1, 0, -1, 1, 0],
      ...[0.8, -1, 0, 1, -1, 0, 1, 1, 0, 0.8, 1, 0],
      ...[-0.2, -0.2, 0, 0.2, -0.2, 0, 0.2, 0.2, 0, -0.2, 0.2, 0],
    ];
    const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11];
    // Join the frame's halves through a shared corner, so it spans the centre as one part
    positions.push(-0.8, 1, 0, 0.8, 1, 0, 0, 1.2, 0);
    indices.push(12, 13, 14);
    const inner = innermostPart(positions, indices);
    expect(inner).toEqual([12, 15]);

    // The middle square's texture is the top-left quarter of an 8 x 8 texture
    const uvs = new Array((positions.length / 3) * 2).fill(0.9);
    uvs.splice(16, 8, 0, 0, 0.25, 0, 0.25, 0.25, 0, 0.25);
    const mask = triangleMask(uvs, indices, inner, 8, 8);
    expect(mask[0]).toBe(255);
    expect(mask[1 * 8 + 1]).toBe(255);
    expect(mask[7 * 8 + 7]).toBe(0);
  });
});

describe("ultra health core", () => {
  it("turns the cyan and blue texels purple, and only they glow", () => {
    const pixels = new Uint8Array([20, 60, 230, 255, 200, 200, 200, 255, 230, 40, 40, 255, 30, 190, 250, 255]);
    const { color, glow } = recolorBluePixels(pixels, 285);
    // The blue core: purple, red and blue both well above green
    expect(color[0]).toBeGreaterThan(color[1] + 60);
    expect(color[2]).toBeGreaterThan(color[1] + 60);
    expect(glow[2]).toBeGreaterThan(100);
    // Grey and red keep their colour and stay dark
    expect([...color.slice(4, 12)]).toEqual([200, 200, 200, 255, 230, 40, 40, 255]);
    expect([...glow.slice(4, 7), ...glow.slice(8, 11)]).toEqual([0, 0, 0, 0, 0, 0]);
    // The cyan of the cross turns too
    expect(color[12]).toBeGreaterThan(color[13]);
    expect(glow[14]).toBeGreaterThan(50);
  });
});
