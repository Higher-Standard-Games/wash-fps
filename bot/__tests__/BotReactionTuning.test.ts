import { describe, expect, it } from "vitest";
import { GameState, PlayerState } from "../../../../shared/net/GameState";
import { resolveDifficulty } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import { duelLeadReactionDelay } from "../BotReactionTuning";
import { StateMachineBrain } from "../StateMachineBrain";

function duel(lead: number) {
  const state = new BotGameState();
  state.selfPlayerId = "bot";
  state.self.health = 100;
  state.matchState.gametypeName = "Duel";
  state.scores.set("bot", { score: lead, deaths: 0, team: "" });
  state.scores.set("human", { score: 0, deaths: 0, team: "" });
  return state;
}

describe("Duel lead reaction tuning", () => {
  it("uses the current roster after an opponent leaves", () => {
    const state = duel(5);
    const snapshot = new GameState();
    const player = new PlayerState();
    player.score = 5;
    snapshot.players.set("bot", player);
    state.update(snapshot);
    expect(state.scores.has("human")).toBe(false);
    expect(duelLeadReactionDelay(state)).toBe(0);
  });

  it.each([-3, 0, 1, 2])("does not penalize a lead of %i frags", (lead) => {
    expect(duelLeadReactionDelay(duel(lead))).toBe(0);
  });

  it.each([3, 5, 20])("adds a fixed 40 ms at a lead of %i frags", (lead) => {
    expect(duelLeadReactionDelay(duel(lead))).toBe(40);
  });

  it("ignores missing opponents and other modes", () => {
    const state = duel(5);
    state.matchState.gametypeName = "FFA";
    expect(duelLeadReactionDelay(state)).toBe(0);
    state.matchState.gametypeName = "Duel";
    state.scores.delete("human");
    expect(duelLeadReactionDelay(state)).toBe(0);
  });

  it("changes the brain's reaction delay without reducing aim or stacking across snapshots", () => {
    const difficulty = resolveDifficulty("hard");
    const brain = new StateMachineBrain(difficulty);
    const state = duel(3);
    for (let i = 0; i < 5; i++) brain.observe(state);
    expect(brain.aimDifficulty.reactionTimeMs).toBe(difficulty.reactionTimeMs + 40);
    expect(brain.aimDifficulty.aimAccuracy).toBe(difficulty.aimAccuracy);
    state.scores.get("human")!.score = 1;
    brain.observe(state);
    expect(brain.aimDifficulty.reactionTimeMs).toBe(difficulty.reactionTimeMs);
  });
});
