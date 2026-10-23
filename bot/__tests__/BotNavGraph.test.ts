import { describe, expect, it } from "vitest";
import type { AABB, TraceResult } from "../../../../shared/collision/CollisionWorld";
import { NullCollisionWorld } from "../../../../shared/collision/CollisionWorld";
import type { Vec3 } from "../../../../shared/server/simulation/types/index";
import { BotNavGraph, navEdgeKey } from "../BotNavGraph";
import type { BotVision } from "../BotVision";

class FlatFloorCollisionWorld extends NullCollisionWorld {
  override trace(start: Vec3, end: Vec3, _bounds?: AABB): TraceResult {
    if (start.y >= 0 && start.y < 100 && end.y <= 0 && start.y !== end.y) {
      const fraction = start.y / (start.y - end.y);
      return {
        hit: true,
        fraction,
        hitPoint: {
          x: start.x + (end.x - start.x) * fraction,
          y: 0,
          z: start.z + (end.z - start.z) * fraction,
        },
        normal: { x: 0, y: 1, z: 0 },
      };
    }
    return { hit: false, fraction: 1 };
  }
}

function makeVision(triggerType: "teleport" | "push"): BotVision {
  return {
    mapKnowledge: {
      mapName: "testmap",
      spawnPoints: [{ x: 0, y: 0, z: 0 }],
      pickupPositions: [{ classname: "item_health_mega", position: { x: 3100, y: 0, z: 0 } }],
      triggerVolumes: [
        {
          id: 0,
          type: triggerType,
          min: { x: 80, y: -16, z: -16 },
          max: { x: 120, y: 16, z: 16 },
          dest: { x: 3000, y: 0, z: 0 },
          destYaw: triggerType === "teleport" ? 0 : undefined,
        },
      ],
    },
    collisionWorld: new NullCollisionWorld(),
    isWalkable: () => true,
    canSee: () => true,
    isInsideSolid: () => false,
  } as unknown as BotVision;
}

function makeJumpVision(): BotVision {
  return {
    mapKnowledge: {
      mapName: "jump-test",
      mapFingerprint: "test-bsp",
      spawnPoints: [{ x: 0, y: 24, z: 0 }],
      pickupPositions: [{ id: 0, classname: "item_health_mega", position: { x: 100, y: 64, z: 0 } }],
      triggerVolumes: [],
    },
    collisionWorld: new FlatFloorCollisionWorld(),
    isWalkable: () => true,
    canSee: () => true,
    isInsideSolid: () => false,
  } as unknown as BotVision;
}

function makeUnreachableJumpVision(): BotVision {
  return {
    mapKnowledge: {
      mapName: "unreachable-jump-test",
      mapFingerprint: "test-bsp",
      spawnPoints: [{ x: 0, y: 24, z: 0 }],
      pickupPositions: [{ id: 0, classname: "item_health_mega", position: { x: 100, y: 100, z: 0 } }],
      triggerVolumes: [],
    },
    collisionWorld: new NullCollisionWorld(),
    isWalkable: () => true,
    canSee: () => true,
    isInsideSolid: () => false,
  } as unknown as BotVision;
}

describe("BotNavGraph movement analysis", () => {
  it("only adds simulated jump edges and keeps their execution annotations", () => {
    const graph = new BotNavGraph("jump-test");
    graph.buildFromVision(makeJumpVision());

    expect(graph.edges.filter((edge) => edge.type === "jump")).toHaveLength(2);
    expect(graph.edges.filter((edge) => edge.type === "jump").every((edge) => edge.validated)).toBe(true);
    expect(graph.movementOpportunities).toHaveLength(2);
    expect(graph.movementAnalysis).toMatchObject({ candidateCount: 2, acceptedCount: 2, rejectedCount: 0 });
  });

  it("does not retain a visible jump edge with an unstandable endpoint", () => {
    const graph = new BotNavGraph("unreachable-jump-test");
    graph.buildFromVision(makeUnreachableJumpVision());

    expect(graph.edges.filter((edge) => edge.type === "jump")).toHaveLength(0);
    expect(graph.movementOpportunities).toHaveLength(0);
    expect(graph.movementAnalysis).toMatchObject({
      candidateCount: 2,
      acceptedCount: 0,
      rejectedCount: 2,
      rejectionCounts: { invalid_takeoff: 2 },
    });
  });
});

