import { beforeEach, describe, expect, it } from "vitest";
import { MatchPhase, MatchStateManager } from "../MatchStateManager";

/**
 * The client's copy of the server's input freeze.
 *
 * These two predicates have to agree exactly. The client predicts its own
 * movement, so any phase where the server zeroes input but the client does not
 * is a phase where you walk a step and get snapped back — which is what the
 * round freeze felt like before the client knew about it.
 *
 * The server's rule lives in `GametypeController.applyPostGameInputFreeze`:
 * PostGame, or a round mode in RoundEnd or Countdown.
 */
function phase(p: MatchPhase, round: number): MatchStateManager {
  MatchStateManager.destroy();
  const match = MatchStateManager.getInstance();
  match.processEvent({ type: "match_state", phase: p, round, gametypeName: "Search & Destroy" });
  return match;
}

describe("client movement freeze", () => {
  beforeEach(() => {
    MatchStateManager.destroy();
  });

  it("freezes during a round's get-ready countdown", () => {
    expect(phase(MatchPhase.Countdown, 3).isMovementFrozen()).toBe(true);
  });

  it("freezes during the round-end result", () => {
    expect(phase(MatchPhase.RoundEnd, 3).isMovementFrozen()).toBe(true);
  });

  it("freezes on the post-game screen, round mode or not", () => {
    expect(phase(MatchPhase.PostGame, 3).isMovementFrozen()).toBe(true);
    expect(phase(MatchPhase.PostGame, 0).isMovementFrozen()).toBe(true);
  });

  it("does not freeze a live round", () => {
    expect(phase(MatchPhase.Active, 3).isMovementFrozen()).toBe(false);
  });

  it("does not freeze warmup", () => {
    expect(phase(MatchPhase.Warmup, 0).isMovementFrozen()).toBe(false);
  });

  it("leaves a non-round mode's pre-match countdown alone", () => {
    // A deathmatch countdown is the wait for the match to start, not a freeze
    // that holds players on their spawns — and the server does not zero input
    // for it either.
    expect(phase(MatchPhase.Countdown, 0).isMovementFrozen()).toBe(false);
  });
});
