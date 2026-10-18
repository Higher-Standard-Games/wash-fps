import type { PlayerId } from "@engine/server/ecs/types";
import { MatchPhase } from "@shared/server/gametype";
import { describe, expect, it } from "vitest";
import { MatchState } from "../MatchState";

function roster(teamBased: boolean) {
  const state = new MatchState("test", { warmupTimeout: 2, countdownDuration: 1 }, teamBased);
  state.setHumanClients(1);
  state.addPlayer(1 as PlayerId);
  state.setPlayerTeam(1 as PlayerId, "udon");
  state.playerReady(1 as PlayerId);
  return state;
}

describe("warmup needs opposition", () => {
  it.each([false, true])("does not time out with one player (teamBased=%s)", (teams) => {
    const state = roster(teams);
    state.update(120);
    expect(state.phase).toBe(MatchPhase.Warmup);
    expect(state.timeRemaining).toBe(2);
  });

  it("does not start with multiple ready players on one side", () => {
    const state = roster(true);
    state.addPlayer(2 as PlayerId);
    state.setPlayerTeam(2 as PlayerId, "udon");
    state.playerReady(2 as PlayerId);
    state.update(120);
    expect(state.phase).toBe(MatchPhase.Warmup);
    state.setPlayerTeam(2 as PlayerId, "soba");
    state.update(0.01);
    expect(state.phase).toBe(MatchPhase.Countdown);
  });

  it.each([false, true])("cancels countdown when an opponent spectates (teamBased=%s)", (teams) => {
    const state = roster(teams);
    state.addPlayer(2 as PlayerId);
    state.setPlayerTeam(2 as PlayerId, "soba");
    state.playerReady(2 as PlayerId);
    state.update(0.01);
    expect(state.phase).toBe(MatchPhase.Countdown);
    state.spectatePlayer(2 as PlayerId);
    state.update(10);
    expect(state.phase).toBe(MatchPhase.Warmup);
  });

  it("allows the warmup timeout once both sides have players", () => {
    const state = roster(true);
    state.addPlayer(2 as PlayerId);
    state.setPlayerTeam(2 as PlayerId, "soba");
    state.update(2.1);
    expect(state.phase).toBe(MatchPhase.Countdown);
    state.update(1.1);
    expect(state.phase).toBe(MatchPhase.Active);
  });
});
