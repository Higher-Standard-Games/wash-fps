import { describe, expect, it } from "vitest";
import type { AABB, TraceResult } from "../../../../shared/collision/CollisionWorld";
import { NullCollisionWorld } from "../../../../shared/collision/CollisionWorld";
import type { Vec3 } from "../../../../shared/server/simulation/types/index";
import { BotMovementAnalyzer } from "../BotMovementAnalyzer";

class FlatFloorCollisionWorld extends NullCollisionWorld {
  override trace(start: Vec3, end: Vec3, _bounds?: AABB): TraceResult {
    if (start.y >= 0 && end.y <= 0 && start.y !== end.y) {
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
describe("BotMovementAnalyzer", () => {
  it("accepts a reachable jump using the authoritative fixed-tick profile", () => {
    const analyzer = new BotMovementAnalyzer(new FlatFloorCollisionWorld());

    const result = analyzer.analyzeJump(2, { x: 0, y: 24, z: 0 }, 5, { x: 100, y: 24, z: 0 });

    expect(result.rejection).toBeNull();
    expect(result.opportunity).not.toBeNull();
    expect(result.opportunity).toMatchObject({
      id: "jump:2->5",
      kind: "jump",
      fromNodeId: 2,
      toNodeId: 5,
    });
    expect(result.opportunity!.expectedTicks).toBeGreaterThan(1);
    expect(result.opportunity!.successMargin).toBeGreaterThanOrEqual(0);
    expect(analyzer.analysisSummary).toMatchObject({
      candidateCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      budgetExhausted: false,
    });
  });

  it("rejects candidates outside the bounded ballistic envelope without a rollout", () => {
    const analyzer = new BotMovementAnalyzer(new FlatFloorCollisionWorld());

    const result = analyzer.analyzeJump(0, { x: 0, y: 24, z: 0 }, 1, { x: 1000, y: 24, z: 0 });

    expect(result.opportunity).toBeNull();
    expect(result.rejection?.reason).toBe("outside_ballistic_envelope");
    expect(analyzer.analysisSummary.rolloutCount).toBe(0);
  });

  it("enforces its rollout budget deterministically", () => {
    const analyzer = new BotMovementAnalyzer(new FlatFloorCollisionWorld(), {
      candidateSpeeds: [0, 400],
      landingRadius: 8,
      maxRollouts: 1,
    });

    const result = analyzer.analyzeJump(0, { x: 0, y: 24, z: 0 }, 1, { x: 300, y: 24, z: 0 });

    expect(result.opportunity).toBeNull();
    expect(result.rejection?.reason).toBe("rollout_budget_exhausted");
    expect(analyzer.analysisSummary).toMatchObject({
      candidateCount: 1,
      rolloutCount: 1,
      acceptedCount: 0,
      rejectedCount: 1,
      budgetExhausted: true,
    });
  });

  it("produces identical annotations for identical inputs", () => {
    const first = new BotMovementAnalyzer(new FlatFloorCollisionWorld()).analyzeJump(0, { x: 0, y: 24, z: 0 }, 1, {
      x: 120,
      y: 24,
      z: 0,
    });
    const second = new BotMovementAnalyzer(new FlatFloorCollisionWorld()).analyzeJump(0, { x: 0, y: 24, z: 0 }, 1, {
      x: 120,
      y: 24,
      z: 0,
    });

    expect(second).toEqual(first);
  });
});
