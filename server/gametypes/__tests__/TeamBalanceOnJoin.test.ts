import type { PlayerId } from "@engine/server/ecs/types";
import { describe, expect, it } from "vitest";
import { MatchState } from "../MatchState";

/**
 * A requested side must never be honoured into a worse split.
 *
 * Joins that named a team were taken at their word, so picking the side that
 * already held two bots turned a 2v2 lobby into a 3v1 match — and a round mode
 * has no way back from that mid-match.
 */
function stateWith(teams: Array<[number, "udon" | "soba"]>): MatchState {
  const state = new MatchState("Search & Destroy", {}, true);
  for (const [id, team] of teams) {
    state.addPlayer(id as PlayerId);
    state.setPlayerTeam(id as PlayerId, team);
  }
  return state;
}

describe("team assignment on join", () => {
  it("redirects a request for the bigger side to the smaller one", () => {
    const state = stateWith([
      [1, "udon"],
      [2, "udon"],
      [3, "soba"],
    ]);
    state.addPlayer(4 as PlayerId);

    expect(state.assignTeamRespectingBalance(4 as PlayerId, "udon")).toBe("soba");
    expect(state.getPlayerTeam(4 as PlayerId)).toBe("soba");
  });

  it("grants the request when it is the smaller side", () => {
    const state = stateWith([
      [1, "udon"],
      [2, "udon"],
      [3, "soba"],
    ]);
    state.addPlayer(4 as PlayerId);

    expect(state.assignTeamRespectingBalance(4 as PlayerId, "soba")).toBe("soba");
  });

  it("grants the request when the sides are even", () => {
    const state = stateWith([
      [1, "udon"],
      [2, "soba"],
    ]);
    state.addPlayer(3 as PlayerId);

    expect(state.assignTeamRespectingBalance(3 as PlayerId, "udon")).toBe("udon");
  });

  it("lets a player re-pick the side they are already on", () => {
    // Their own membership must not count against them, or re-joining your own
    // team would bounce you to the other one.
    const state = stateWith([
      [1, "udon"],
      [2, "soba"],
      [3, "udon"],
    ]);

    expect(state.assignTeamRespectingBalance(3 as PlayerId, "udon")).toBe("udon");
  });

  it("still allows spectator", () => {
    const state = stateWith([[1, "udon"]]);
    state.addPlayer(2 as PlayerId);

    expect(state.assignTeamRespectingBalance(2 as PlayerId, "spectator")).toBe("spectator");
  });
});
