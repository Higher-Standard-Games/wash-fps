import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHT_PROFILE, WEIGHT_PROFILES } from "../../shared/bot/WeightProfiles";
import { chooseRoam, HUNT_DESIRE_BASE, HUNT_DESIRE_PER_AGGRESSION, holdDesire, huntDesire } from "../goals/RoamChoice";

describe("roaming by score", () => {
  it("prices a fresh sighting at the seek bar, and a stale one at nothing", () => {
    const weights = DEFAULT_WEIGHT_PROFILE;
    const bar = (HUNT_DESIRE_BASE + HUNT_DESIRE_PER_AGGRESSION * weights.aggression) * 1;
    expect(huntDesire(weights, 1, 1)).toBeCloseTo(bar, 12);
    expect(huntDesire(weights, 1, 0.5)).toBeCloseTo(bar / 2, 12);
    expect(huntDesire(weights, 1, 0)).toBe(0);
    expect(huntDesire(weights, 0.5, 1)).toBeCloseTo(bar / 2, 12);
  });

  it("holds ground only in a mode that keeps a territory", () => {
    expect(holdDesire(WEIGHT_PROFILES.duel, true)).toBeCloseTo(0.5 * WEIGHT_PROFILES.duel.mapControl, 12);
    expect(holdDesire(WEIGHT_PROFILES.duel, false)).toBe(0);
  });

  it("takes the best, an item on a tie, and nothing when nothing is worth anything", () => {
    expect(chooseRoam({ item: 0.4, hunt: 0.4, hold: 0.1 })).toBe("item");
    expect(chooseRoam({ item: 0.2, hunt: 0.4, hold: 0.45 })).toBe("hold");
    expect(chooseRoam({ item: 0.2, hunt: 0.4, hold: 0.3 })).toBe("hunt");
    expect(chooseRoam({ item: 0, hunt: 0, hold: 0 })).toBeNull();
  });
});
