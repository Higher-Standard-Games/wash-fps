import { describe, expect, it } from "vitest";
import { bombExplosionSignature } from "../BombSiteMarkers";

const EXPLOSION = {
  points: [{ x: 100, y: 200, z: 300, radius: 400, delay: 0.25 }],
};

describe("bombExplosionSignature", () => {
  it("deduplicates repeated snapshots within a round", () => {
    expect(bombExplosionSignature(3, EXPLOSION)).toBe(bombExplosionSignature(3, EXPLOSION));
  });

  it("lets the same authored detonation play again next round", () => {
    expect(bombExplosionSignature(3, EXPLOSION)).not.toBe(bombExplosionSignature(4, EXPLOSION));
  });

  it("returns to an armed state once the server removes the detonation", () => {
    expect(bombExplosionSignature(4, null)).toBeNull();
  });
});
