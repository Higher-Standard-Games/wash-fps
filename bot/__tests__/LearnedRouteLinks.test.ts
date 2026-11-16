import { describe, expect, it } from "vitest";
import type { Vec3 } from "../BotGameState";
import { BotNavGraph, type WalkTest } from "../BotNavGraph";
import type { LearnedRoute } from "../LearnedRoutes";

/** A floor at y 0 with a wall along x = 100: nodes either side, none at the landing. */
function graph(): BotNavGraph {
  const nav = new BotNavGraph("links");
  nav.loadStaticData({
    nodes: [
      { id: 0, type: "floor", position: { x: -400, y: 0, z: 0 } },
      { id: 1, type: "floor", position: { x: -100, y: 0, z: 200 } },
      { id: 2, type: "floor", position: { x: 200, y: 0, z: 200 } },
    ],
    edges: [],
  });
  return nav;
}

function route(landing: Vec3): LearnedRoute {
  return {
    id: "demo@1",
    kind: "jump",
    start: { x: -400, y: 24, z: 0 },
    yaw: 0,
    landing,
    ticks: 100,
    script: [],
    wallJumps: 0,
    replayError: 0,
    robustness: { landed: 1, tried: 1 },
    source: { demo: "demo", tick: 1 },
  };
}

/** Walkable straight unless the walk crosses x = 100; no way round. */
const straightOnly = (straight: (from: Vec3, to: Vec3) => boolean): WalkTest => ({
  straight,
  wallCost: () => 0,
  reach: () => null,
});
const noWall = straightOnly((from, to) => Math.sign(from.x - 100) === Math.sign(to.x - 100));

const linkTargets = (nav: BotNavGraph, landingId: number) =>
  nav.edges
    .filter((e) => e.from === landingId && e.type === "walk")
    .map((e) => e.to)
    .sort();

describe("learned route landing links", () => {
  it("links a new landing only to nodes it can walk to", () => {
    const nav = graph();
    expect(nav.addLearnedRoutes([route({ x: 0, y: 24, z: 200 })], noWall)).toBe(1);
    expect(linkTargets(nav, 3)).toEqual([1]);
  });

  it("links every node in reach without a walk test", () => {
    const nav = graph();
    nav.addLearnedRoutes([route({ x: 0, y: 24, z: 200 })]);
    expect(linkTargets(nav, 3)).toEqual([1, 2]);
  });

  it("leaves out a route whose landing can walk nowhere", () => {
    const nav = graph();
    expect(
      nav.addLearnedRoutes(
        [route({ x: 0, y: 24, z: 200 })],
        straightOnly(() => false),
      ),
    ).toBe(0);
    expect(nav.nodeCount).toBe(3);
  });
});

describe("one walk test for graph and learned routes", () => {
  it("links a landing round a wall by the walk flood, with its corners", () => {
    const nav = graph();
    const corner = { x: 100, y: 1, z: 400 };
    const walk: WalkTest = {
      straight: (from, to) => Math.sign(from.x - 100) === Math.sign(to.x - 100),
      wallCost: () => 0,
      reach: (from, to) => (from.id === 3 && to.id === 2 ? { distance: 500, via: [corner] } : null),
    };
    expect(nav.addLearnedRoutes([route({ x: 0, y: 24, z: 200 })], walk)).toBe(1);
    const round = nav.edges.find((e) => e.from === 3 && e.to === 2);
    expect(round?.via).toEqual([corner]);
    expect(round?.cost).toBe(500);
  });

  it("reports edges that fail the walk test they were built by", () => {
    const nav = graph();
    nav.addLearnedRoutes([route({ x: 0, y: 24, z: 200 })]);
    // Built without a walk test, the landing linked through the wall to node 2.
    const failures = nav.checkEdges(noWall);
    expect(failures.map((f) => [f.edge.from, f.edge.to, f.reason])).toEqual([
      [3, 2, "straight walk blocked"],
      [2, 3, "straight walk blocked"],
    ]);
    const clean = graph();
    clean.addLearnedRoutes([route({ x: 0, y: 24, z: 200 })], noWall);
    expect(clean.checkEdges(noWall)).toEqual([]);
  });
});