describe("BotNavGraph trigger awareness", () => {
  it("replans around a temporarily blocked traversal edge", () => {
    const graph = new BotNavGraph("alternate-route-test");
    graph.loadStaticData({
      nodes: [
        { id: 0, type: "spawn", position: { x: 0, y: 0, z: 0 } },
        { id: 1, type: "floor", position: { x: 100, y: 0, z: 100 } },
        { id: 2, type: "item", classname: "item_health_mega", position: { x: 200, y: 0, z: 0 } },
      ],
      edges: [
        { from: 0, to: 2, type: "fall", cost: 10 },
        { from: 0, to: 1, type: "walk", cost: 100 },
        { from: 1, to: 2, type: "walk", cost: 100 },
      ],
    });

    const direct = graph.findPath({ x: 0, y: 0, z: 0 }, { x: 200, y: 0, z: 0 });
    expect(direct?.steps.map((step) => step.type)).toEqual(["fall"]);

    const alternate = graph.findPath(
      { x: 0, y: 0, z: 0 },
      { x: 200, y: 0, z: 0 },
      { blockedEdgeKeys: new Set([navEdgeKey(0, 2, "fall")]) },
    );
    expect(alternate?.steps.map((step) => step.type)).toEqual(["walk", "walk"]);
  });
  it("routes through teleporter volumes", () => {
    const graph = new BotNavGraph("testmap");
    graph.buildFromVision(makeVision("teleport"));

    expect(graph.nodes.some((n) => n.type === "teleporter")).toBe(true);
    expect(graph.edges.find((edge) => edge.type === "teleporter")).toMatchObject({
      trigger: { id: 0, dest: { x: 3000, y: 0, z: 0 }, destYaw: 0 },
    });

    const path = graph.findPath({ x: 0, y: 0, z: 0 }, { x: 3100, y: 0, z: 0 });
    expect(path).not.toBeNull();
    expect(path!.nodes.some((n) => n.type === "teleporter")).toBe(true);
    expect(path!.steps.some((step) => step.type === "teleporter")).toBe(true);
    expect(graph.describePath(path!)).toContain("teleporter:");
  });

  it("routes through jumppad volumes", () => {
    const graph = new BotNavGraph("testmap");
    graph.buildFromVision(makeVision("push"));

    expect(graph.nodes.some((n) => n.type === "jumppad")).toBe(true);
    expect(graph.edges.find((edge) => edge.type === "jumppad")).toMatchObject({
      trigger: { id: 0, dest: { x: 3000, y: 0, z: 0 } },
    });

    const path = graph.findPath({ x: 0, y: 0, z: 0 }, { x: 3100, y: 0, z: 0 });
    expect(path).not.toBeNull();
    expect(path!.nodes.some((n) => n.type === "jumppad")).toBe(true);
    expect(path!.steps.some((step) => step.type === "jumppad")).toBe(true);
  });

  it("rebuilds without accumulating stale trigger edges", () => {
    const graph = new BotNavGraph("testmap");
    graph.buildFromVision(makeVision("teleport"));
    const firstEdgeCount = graph.edgeCount;

    graph.buildFromVision(makeVision("teleport"));
    expect(graph.edgeCount).toBe(firstEdgeCount);
  });
});

