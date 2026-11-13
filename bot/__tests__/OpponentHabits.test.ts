/**
 * Habits learned in a match: an opponent who keeps taking the same item makes
 * it contested, the item planner scores contested items, and the strategist's
 * bandit moves to the strategy that has paid off.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHT_PROFILE } from "../../shared/bot/WeightProfiles";
import { BotGameState } from "../BotGameState";
import type { ConsiderationContext } from "../goals/Consideration";
import { ContestedItem } from "../goals/considerations/ContestedItem";
import { MatchRead } from "../strategy/MatchRead";
import { OpponentModel } from "../strategy/OpponentModel";
import { Strategist } from "../strategy/Strategist";

function state(tick: number): BotGameState {
  const s = new BotGameState();
  s.tick = tick;
  s.selfEntityId = "player_1";
  s.selfPlayerId = "player_1";
  Object.assign(s.self, { health: 100, armor: 50, isDead: false, position: { x: 0, y: 0, z: 0 } });
  return s;
}

/** A read where player_2 was heard taking pickup 7 at each of `ticks`. */
function takes(ticks: number[]): MatchRead {
  const read = new MatchRead();
  for (const tick of ticks) {
    const s = state(tick);
    s.enemyMajorItems.set("player_2", { type: "armor", kind: "ra", tick, pickupId: 7 });
    read.update(s);
  }
  return read;
}

describe("OpponentModel", () => {
  it("makes an item an opponent took twice a habit, and three times a strong one", () => {
    const model = new OpponentModel();
    model.update(takes([100]));
    expect(model.contested().size).toBe(0);
    model.update(takes([100, 4000]));
    expect(model.contested().get(7)).toBe(0.5);
    model.update(takes([100, 4000, 8000]));
    expect(model.contested().get(7)).toBe(1);
    expect(model.habits()[0]).toMatchObject({ by: "player_2", pickupId: 7, kind: "ra", count: 3 });
  });

  it("forgets takes older than three minutes", () => {
    const model = new OpponentModel();
    const read = takes([100, 4000]);
    read.update(state(4000 + 125 * 200));
    model.update(read);
    expect(model.contested().size).toBe(0);
  });
});

describe("ContestedItem", () => {
  const ctx = (pickupId: number, contested?: ReadonlyMap<number, number>): ConsiderationContext => ({
    goal: { id: `item:${pickupId}`, kind: "acquire_item", position: { x: 0, y: 0, z: 0 }, pickupId },
    self: new BotGameState().self,
    state: new BotGameState(),
    routeCost: 100,
    weights: DEFAULT_WEIGHT_PROFILE,
    contested,
  });

  it("scores the items an opponent keeps taking, and nothing else", () => {
    const contested = new Map([[7, 0.5]]);
    expect(ContestedItem.score(ctx(7, contested))).toBe(0.5);
    expect(ContestedItem.score(ctx(8, contested))).toBe(0);
    expect(ContestedItem.score(ctx(7))).toBe(0);
  });
});

describe("Strategist bandit", () => {
  /** An understacked moment: a fresh enemy estimate well above the bot's stack. */
  function understacked(read: MatchRead, tick: number, ownScore: number): BotGameState {
    const s = state(tick);
    Object.assign(s.self, { health: 40, armor: 0 });
    s.players = [
      {
        entityId: "player_2",
        playerId: "player_2",
        position: { x: 0, y: 0, z: 500 },
        velocity: { x: 0, y: 0, z: 0 },
        isDead: false,
        team: "",
        relation: "enemy",
        distance: 500,
      },
    ];
    s.scores.set("player_1", { score: ownScore, deaths: 0, team: "" });
    s.scores.set("player_2", { score: 0, deaths: 0, team: "" });
    read.update(s);
    return s;
  }

  it("keeps the rule's answer below the match sense that adapts", () => {
    const read = new MatchRead();
    const strategist = new Strategist(0.45, () => 0.99);
    expect(strategist.update(read, understacked(read, 100, 0)).id).toBe("recover");
  });

  it("learns how a strategy paid off over an episode", () => {
    const read = new MatchRead();
    // Draws near the median: the rule's head start decides the first choice.
    const strategist = new Strategist(1, () => 0.5);
    expect(strategist.update(read, understacked(read, 100, 0)).id).toBe("recover");
    // Thirty seconds on, three frags up: the episode is judged and paid well.
    strategist.update(read, understacked(read, 100 + 125 * 31, 3));
    const arm = strategist.arms.get("understacked:recover");
    expect(arm?.n).toBe(1);
    expect(arm?.mean).toBeGreaterThan(2.5);
  });
});
