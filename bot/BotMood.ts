/**
 * BotMood — how a bot's last few fights colour the next one, and the odd
 * mistake a person makes.
 *
 * Moods:
 * - calm: the default; any other mood fades back to it after 20 s with nothing new.
 * - confident: two or more kills without dying. Pushes harder (retreats later).
 * - tilted: three deaths in a row. Reckless, with a looser aim and slower reactions.
 * - cautious: low on health, or an enemy known to carry armour, a mega or a
 *   powerup. Backs off sooner.
 *
 * Mistakes: each new fight, at `mistakeRate / 16` odds (one in two on Easy,
 * about one in eighty on Insane), the bot makes one of:
 * - wild_shot: opens fire before its aim is on, a few degrees off.
 * - wrong_weapon: fights for a second with whatever it had out.
 * - item_glance: looks off at an item mid-fight.
 * - forget: stops chasing as soon as the enemy is out of sight.
 */

import type { BotDifficulty } from "./BotConfig";
import type { BotGameState } from "./BotGameState";

export type Mood = "calm" | "confident" | "tilted" | "cautious";
export type Mistake = "wild_shot" | "wrong_weapon" | "item_glance" | "forget";

const TICK_RATE = 125;
const FADE_TICKS = 20 * TICK_RATE;
const CONFIDENT_KILLS = 2;
const TILTED_DEATHS = 3;
const CAUTIOUS_HEALTH = 40;
/** An enemy's armour or powerup is remembered this long. */
const MAJOR_ITEM_MEMORY_TICKS = 30 * TICK_RATE;
const MISTAKES: Mistake[] = ["wild_shot", "wrong_weapon", "item_glance", "forget"];
const MISTAKE_TICKS: Record<Mistake, number> = {
  wild_shot: Math.round(0.4 * TICK_RATE),
  wrong_weapon: Math.round(1 * TICK_RATE),
  item_glance: Math.round(0.5 * TICK_RATE),
  forget: Number.POSITIVE_INFINITY,
};

export interface MoodEvent {
  kind: "kill" | "death";
  /** The other player's entity. */
  otherEntityId: string;
  weaponId: string;
  tick: number;
}

export class BotMood {
  private _mood: Mood = "calm";
  private _kills = 0;
  private _deaths = 0;
  private _lastEventTick = Number.NEGATIVE_INFINITY;
  private readonly _seen = new Set<string>();
  private _mistake: Mistake | null = null;
  private _mistakeUntil = 0;
  private _mistakeTick = 0;

  constructor(private readonly _random: () => number = Math.random) {}

  get mood(): Mood {
    return this._mood;
  }

  get killStreak(): number {
    return this._kills;
  }

  get deathStreak(): number {
    return this._deaths;
  }

  /** Reads the snapshot's kills and deaths; returns the new ones involving this bot. */
  update(state: BotGameState): MoodEvent[] {
    const events: MoodEvent[] = [];
    const self = state.selfEntityId;
    for (const kill of state.recentKills) {
      const key = `${kill.tick}:${kill.killerId}:${kill.victimId}`;
      if (this._seen.has(key)) continue;
      this._seen.add(key);
      if (kill.victimId === self) {
        this._deaths++;
        this._kills = 0;
        this._lastEventTick = kill.tick;
        events.push({ kind: "death", otherEntityId: kill.killerId, weaponId: kill.weaponId, tick: kill.tick });
      } else if (kill.killerId === self) {
        this._kills++;
        this._deaths = 0;
        this._lastEventTick = kill.tick;
        events.push({ kind: "kill", otherEntityId: kill.victimId, weaponId: kill.weaponId, tick: kill.tick });
      }
    }
    if (this._seen.size > 200) this._seen.clear();

    const fresh = state.tick - this._lastEventTick < FADE_TICKS;
    if (!fresh) {
      this._kills = 0;
      this._deaths = 0;
    }
    const armedEnemy = [...state.enemyMajorItems.values()].some((i) => state.tick - i.tick < MAJOR_ITEM_MEMORY_TICKS);
    if (this._deaths >= TILTED_DEATHS) this._mood = "tilted";
    else if (!state.self.isDead && (state.self.health < CAUTIOUS_HEALTH || armedEnemy)) this._mood = "cautious";
    else if (this._kills >= CONFIDENT_KILLS) this._mood = "confident";
    else this._mood = "calm";
    return events;
  }

  /** The health below which the bot backs off, from its usual threshold. */
  retreatHealth(base: number): number {
    switch (this._mood) {
      case "confident":
        return base * 0.6;
      case "tilted":
        return base * 0.4;
      case "cautious":
        return base * 1.5;
      default:
        return base;
    }
  }

  /** The aim settings for this mood: tilted aims looser and reacts slower. */
  aimDifficulty(difficulty: BotDifficulty): BotDifficulty {
    if (this._mood !== "tilted") return difficulty;
    return {
      ...difficulty,
      aimAccuracy: difficulty.aimAccuracy * 0.85,
      reactionTimeMs: difficulty.reactionTimeMs * 1.3,
    };
  }

  /** A new fight began: maybe roll a mistake for it. */
  startFight(tick: number, mistakeRate: number): void {
    this._mistake = null;
    if (this._random() >= mistakeRate / 16) return;
    this._mistake = MISTAKES[Math.floor(this._random() * MISTAKES.length) % MISTAKES.length];
    this._mistakeTick = tick;
    this._mistakeUntil = tick + MISTAKE_TICKS[this._mistake];
  }

  /** The mistake being made now, if any. */
  mistake(tick: number): Mistake | null {
    if (this._mistake && tick >= this._mistakeUntil) this._mistake = null;
    return this._mistake;
  }

  /** When the current mistake began. */
  get mistakeTick(): number {
    return this._mistakeTick;
  }

  /** A fight ended or the bot died. */
  endFight(): void {
    if (this._mistake !== "forget") this._mistake = null;
  }

  clearMistake(): void {
    this._mistake = null;
  }
}
