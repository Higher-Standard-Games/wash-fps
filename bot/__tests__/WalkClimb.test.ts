/**
 * A walk climbs a step at a time: stairs are walkable, a ledge higher than a
 * step is not, though the straight sweep between the two ends clears both.
 */

import { describe, expect, it } from "vitest";
import { BotVision, type MapKnowledgeData } from "../BotVision";

/** Open air over a floor whose height depends on x. */
function visionOver(floorAt: (x: number) => number): BotVision {
  const world = {
    trace: (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, bounds?: unknown) => {
      if (bounds || Math.abs(to.x - from.x) > 1e-6 || Math.abs(to.z - from.z) > 1e-6)
        return { hit: false, fraction: 1 };
      const floor = floorAt(from.x);
      if (floor > from.y || floor < to.y) return { hit: false, fraction: 1 };
      return { hit: true, fraction: (from.y - floor) / (from.y - to.y), hitPoint: { x: from.x, y: floor, z: from.z } };
    },
  };
  const map = { spawnPoints: [], pickupPositions: [], triggerVolumes: [], mapFingerprint: "", mapName: "t" };
  return new BotVision(world as never, map as MapKnowledgeData, false);
}

describe("walk climb", () => {
  it("walks up stairs of 8-unit steps", () => {
    const stairs = visionOver((x) => (x < 100 ? 0 : Math.min(32, Math.floor((x - 100) / 16) * 8 + 8)));
    expect(stairs.isWalkable({ x: 0, y: 24, z: 0 }, { x: 300, y: 56, z: 0 })).toBe(true);
  });

  it("does not walk up a 30-unit ledge", () => {
    const ledge = visionOver((x) => (x < 150 ? 0 : 30));
    expect(ledge.isWalkable({ x: 0, y: 24, z: 0 }, { x: 300, y: 54, z: 0 })).toBe(false);
  });

  it("walks down off the same ledge", () => {
    const ledge = visionOver((x) => (x < 150 ? 30 : 0));
    expect(ledge.isWalkable({ x: 0, y: 54, z: 0 }, { x: 300, y: 24, z: 0 })).toBe(true);
  });
});
