/**
 * All-pairs travel cost and the reachability gate
 * (docs/research/BOT_WEIGHTS_AND_GOALS.md Phase 3).
 *
 * Phase 1 priced routes with a Euclidean estimate that could never fail, so the
 * arbiter's `unreachable` gate could never fire — a bot could commit to an item
 * on the far side of a wall and walk into it forever. Graph distance answers
 * reachability honestly; these tests are mostly about that, not about accuracy.
 */

import { describe, expect, it } from "vitest";
import type { PickupEntry } from "../../shared/bsp/PickupTable";
import { BotGameState } from "../BotGameState";
import { BotNavGraph, type NavGraphStaticData } from "../BotNavGraph";
import { ItemGoalPlanner } from "../goals/ItemGoalPlanner";

// ── Graph fixtures ───────────────────────────────────────────────────

/**
 * Two disconnected corridors:
 *   0 — 1 — 2        (near the origin)
 *   3 — 4            (far away, no edge to the first group)
 * Node 3 sits physically CLOSE to node 2 but is not connected to it, which is
 * exactly the "item behind a wall" case.
 */
function twoIslands(): BotNavGraph {
  const nodes = [
    { id: 0, position: { x: 0, y: 0, z: 0 }, type: "strategic" },
    { id: 1, position: { x: 200, y: 0, z: 0 }, type: "strategic" },
    { id: 2, position: { x: 400, y: 0, z: 0 }, type: "strategic" },
    { id: 3, position: { x: 450, y: 0, z: 0 }, type: "strategic" },
    { id: 4, position: { x: 650, y: 0, z: 0 }, type: "strategic" },
  ];
  const edges = [
    { from: 0, to: 1, type: "walk", cost: 200 },
    { from: 1, to: 0, type: "walk", cost: 200 },
    { from: 1, to: 2, type: "walk", cost: 200 },
    { from: 2, to: 1, type: "walk", cost: 200 },
    { from: 3, to: 4, type: "walk", cost: 200 },
    { from: 4, to: 3, type: "walk", cost: 200 },
  ];
  const graph = new BotNavGraph("test");
  graph.loadStaticData({ nodes, edges } as unknown as NavGraphStaticData);
  return graph;
}

/** A detour: 0 -> 1 -> 2 where 2 is physically near 0 but 400 units of walking. */
function detour(): BotNavGraph {
  const nodes = [
    { id: 0, position: { x: 0, y: 0, z: 0 }, type: "strategic" },
    { id: 1, position: { x: 0, y: 0, z: 500 }, type: "strategic" },
    { id: 2, position: { x: 100, y: 0, z: 0 }, type: "strategic" },
  ];
  const edges = [
    { from: 0, to: 1, type: "walk", cost: 500 },
    { from: 1, to: 0, type: "walk", cost: 500 },
    { from: 1, to: 2, type: "walk", cost: 500 },
    { from: 2, to: 1, type: "walk", cost: 500 },
  ];
  const graph = new BotNavGraph("test");
  graph.loadStaticData({ nodes, edges } as unknown as NavGraphStaticData);
  return graph;
}

