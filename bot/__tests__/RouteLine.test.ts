/**
 * The line a bot runs through a walking stretch of its route: string pulled,
 * off the walls, and followed forward from where the bot is.
 */

import { describe, expect, it } from "vitest";
import type { Vec3 } from "../BotGameState";
import type { NavNode, NavPath, NavStep } from "../BotNavGraph";
import { buildRouteLine, lineEndStep, pointAlong, type RouteWorld } from "../RouteLine";

/** A corridor along x between walls at z = ±100; nothing else in it. */
const corridor: RouteWorld = {
  walkable: (from, to) => Math.abs(from.z) <= 84 && Math.abs(to.z) <= 84,
  clearance: (at) => {
    const gap = 100 - Math.abs(at.z) - 16;
    return { gap, away: { x: 0, z: at.z > 0 ? -1 : 1 } };
  },
};

const node = (id: number, x: number, z: number): NavNode => ({ id, type: "floor", position: { x, y: 0, z } });

function path(points: [number, number][], kinds: Partial<NavStep>[] = []): NavPath {
  const nodes = points.map(([x, z], i) => node(i, x, z));
  const steps: NavStep[] = nodes.slice(1).map((to, i) => ({
    from: nodes[i],
    to,
    type: "walk",
    cost: 0,
    horizontalDistance: 0,
    heightDelta: 0,
    requiresPreciseApproach: false,
    ...kinds[i],
  }));
  return { nodes, steps, totalCost: 0, cursor: 0 };
}

const start: Vec3 = { x: 0, y: 24, z: 0 };

describe("route line", () => {
  it("runs straight past nodes it does not need", () => {
    const line = buildRouteLine(
      start,
      path([
        [0, 0],
        [200, 10],
        [400, -10],
        [600, 0],
      ]),
      0,
      corridor,
    );
    expect(line.points.length).toBe(2);
    expect(line.points[1].x).toBe(600);
    expect(line.endStep).toBe(3);
  });

  it("keeps off a wall its nodes run along", () => {
    // Nodes hug the wall at z = 80; the line runs where it keeps 48 of clearance.
    const line = buildRouteLine(
      start,
      path([
        [0, 0],
        [300, 80],
        [600, 80],
        [900, 0],
      ]),
      0,
      {
        ...corridor,
        // Only short hops are straight here, so the corners stay and can be moved.
        walkable: (from, to) => corridor.walkable(from, to) && Math.abs(to.x - from.x) <= 300,
      },
    );
    for (const p of line.points) expect(100 - Math.abs(p.z) - 16).toBeGreaterThanOrEqual(36);
  });

  it("ends at the start of a jump or an exact approach, which the step executor runs", () => {
    const p = path(
      [
        [0, 0],
        [200, 0],
        [400, 0],
        [600, 0],
      ],
      [{}, { type: "jump" }, {}],
    );
    expect(lineEndStep(p, 0)).toBe(1);
    expect(buildRouteLine(start, p, 0, corridor).points.at(-1)?.x).toBe(200);
    expect(
      lineEndStep(
        path(
          [
            [0, 0],
            [200, 0],
          ],
          [{ requiresPreciseApproach: true }],
        ),
        0,
      ),
    ).toBe(0);
  });
});

describe("following a line", () => {
  const line: Vec3[] = [
    { x: 0, y: 24, z: 0 },
    { x: 200, y: 24, z: 0 },
    { x: 200, y: 24, z: 200 },
  ];

  it("leads from the nearest point, so a corner run past does not pull the bot back", () => {
    // Past the corner and already down the second stretch.
    const { point, stretch } = pointAlong(line, { x: 210, z: 60 }, 64);
    expect(stretch).toBe(1);
    expect(point.x).toBeCloseTo(200);
    expect(point.z).toBeCloseTo(124);
  });

  it("goes round a corner it has not reached", () => {
    const { point } = pointAlong(line, { x: 180, z: 0 }, 64);
    expect(point.x).toBeCloseTo(200);
    expect(point.z).toBeCloseTo(44);
  });

  it("stops at the end", () => {
    expect(pointAlong(line, { x: 200, z: 190 }, 64).point).toEqual(line[2]);
  });
});
