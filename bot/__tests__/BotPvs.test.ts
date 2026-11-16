import { describe, expect, it } from "vitest";
import { BotPvs } from "../BotPvs";

/**
 * Two rooms either side of the plane x = 0 (clusters 0 and 1), and a leaf of
 * solid (cluster -1) beyond y = 100 on the far side. `apart` rooms cannot see
 * each other.
 */
function map(apart: boolean) {
  const leaf = (cluster: number) => ({
    cluster,
    area: 0,
    mins: [0, 0, 0] as [number, number, number],
    maxs: [0, 0, 0] as [number, number, number],
    firstLeafFace: 0,
    numLeafFaces: 0,
    firstLeafBrush: 0,
    numLeafBrushes: 0,
  });
  const box = [0, 0, 0] as [number, number, number];
  return {
    // Node 0: x >= 0 → node 1, else leaf 0 (cluster 0). Node 1: y >= 100 (BSP axes) → leaf 2 (solid), else leaf 1.
    nodes: [
      { planeIndex: 0, children: [1, -1] as [number, number], mins: box, maxs: box },
      { planeIndex: 1, children: [-3, -2] as [number, number], mins: box, maxs: box },
    ],
    planes: [
      { normal: [1, 0, 0] as [number, number, number], dist: 0, type: 0 },
      { normal: [0, 1, 0] as [number, number, number], dist: 100, type: 1 },
    ],
    leafs: [leaf(0), leaf(1), leaf(-1)],
    visData: {
      numClusters: 2,
      bytesPerCluster: 1,
      // Each row: the clusters it may see
      bitVectors: new Uint8Array(apart ? [0b01, 0b10] : [0b11, 0b11]),
    },
  };
}

describe("the PVS for bot sight", () => {
  it("rules out a line between clusters that cannot see each other, both ways", () => {
    const pvs = BotPvs.from(map(true) as never)!;
    const west = { x: -50, y: 0, z: 0 };
    const east = { x: 50, y: 0, z: 0 };
    expect(pvs.cluster(west)).toBe(0);
    expect(pvs.cluster(east)).toBe(1);
    expect(pvs.mayBeVisible(west, east)).toBe(false);
    expect(pvs.mayBeVisible(east, west)).toBe(false);
    expect(pvs.mayBeVisible(west, { x: -10, y: 5, z: 0 })).toBe(true);
  });

  it("leaves the trace to decide where the rooms can see each other, or a point is in solid", () => {
    expect(BotPvs.from(map(false) as never)!.mayBeVisible({ x: -50, y: 0, z: 0 }, { x: 50, y: 0, z: 0 })).toBe(true);
    // Game axes: the BSP's y is the game's z
    const solid = { x: 50, y: 0, z: 150 };
    const pvs = BotPvs.from(map(true) as never)!;
    expect(pvs.cluster(solid)).toBe(-1);
    expect(pvs.mayBeVisible({ x: -50, y: 0, z: 0 }, solid)).toBe(true);
  });

  it("has nothing to say for a map without vis data", () => {
    expect(BotPvs.from({ ...map(true), visData: null } as never)).toBeNull();
  });
});
