/**
 * How people play, as map-free rules: the stack curve, and the match read
 * leaning a stale estimate on it.
 */

import { describe, expect, it } from "vitest";
import { BotGameState, type VisiblePlayer } from "../BotGameState";
import { type PeopleProfile, stackQuartiles, typicalStackAfter } from "../intel/PeopleProfile";
import { MatchRead } from "../strategy/MatchRead";

const profile: PeopleProfile = {
  version: 1,
  source: { demos: 2, players: 2 },
  stackByAge: [
    { q1: 100, median: 100, q3: 125, n: 1000 },
    { q1: 125, median: 160, q3: 190, n: 1000 },
    { q1: 150, median: 200, q3: 220, n: 1000 },
  ],
};

describe("people's stack curve", () => {
  it("reads between bucket middles and holds past the last", () => {
    expect(typicalStackAfter(profile, 0)).toBe(100);
    expect(typicalStackAfter(profile, 10)).toBe(130);
    expect(typicalStackAfter(profile, 15)).toBe(160);
    expect(typicalStackAfter(profile, 300)).toBe(200);
    expect(typicalStackAfter(null, 30)).toBeNull();
  });

  it("stops at the first bucket with too few samples", () => {
    const big = Array.from({ length: 400 }, (_, i) => 100 + (i % 100));
    expect(stackQuartiles([big, [1, 2, 3], big])).toHaveLength(1);
  });
});

describe("a stale estimate leans on how people stack", () => {
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
  function at(tick: number, seen: boolean): BotGameState {
    const s = new BotGameState();
    s.tick = tick;
    s.selfEntityId = "player_1";
    s.selfPlayerId = "player_1";
    Object.assign(s.self, { health: 100, armor: 0, isDead: false, position: { x: 0, y: 0, z: 0 } });
    s.players = seen ? [foe] : [];
    return s;
  }

  it("keeps a fresh estimate, and rises toward people's stack out of sight", () => {
    const read = new MatchRead((seconds) => typicalStackAfter(profile, seconds));
    read.update(at(0, true));
    expect(read.enemyStack("player_2")?.stack).toBe(100);
    // 30 s later, unseen since spawning: fully stale, people have 200 by then.
    read.update(at(30 * 125, false));
    expect(read.enemyStack("player_2")?.stack).toBe(200);
  });

  it("stays as last known without a profile", () => {
    const read = new MatchRead();
    read.update(at(0, true));
    read.update(at(30 * 125, false));
    expect(read.enemyStack("player_2")?.stack).toBe(100);
  });
});
