/**
 * The strategist: diagnoses from the match read, the strategy each one calls
 * for at a given match sense, holding a strategy, and its weights.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHT_PROFILE } from "../../shared/bot/WeightProfiles";
import { BotGameState, type VisiblePlayer } from "../BotGameState";
import { MatchRead } from "../strategy/MatchRead";
import { applyStrategyWeights, diagnose, STRATEGIES, Strategist } from "../strategy/Strategist";

const foe: VisiblePlayer = {
  entityId: "player_2",
  playerId: "player_2",
  position: { x: 0, y: 0, z: 500 },
  velocity: { x: 0, y: 0, z: 0 },
  isDead: false,
  team: "",
  relation: "enemy",
  distance: 500,
};

function state(tick: number, health = 100, armor = 0): BotGameState {
  const s = new BotGameState();
  s.tick = tick;
  s.selfEntityId = "player_1";
  s.selfPlayerId = "player_1";
  Object.assign(s.self, { health, armor, isDead: false, position: { x: 0, y: 0, z: 0 } });
  return s;
}

/** A read where the enemy was seen and then took a Red Armor and a Mega. */
function stackedEnemy(): { read: MatchRead; at: (tick: number, health: number) => BotGameState } {
  const read = new MatchRead();
  const s = state(100);
  s.players = [foe];
  s.enemyMajorItems.set("player_2", { type: "armor", kind: "ra", tick: 100 });
  read.update(s);
  return {
    read,
    at: (tick, health) => {
      const later = state(tick, health);
      later.players = [foe];
      return later;
    },
  };
}

describe("diagnose", () => {
  it("finds the bot understacked against a stacked enemy it has just seen", () => {
    const { read, at } = stackedEnemy();
    const now = at(150, 40);
    read.update(now);
    const found = diagnose(read, now);
    expect(found[0]).toMatchObject({ id: "understacked" });
    expect(found[0].strength).toBeGreaterThan(0.9);
  });

  it("finds a late lead and a late deficit from the scoreboard", () => {
    const read = new MatchRead();
    const s = state(100);
    s.matchState.timeRemaining = 60;
    s.scores.set("player_1", { score: 8, deaths: 2, team: "" });
    s.scores.set("player_2", { score: 4, deaths: 8, team: "" });
    read.update(s);
    expect(diagnose(read, s).map((d) => d.id)).toContain("ahead_late");
    s.scores.set("player_2", { score: 12, deaths: 2, team: "" });
    read.update(s);
    expect(diagnose(read, s).map((d) => d.id)).toContain("behind_late");
  });

  it("finds nothing in an even match", () => {
    const read = new MatchRead();
    const s = state(100, 100, 50);
    read.update(s);
    expect(diagnose(read, s)).toEqual([]);
  });
});

describe("Strategist", () => {
  it("recovers when understacked, at any match sense that reads the match", () => {
    for (const sense of [0.45, 1]) {
      const { read, at } = stackedEnemy();
      const now = at(150, 40);
      read.update(now);
      expect(new Strategist(sense, () => 0.5).update(read, now).id).toBe("recover");
    }
  });

  it("does nothing without match sense", () => {
    const { read, at } = stackedEnemy();
    const now = at(150, 40);
    read.update(now);
    expect(new Strategist(0, () => 0.5).update(read, now).id).toBe("standard");
  });

  it("presses a late deficit only with enough match sense", () => {
    const read = new MatchRead();
    const s = state(100, 100, 50);
    s.matchState.timeRemaining = 60;
    s.scores.set("player_1", { score: 2, deaths: 8, team: "" });
    s.scores.set("player_2", { score: 9, deaths: 2, team: "" });
    read.update(s);
    expect(new Strategist(1, () => 0.5).update(read, s).id).toBe("pressure");
    expect(new Strategist(0.45, () => 0.5).update(read, s).id).toBe("standard");
  });

  it("holds a strategy for a few seconds after its reason fades", () => {
    const { read, at } = stackedEnemy();
    const strategist = new Strategist(1, () => 0.5);
    const hurt = at(150, 40);
    read.update(hurt);
    expect(strategist.update(read, hurt).id).toBe("recover");
    const healed = state(150 + 125 * 2, 200, 100);
    read.update(healed);
    expect(strategist.update(read, healed).id).toBe("recover");
    const later = state(150 + 125 * 10, 200, 100);
    read.update(later);
    expect(strategist.update(read, later).id).toBe("standard");
  });
});

describe("applyStrategyWeights", () => {
  it("scales the profile and caps shares at 1", () => {
    const pressed = applyStrategyWeights({ ...DEFAULT_WEIGHT_PROFILE, riskTolerance: 0.8 }, STRATEGIES.pressure);
    expect(pressed.riskTolerance).toBe(1);
    expect(pressed.aggression).toBeCloseTo(DEFAULT_WEIGHT_PROFILE.aggression * 1.5, 9);
    expect(applyStrategyWeights(DEFAULT_WEIGHT_PROFILE, STRATEGIES.standard)).toEqual(DEFAULT_WEIGHT_PROFILE);
  });
});

describe("Deathmatch diagnoses", () => {
  it("finds the bot focused when two enemies hurt it within 20 s", () => {
    const read = new MatchRead();
    const s = state(100, 100, 50);
    s.recentDamage = [
      { attackerId: "player_2", damage: 20, weaponId: "mg", position: { x: 0, y: 0, z: 0 }, tick: 90 },
      { attackerId: "player_3", damage: 30, weaponId: "rl", position: { x: 0, y: 0, z: 0 }, tick: 95 },
    ];
    read.update(s);
    expect(diagnose(read, s).map((d) => d.id)).toContain("focused");
    expect(new Strategist(1, () => 0.5).update(read, s).id).toBe("recover");
  });
});

describe("stances", () => {
  it("fades out of costly fights only when recovering or protecting a lead", () => {
    expect(STRATEGIES.recover.stance.fade).toBe(true);
    expect(STRATEGIES.protect_lead.stance.fade).toBe(true);
    expect(STRATEGIES.pressure.stance.fade).toBe(false);
    expect(STRATEGIES.standard.stance.fade).toBe(false);
  });
});
