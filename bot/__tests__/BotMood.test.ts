/**
 * Moods from the last few fights, and the odd mistake per fight.
 */

import { describe, expect, it } from "vitest";
import { DIFFICULTY_PRESETS } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import { BotMood } from "../BotMood";

function state(): BotGameState {
  const value = new BotGameState();
  value.selfEntityId = "me";
  value.tick = 1000;
  value.self.health = 100;
  return value;
}

function kill(s: BotGameState, killerId: string, victimId: string): void {
  s.recentKills.push({ killerId, victimId, weaponId: "rlauncher", tick: s.tick });
}

describe("moods", () => {
  it("grows confident on a streak, and calms down after a quiet spell", () => {
    const s = state();
    const mood = new BotMood();
    kill(s, "me", "a");
    expect(mood.update(s)).toMatchObject([{ kind: "kill", otherEntityId: "a" }]);
    expect(mood.mood).toBe("calm");
    s.tick += 100;
    kill(s, "me", "b");
    mood.update(s);
    expect(mood.mood).toBe("confident");
    expect(mood.retreatHealth(25)).toBeLessThan(25);
    s.tick += 21 * 125;
    mood.update(s);
    expect(mood.mood).toBe("calm");
  });

  it("tilts after three deaths in a row, and aims looser for it", () => {
    const s = state();
    const mood = new BotMood();
    for (let i = 0; i < 3; i++) {
      s.tick += 300;
      kill(s, `k${i}`, "me");
      mood.update(s);
    }
    expect(mood.mood).toBe("tilted");
    const hard = DIFFICULTY_PRESETS.hard;
    expect(mood.aimDifficulty(hard).aimAccuracy).toBeLessThan(hard.aimAccuracy);
    expect(mood.aimDifficulty(hard).reactionTimeMs).toBeGreaterThan(hard.reactionTimeMs);
  });

  it("is cautious on low health or against an enemy with armour", () => {
    const s = state();
    const mood = new BotMood();
    s.self.health = 30;
    mood.update(s);
    expect(mood.mood).toBe("cautious");
    s.self.health = 100;
    s.enemyMajorItems.set("foe", { type: "armor", kind: "ra", tick: s.tick });
    mood.update(s);
    expect(mood.mood).toBe("cautious");
    expect(mood.retreatHealth(25)).toBeGreaterThan(25);
  });

  it("counts each kill once", () => {
    const s = state();
    const mood = new BotMood();
    kill(s, "me", "a");
    mood.update(s);
    expect(mood.update(s)).toEqual([]);
    expect(mood.killStreak).toBe(1);
  });
});

describe("mistakes", () => {
  it("are made at mistakeRate/16 odds per fight, one at a time, and pass", () => {
    const rolls = [0.4, 0.3]; // roll under 8/16 on Easy, then pick the second mistake
    const mood = new BotMood(() => rolls.shift() ?? 0.99);
    mood.startFight(0, DIFFICULTY_PRESETS.easy.mistakeRate);
    expect(mood.mistake(0)).toBe("wrong_weapon");
    expect(mood.mistake(200)).toBeNull();

    const insane = new BotMood(() => 0.4);
    insane.startFight(0, DIFFICULTY_PRESETS.insane.mistakeRate);
    expect(insane.mistake(0)).toBeNull();
  });
});
