import { afterEach, describe, expect, it } from "vitest";
import { MatchPhase, MatchStateManager } from "../MatchStateManager";

afterEach(() => MatchStateManager.destroy());

describe("Amphi client entry", () => {
  it("requires a kit in Amphi and S&D, while Duel still joins directly", () => {
    const match = MatchStateManager.getInstance();
    for (const [name, required] of [
      ["Amphi", true],
      ["Search & Destroy", true],
      ["Duel", false],
    ] as const) {
      match.processEvent({ type: "match_state", phase: MatchPhase.Warmup, gametypeName: name });
      expect(match.requiresLoadoutSelection).toBe(required);
    }
  });
});
