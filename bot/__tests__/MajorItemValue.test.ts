import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHT_PROFILE, WEIGHT_PROFILES } from "../../shared/bot/WeightProfiles";
import type { ConsiderationContext } from "../goals/Consideration";
import { denialValue } from "../goals/considerations/ItemFacts";
import { majorItemValue } from "../goals/considerations/ItemValue";
import { ROUTE_HALF_COST, RouteCost } from "../goals/considerations/RouteCost";

describe("major item value under the mode's bias", () => {
  const duel = WEIGHT_PROFILES.duel.majorItemBias;

  it("keeps the major items in order in Duel instead of all reaching 1", () => {
    const ra = majorItemValue(0.77, duel);
    const mega = majorItemValue(0.67, duel);
    const ya = majorItemValue(0.58, duel);
    expect(ra).toBeLessThan(1);
    expect(ra).toBeGreaterThan(mega);
    expect(mega).toBeGreaterThan(ya);
    expect(ya).toBeGreaterThan(0.58);
  });

  it("is the value itself at a bias of 1 and lower below 1", () => {
    expect(majorItemValue(0.4, 1)).toBeCloseTo(0.4);
    expect(majorItemValue(0.4, 0.6)).toBeLessThan(0.4);
    expect(majorItemValue(0, 1.8)).toBe(0);
    expect(majorItemValue(1, 1.8)).toBe(1);
  });

  it("denies the Red Armor above the Mega and the Yellow Armor", () => {
    expect(denialValue("armor", "ra")).toBeGreaterThan(denialValue("health", "mega"));
    expect(denialValue("health", "mega")).toBeGreaterThan(denialValue("armor", "ya"));
  });
});

describe("route cost for major items", () => {
  const ctx = (kind: string, type: string, weights = WEIGHT_PROFILES.duel) =>
    ({
      goal: { id: "g", kind: "acquire_item", position: { x: 0, y: 0, z: 0 }, item: { type, kind } },
      routeCost: ROUTE_HALF_COST,
      weights,
    }) as unknown as ConsiderationContext;

  it("discounts a run to a major item less where the mode values them more", () => {
    expect(RouteCost.score(ctx("health_small", "health"))).toBeCloseTo(0.5);
    expect(RouteCost.score(ctx("ra", "armor"))).toBeGreaterThan(0.6);
    expect(RouteCost.score(ctx("ra", "armor", DEFAULT_WEIGHT_PROFILE))).toBeCloseTo(0.5);
  });
});
