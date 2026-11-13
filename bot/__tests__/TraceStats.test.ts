import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHT_PROFILE } from "../../shared/bot/WeightProfiles";
import type { DecisionTrace } from "../DecisionTrace";
import type { ConsiderationContext } from "../goals/Consideration";
import { ROUTE_HALF_COST, RouteCost } from "../goals/considerations/RouteCost";
import { TraceStats, traceCause } from "../TraceStats";

function trace(overrides: Partial<DecisionTrace>): DecisionTrace {
  return {
    tick: 0,
    state: "ITEM_RUN",
    strategy: "standard",
    reason: null,
    orders: [],
    goal: "item:pickup:1",
    candidates: [],
    gated: 0,
    step: null,
    sequence: null,
    blocked: null,
    position: { x: 0, y: 0, z: 0 },
    speed: 0,
    grounded: true,
    crouching: false,
    health: 100,
    armor: 0,
    weapon: "blade",
    ...overrides,
  };
}

describe("decision trace summaries", () => {
  it("names what a bot was doing: state, sequence or step, and any block", () => {
    expect(traceCause(trace({ sequence: "sequence=nav_learned_route phase=creep committed=40" }))).toBe(
      "ITEM_RUN | nav_learned_route creep",
    );
    expect(
      traceCause(
        trace({ step: { type: "jump", to: { x: 0, y: 0, z: 0 }, route: "learned:demo@1" }, blocked: "fall:edge:x" }),
      ),
    ).toBe("ITEM_RUN | jump learned | blocked fall:edge");
    expect(traceCause(trace({ goal: null }))).toBe("ITEM_RUN | no goal");
  });

  it("counts still time by cause and crouch changes by state, alive only", () => {
    const stats = new TraceStats();
    const self = { isDead: false, isCrouching: false };
    for (let i = 0; i < 125; i++) stats.add("a", trace({}), self);
    for (let i = 0; i < 125; i++) stats.add("a", trace({ speed: 300 }), { isDead: false, isCrouching: i % 2 === 0 });
    stats.add("a", trace({}), { isDead: true, isCrouching: false });
    expect(stats.stillByCause.get("ITEM_RUN | no step")).toBeCloseTo(1);
    expect(stats.crouchChangesByState.get("ITEM_RUN")).toBe(125);
    expect(stats.lines()[0]).toContain("50.0%");
  });
});

describe("route cost for gametype orders", () => {
  const ctx = (priority: number | null) =>
    ({
      goal: {
        id: "g",
        kind: priority === null ? "acquire_item" : "objective",
        position: { x: 0, y: 0, z: 0 },
        item: priority === null ? { type: "health", kind: "health_small" } : undefined,
        directive: priority === null ? undefined : { id: "o", priority },
      },
      routeCost: ROUTE_HALF_COST * 2,
      weights: DEFAULT_WEIGHT_PROFILE,
    }) as unknown as ConsiderationContext;

  it("discounts a run to an order less the more it matters", () => {
    const item = RouteCost.score(ctx(null));
    const hold = RouteCost.score(ctx(0.5));
    const plant = RouteCost.score(ctx(0.9));
    expect(item).toBeCloseTo(1 / 3);
    expect(hold).toBeGreaterThan(item);
    expect(plant).toBeGreaterThan(hold);
    expect(plant).toBeGreaterThan(0.65);
  });
});
