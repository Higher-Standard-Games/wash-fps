/**
 * The match read: an enemy's stack estimated from hits by the armor rule and
 * pain tiers and from items they took, own item control, and fights.
 */

import { describe, expect, it } from "vitest";
import { BotGameState, type VisiblePlayer } from "../BotGameState";
import { applyHit, applyPickup, MatchRead } from "../strategy/MatchRead";

function foe(over: Partial<VisiblePlayer> = {}): VisiblePlayer {
  return {
    entityId: "player_2",
    playerId: "player_2",
    position: { x: 0, y: 0, z: 500 },
    velocity: { x: 0, y: 0, z: 0 },
    isDead: false,
    team: "",
    relation: "enemy",
    distance: 500,
    ...over,
  };
}

function state(tick: number): BotGameState {
  const s = new BotGameState();
  s.tick = tick;
  s.selfEntityId = "player_1";
  s.selfPlayerId = "player_1";
  Object.assign(s.self, { health: 100, armor: 0, isDead: false, position: { x: 0, y: 0, z: 0 } });
  return s;
}

describe("applyHit", () => {
  it("lets armor take 66% of a hit while it lasts", () => {
    const enemy = { health: 100, armor: 50 };
    applyHit(enemy, 60);
    expect(enemy.armor).toBeCloseTo(50 - 39.6, 6);
    expect(enemy.health).toBeCloseTo(100 - 20.4, 6);
    const thin = { health: 100, armor: 10 };
    applyHit(thin, 60);
    expect(thin.armor).toBe(0);
    expect(thin.health).toBe(50);
  });

  it("moves health into the range the pain sound gives away", () => {
    const enemy = { health: 100, armor: 0 };
    applyHit(enemy, 10, 1);
    expect(enemy.health).toBe(35);
    const tough = { health: 30, armor: 0 };
    applyHit(tough, 5, 3);
    expect(tough.health).toBe(61);
  });
});

describe("applyPickup", () => {
  it("adds items by the server's rules", () => {
    const enemy = { health: 100, armor: 30 };
    applyPickup(enemy, "armor", "ya");
    expect(enemy.armor).toBe(75);
    applyPickup(enemy, "health", "mega");
    expect(enemy.health).toBe(200);
    applyPickup(enemy, "powerup", "quad");
    expect(enemy).toEqual({ health: 200, armor: 75 });
  });
});

describe("MatchRead", () => {
  it("estimates a seen enemy from spawn values, the hits landed and the pain heard", () => {
    const read = new MatchRead();
    const s = state(100);
    s.players = [foe()];
    read.update(s);
    expect(read.enemyStack("player_2")?.stack).toBe(100);

    const hit = state(110);
    hit.players = [foe()];
    hit.recentHits = [{ victimEntityId: "player_2", weaponId: "rlauncher", damage: 80, tick: 110, painTier: 0 }];
    read.update(hit);
    expect(read.enemyStack("player_2")).toEqual({ stack: 20, uncertainty: 0 });
    // The same hit is not counted twice.
    read.update(hit);
    expect(read.enemyStack("player_2")?.stack).toBe(20);
  });

  it("adds the major items an enemy was heard taking", () => {
    const read = new MatchRead();
    const s = state(100);
    s.players = [foe()];
    s.enemyMajorItems.set("player_2", { type: "armor", kind: "ra", tick: 100 });
    read.update(s);
    expect(read.enemyStack("player_2")?.stack).toBe(200);
    expect(read.majorTakes(60)).toMatchObject({ own: 0, others: 1 });
  });

  it("counts its own armor jump as a major item taken", () => {
    const read = new MatchRead();
    read.update(state(100));
    const after = state(200);
    after.self.armor = 100;
    read.update(after);
    expect(read.majorTakes(60)).toMatchObject({ own: 1, others: 0 });
  });

  it("records a fight from first contact to a kill, and one that ends in a death", () => {
    const read = new MatchRead();
    const s = state(100);
    s.players = [foe()];
    read.update(s);
    const kill = state(200);
    kill.recentHits = [{ victimEntityId: "player_2", weaponId: "rlauncher", damage: 100, tick: 200 }];
    kill.recentKills = [{ killerId: "player_1", victimId: "player_2", weaponId: "rlauncher", tick: 200 }];
    read.update(kill);
    expect(read.fights(60)).toMatchObject([{ enemy: "player_2", dealt: 100, sawFirst: true, result: "kill" }]);

    const again = state(2000);
    again.players = [foe()];
    again.recentDamage = [
      { attackerId: "player_2", damage: 40, weaponId: "mg", position: { x: 0, y: 0, z: 0 }, tick: 2000 },
    ];
    again.scores.set("player_1", { score: 1, deaths: 0, team: "" });
    read.update(again);
    const died = state(2600);
    died.scores.set("player_1", { score: 1, deaths: 1, team: "" });
    read.update(died);
    expect(read.fights(60).at(-1)).toMatchObject({ result: "death", taken: 40 });
  });

  it("grows unsure of an enemy out of sight", () => {
    const read = new MatchRead();
    const s = state(100);
    s.players = [foe()];
    read.update(s);
    read.update(state(100 + 125 * 15));
    expect(read.enemyStack("player_2")?.uncertainty).toBe(1);
  });
});

describe("MatchRead.openFight", () => {
  it("is the fight under way with an enemy, and none once it has ended", () => {
    const read = new MatchRead();
    const s = state(100);
    s.players = [foe()];
    s.recentDamage = [
      { attackerId: "player_2", damage: 45, weaponId: "rl", position: { x: 0, y: 0, z: 0 }, tick: 100 },
    ];
    read.update(s);
    expect(read.openFight("player_2")).toMatchObject({ taken: 45, result: "open" });
    read.update(state(100 + 125 * 4));
    expect(read.openFight("player_2")).toBeNull();
  });
});
