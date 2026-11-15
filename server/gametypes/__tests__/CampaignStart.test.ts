import type { PlayerId } from "@engine/server/ecs/types";
import { MatchPhase } from "@shared/server/gametype";
import { describe, expect, it } from "vitest";
import { CAMPAIGN_START, MatchState } from "../MatchState";

const id = (n: number) => n as PlayerId;

/** A campaign match with `bots` seated and ready, waiting for `humans` people. */
function campaign(humans: number, bots: number, config: { roundBased?: boolean; countdownDuration?: number } = {}) {
  const state = new MatchState("test", { warmupTimeout: 120, countdownDuration: 5, ...config }, false);
  state.setExpectsHumans(true);
  state.setCampaignStart(humans);
  const botIds = new Set<PlayerId>();
  for (let n = 100; n < 100 + bots; n++) {
    botIds.add(id(n));
    state.addPlayer(id(n));
    state.setPlayerTeam(id(n), "ffa");
    state.playerReady(id(n));
  }
  state.setBotPlayers(botIds);
  return state;
}

function enter(state: MatchState, n: number) {
  state.addPlayer(id(n));
  state.setPlayerTeam(id(n), "ffa");
}

describe("campaign start", () => {
  it("waits for the player without a ready-up, then holds a 10-second countdown", () => {
    const state = campaign(1, 4);
    state.update(5);
    expect(state.phase).toBe(MatchPhase.Warmup);
    enter(state, 1);
    state.update(0.01);
    expect(state.phase).toBe(MatchPhase.Countdown);
    expect(state.timeRemaining).toBe(CAMPAIGN_START.openingCountdown);
    expect(state.countdownFreezes).toBe(true);
    state.update(9.9);
    expect(state.phase).toBe(MatchPhase.Countdown);
    state.update(0.2);
    expect(state.phase).toBe(MatchPhase.Active);
  });

  it("waits for every seated player in co-op", () => {
    const state = campaign(2, 4);
    enter(state, 1);
    state.update(1);
    expect(state.phase).toBe(MatchPhase.Warmup);
    enter(state, 2);
    state.update(0.01);
    expect(state.phase).toBe(MatchPhase.Countdown);
  });

  it("starts anyway once a player who never arrives has had a minute", () => {
    const state = campaign(2, 4);
    enter(state, 1);
    state.update(CAMPAIGN_START.warmupTimeout - 1);
    expect(state.phase).toBe(MatchPhase.Warmup);
    state.update(1.1);
    expect(state.phase).toBe(MatchPhase.Countdown);
  });

  it("gives only the first round of a round mode the long countdown", () => {
    const state = new MatchState("test", { warmupTimeout: 120, countdownDuration: 5, roundBased: true }, true);
    state.setCampaignStart(1);
    state.addPlayer(id(1));
    state.setPlayerTeam(id(1), "udon");
    state.addPlayer(id(2));
    state.setPlayerTeam(id(2), "soba");
    state.setBotPlayers(new Set([id(2)]));
    state.update(0.01);
    expect(state.phase).toBe(MatchPhase.Countdown);
    expect(state.timeRemaining).toBe(CAMPAIGN_START.openingCountdown);
    state.transition(MatchPhase.RoundEnd);
    state.transition(MatchPhase.Countdown);
    expect(state.timeRemaining).toBe(5);
  });

  it("leaves every other match as it was: ready-up, short countdown, no hold", () => {
    const state = new MatchState("test", { warmupTimeout: 120, countdownDuration: 5 }, false);
    state.setHumanClients(1);
    state.addPlayer(id(1));
    state.addPlayer(id(2));
    state.update(1);
    expect(state.phase).toBe(MatchPhase.Warmup);
    state.playerReady(id(1));
    state.playerReady(id(2));
    state.update(0.01);
    expect(state.phase).toBe(MatchPhase.Countdown);
    expect(state.timeRemaining).toBe(5);
    expect(state.countdownFreezes).toBe(false);
  });

  it("keeps the players attacking every round, and lets 10-9 win", () => {
    const snd = () =>
      new MatchState("S&D", { roundBased: true, scoreLimit: 10, roundsPerHalf: 9, leadRequired: 2 }, true);
    const campaign = snd();
    campaign.setAttackersThroughout("soba");
    const normal = snd();
    normal.setStartingAttacker("soba");
    const sides = (state: MatchState) =>
      Array.from({ length: 24 }, () => {
        state.transition(MatchPhase.Countdown);
        return state.attackingTeam;
      });
    expect(new Set(sides(campaign))).toEqual(new Set(["soba"]));
    expect(sides(normal).slice(8, 10)).toEqual(["soba", "udon"]);
    expect(campaign.inOvertime).toBe(false);

    const at = (state: MatchState, soba: number, udon: number) => {
      const scores = (state as unknown as { _teamScores: Map<string, number> })._teamScores;
      scores.set("soba", soba);
      scores.set("udon", udon);
      return state.hasDecisiveLead();
    };
    expect(at(campaign, 10, 9)).toBe(true);
    expect(at(campaign, 9, 9)).toBe(false);
    expect(at(campaign, 9, 10)).toBe(true);
    expect(at(normal, 10, 9)).toBe(false);
  });
});
