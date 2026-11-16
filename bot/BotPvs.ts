/**
 * The map's potentially visible set, for sight checks: two points in clusters
 * the compiler found no line of sight between cannot see each other, so the
 * sight trace between them is not run (BotVision.canSee). The PVS is
 * conservative (it says "maybe" wherever any sight line could pass), so this
 * only ever saves a trace that would have been blocked; anywhere it cannot
 * say (no vis data, a point in solid or outside every cluster) it answers
 * "maybe" and the trace decides.
 *
 * A point's cluster comes from a walk down the BSP tree: a plane test per
 * level, a few dozen at most.
 */

import type { BspCollisionData } from "../../../engine/loader/bsp/BspLoader";
import type { Vec3 } from "./BotGameState";

type PvsSource = Pick<BspCollisionData, "nodes" | "planes" | "leafs" | "visData">;

export class BotPvs {
  private readonly nodePlane: Int32Array;
  private readonly nodeChildren: Int32Array;
  /** Per plane: normal and distance. */
  private readonly planes: Float64Array;
  private readonly leafCluster: Int32Array;
  private readonly bits: Uint8Array;
  private readonly bytesPerCluster: number;
  private readonly clusters: number;

  private constructor(bsp: PvsSource) {
    const vis = bsp.visData!;
    this.nodePlane = Int32Array.from(bsp.nodes, (node) => node.planeIndex);
    this.nodeChildren = new Int32Array(bsp.nodes.length * 2);
    bsp.nodes.forEach((node, i) => {
      this.nodeChildren[i * 2] = node.children[0];
      this.nodeChildren[i * 2 + 1] = node.children[1];
    });
    this.planes = new Float64Array(bsp.planes.length * 4);
    for (const [i, plane] of bsp.planes.entries()) {
      this.planes.set([plane.normal[0], plane.normal[1], plane.normal[2], plane.dist], i * 4);
    }
    this.leafCluster = Int32Array.from(bsp.leafs, (leaf) => leaf.cluster);
    this.bits = vis.bitVectors;
    this.bytesPerCluster = vis.bytesPerCluster;
    this.clusters = vis.numClusters;
  }

  /** The PVS of a map, or null when the map has none to read. */
  static from(bsp: PvsSource): BotPvs | null {
    const vis = bsp.visData;
    if (!vis || vis.numClusters <= 0 || vis.bytesPerCluster <= 0 || bsp.nodes.length === 0) return null;
    if (vis.bitVectors.length < vis.numClusters * vis.bytesPerCluster) return null;
    return new BotPvs(bsp);
  }

  /** The cluster `point` (game axes) is in, or -1 in solid or outside every cluster. */
  cluster(point: Vec3): number {
    // Game axes are Y-up; the BSP's are Z-up
    const x = point.x;
    const y = point.z;
    const z = point.y;
    let node = 0;
    while (node >= 0) {
      const p = this.nodePlane[node] * 4;
      const side = x * this.planes[p] + y * this.planes[p + 1] + z * this.planes[p + 2] - this.planes[p + 3];
      node = this.nodeChildren[node * 2 + (side >= 0 ? 0 : 1)];
    }
    const cluster = this.leafCluster[-(node + 1)] ?? -1;
    return cluster < this.clusters ? cluster : -1;
  }

  /** False only when the compiler found no line of sight between the two points' clusters. */
  mayBeVisible(from: Vec3, to: Vec3): boolean {
    const a = this.cluster(from);
    const b = this.cluster(to);
    if (a < 0 || b < 0 || a === b) return true;
    return (this.bits[a * this.bytesPerCluster + (b >> 3)] & (1 << (b & 7))) !== 0;
  }
}