describe("BotNavGraph.estimateTravelCost", () => {
  it("returns the summed edge cost along the shortest route", () => {
    const graph = twoIslands();
    expect(graph.estimateTravelCost({ x: 0, y: 0, z: 0 }, { x: 400, y: 0, z: 0 })).toBeCloseTo(400, 5);
  });

  it("returns null for a target in a disconnected component", () => {
    // Node 3 is 50 units from node 2 in straight line, and unreachable.
    const graph = twoIslands();
    expect(graph.estimateTravelCost({ x: 0, y: 0, z: 0 }, { x: 450, y: 0, z: 0 })).toBeNull();
  });

  it("prices a detour by the route, not by the straight line", () => {
    // Node 2 is 100 units away as the crow flies but 1000 units of walking.
    const graph = detour();
    const cost = graph.estimateTravelCost({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 });
    expect(cost).toBeCloseTo(1000, 5);
  });

  it("adds the off-node approach and arrival distances", () => {
    const graph = twoIslands();
    // 50 units before node 0, ending 50 past node 2.
    const cost = graph.estimateTravelCost({ x: -50, y: 0, z: 0 }, { x: 400, y: 0, z: 30 });
    expect(cost).toBeGreaterThan(400);
  });

  it("is zero-ish for two points snapping to the same node", () => {
    const graph = twoIslands();
    const cost = graph.estimateTravelCost({ x: 5, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
    expect(cost).not.toBeNull();
    expect(cost ?? 0).toBeLessThan(50);
  });

  it("returns null on an empty graph rather than pretending", () => {
    expect(new BotNavGraph("empty").estimateTravelCost({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeNull();
  });

  it("is consistent across repeated queries (matrix is cached, not corrupted)", () => {
    const graph = twoIslands();
    const a = graph.estimateTravelCost({ x: 0, y: 0, z: 0 }, { x: 400, y: 0, z: 0 });
    const b = graph.estimateTravelCost({ x: 0, y: 0, z: 0 }, { x: 400, y: 0, z: 0 });
    expect(a).toBe(b);
  });

  it("recomputes after the graph is reloaded", () => {
    const graph = twoIslands();
    expect(graph.estimateTravelCost({ x: 0, y: 0, z: 0 }, { x: 450, y: 0, z: 0 })).toBeNull();
    // Reload a connected graph into the same instance: the stale matrix must go.
    graph.loadStaticData({
      nodes: [
        { id: 0, position: { x: 0, y: 0, z: 0 }, type: "strategic" },
        { id: 1, position: { x: 450, y: 0, z: 0 }, type: "strategic" },
      ],
      edges: [
        { from: 0, to: 1, type: "walk", cost: 450 },
        { from: 1, to: 0, type: "walk", cost: 450 },
      ],
    } as unknown as NavGraphStaticData);
    expect(graph.estimateTravelCost({ x: 0, y: 0, z: 0 }, { x: 450, y: 0, z: 0 })).toBeCloseTo(450, 5);
  });
});

// ── The gate the whole phase exists for ──────────────────────────────

let nextId = 0;
function entry(type: PickupEntry["type"], kind: string, x: number, z = 0): PickupEntry {
  return { id: nextId++, classname: `item_${kind}`, type, kind, position: { x, y: 0, z } };
}

function makeState(): BotGameState {
  const state = new BotGameState();
  state.selfPlayerId = "bot";
  state.selfEntityId = "ent_bot";
  state.tick = 1000;
  state.self.position = { x: 0, y: 0, z: 0 };
  state.self.health = 50;
  state.self.armor = 0;
  state.self.weapons = ["blade"];
  state.self.ammo = {};
  state.pickupActiveMask = [];
  state.players = [
    {
      entityId: "e0",
      playerId: "p0",
      position: { x: 9000, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      isDead: false,
      team: "",
      relation: "enemy",
      distance: 9000,
    },
  ];
  return state;
}

describe("unreachable items are gated, not merely unattractive", () => {
  it("rejects an item in a disconnected component even when it is nearer", () => {
    const stranded = entry("health", "mega", 450); // node 3 island — 450 units away
    const reachable = entry("health", "medium", 400); // node 2 — reachable
    const result = new ItemGoalPlanner().select(makeState(), {
      pickupPositions: [stranded, reachable],
      maxDistance: 1500,
      blockedPickupIds: new Set(),
      navGraph: twoIslands(),
    });

    expect(result.goal?.pickupId).toBe(reachable.id);
    const strandedTrace = result.traces.find((t) => t.goalId.endsWith(String(stranded.id)));
    expect(strandedTrace?.gate).toBe(0);
    expect(strandedTrace?.gateReason).toBe("unreachable");
  });

  it("chooses nothing at all when every candidate is unreachable", () => {
    const stranded = entry("health", "mega", 450);
    const result = new ItemGoalPlanner().select(makeState(), {
      pickupPositions: [stranded],
      maxDistance: 1500,
      blockedPickupIds: new Set(),
      navGraph: twoIslands(),
    });
    expect(result.goal).toBeNull();
    expect(result.explain).toContain("gated=1");
  });

  it("without a nav graph the same item is NOT gated — the Phase 1 hole", () => {
    // Documents precisely what this phase fixed: the Euclidean estimator cannot
    // fail, so the gate never fires and the bot walks at a wall.
    const stranded = entry("health", "mega", 450);
    const result = new ItemGoalPlanner().select(makeState(), {
      pickupPositions: [stranded],
      maxDistance: 1500,
      blockedPickupIds: new Set(),
    });
    expect(result.goal?.pickupId).toBe(stranded.id);
  });

  it("ranks by walking distance, so a detour item loses to a straight-line rival", () => {
    // Both are physically close; only one is actually near.
    const nearby = entry("armor", "ya", 100); // node 2 — 1000 units of walking
    const graph = detour();
    const direct = entry("armor", "ya", 0, 500); // node 1 — 500 units
    const result = new ItemGoalPlanner().select(makeState(), {
      pickupPositions: [nearby, direct],
      maxDistance: 2000,
      blockedPickupIds: new Set(),
      navGraph: graph,
    });
    expect(result.goal?.pickupId).toBe(direct.id);
  });
});
