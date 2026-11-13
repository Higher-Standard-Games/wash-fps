import { describe, expect, it } from "vitest";
import type { Vec3 } from "../BotGameState";
import { BotNavGraph } from "../BotNavGraph";
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

/** Walkable unless the walk crosses x = 100. */
const noWall = (from: Vec3, to: Vec3) => Math.sign(from.x - 100) === Math.sign(to.x - 100);

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
    expect(nav.addLearnedRoutes([route({ x: 0, y: 24, z: 200 })], () => false)).toBe(0);
    expect(nav.nodeCount).toBe(3);
  });
});