it("keeps progress after a non-local teleporter transition", () => {
  const graph = new BotNavGraph("testmap");
  graph.loadStaticData({
    nodes: [
      { id: 0, type: "spawn", position: { x: 0, y: 0, z: 0 } },
      { id: 1, type: "teleporter", position: { x: 100, y: 0, z: 0 } },
      { id: 2, type: "teleporter", position: { x: 3000, y: 0, z: 0 } },
      { id: 3, type: "item", classname: "item_health_mega", position: { x: 3200, y: 0, z: 0 } },
    ],
    edges: [
      { from: 0, to: 1, type: "walk", cost: 100 },
      {
        from: 1,
        to: 2,
        type: "teleporter",
        cost: 32,
        trigger: {
          id: 0,
          min: { x: 80, y: -16, z: -16 },
          max: { x: 120, y: 16, z: 16 },
          dest: { x: 3000, y: 0, z: 0 },
          destYaw: 0,
        },
      },
      { from: 2, to: 3, type: "walk", cost: 200 },
    ],
  });

  const path = graph.findPath({ x: 0, y: 0, z: 0 }, { x: 3200, y: 0, z: 0 });
  expect(path).not.toBeNull();
  expect(graph.getNextStep({ x: 0, y: 0, z: 0 }, path!, 50)?.type).toBe("walk");
  expect(graph.getNextStep({ x: 100, y: 0, z: 0 }, path!, 50)?.type).toBe("teleporter");
  expect(graph.getNextStep({ x: 3000, y: 0, z: 0 }, path!, 50)?.type).toBe("walk");
  expect(graph.getNextStep({ x: 3150, y: 0, z: 0 }, path!, 100)?.type).toBe("walk");
  expect(graph.getNextStep({ x: 3200, y: 0, z: 0 }, path!, 50)).toBeNull();
  expect(path!.cursor).toBe(3);
});

it("excludes temporarily blocked pickup ids from item planning", () => {
  const graph = new BotNavGraph("blocked-pickup-test");
  graph.loadStaticData({
    nodes: [
      { id: 0, type: "spawn", position: { x: 0, y: 0, z: 0 } },
      { id: 1, type: "item", pickupId: 0, classname: "item_health", position: { x: 100, y: 0, z: 0 } },
      { id: 2, type: "item", pickupId: 1, classname: "item_health", position: { x: 200, y: 0, z: 0 } },
    ],
    edges: [
      { from: 0, to: 1, type: "walk", cost: 10 },
      { from: 0, to: 2, type: "walk", cost: 20 },
    ],
  });

  const path = graph.findPathToItem({ x: 0, y: 0, z: 0 }, "health", [true, true], { blockedPickupIds: new Set([0]) });
  expect(path?.nodes[path.nodes.length - 1]?.pickupId).toBe(1);
});

/** A floor at y = 0 that answers downward traces from any height, as floor sampling casts from far above. */
class GroundPlane extends NullCollisionWorld {
  override trace(start: Vec3, end: Vec3, _bounds?: AABB): TraceResult {
    if (start.y > 0 && end.y <= 0) {
      const fraction = start.y / (start.y - end.y);
      const at = (a: number, b: number) => a + (b - a) * fraction;
      return {
        hit: true,
        fraction,
        hitPoint: { x: at(start.x, end.x), y: 0, z: at(start.z, end.z) },
        normal: { x: 0, y: 1, z: 0 },
      };
    }
    return { hit: false, fraction: 1 };
  }
}

describe("BotNavGraph walk edges", () => {
  it("tests walks from standing height, so floor and item nodes on the surface connect", () => {
    // The player hull reaches 24 units below its origin: a sweep whose origin is
    // lower than that above the floor (y = 0) starts inside it and is never clear.
    const hullClear = (from: Vec3, to: Vec3) => from.y >= 24 && to.y >= 24;
    const vision = {
      mapKnowledge: {
        mapName: "walk-test",
        mapFingerprint: "walk-bsp",
        spawnPoints: [{ x: 0, y: 24, z: 0 }],
        pickupPositions: [{ id: 0, classname: "item_health_mega", position: { x: 600, y: 3, z: 0 } }],
        triggerVolumes: [],
      },
      collisionWorld: new GroundPlane(),
      isWalkable: hullClear,
      canSee: () => true,
      isInsideSolid: () => false,
    } as unknown as BotVision;
    const graph = new BotNavGraph("walk-test");
    graph.buildFromVision(vision);
    const floor = new Set(graph.nodes.filter((n) => n.type === "floor").map((n) => n.id));
    const item = graph.nodes.find((n) => n.type === "item")!;
    const spawn = graph.nodes.find((n) => n.type === "spawn")!;
    const walks = graph.edges.filter((e) => e.type === "walk");
    expect(floor.size).toBeGreaterThan(0);
    expect(walks.some((e) => floor.has(e.from) && floor.has(e.to))).toBe(true);
    expect(walks.some((e) => e.from === spawn.id && e.to === item.id)).toBe(true);
    // Stored positions stay on the surface: bots still steer to the same points.
    expect(item.position.y).toBe(3);
  });
});
