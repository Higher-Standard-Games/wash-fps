/**
 * OpponentModel — an opponent's habits, learned in this match.
 *
 * What a player notices about someone they are playing: which major items
 * they keep going back for. Built from the MatchRead's record of who was seen
 * or heard taking what, and nothing else, so it starts empty every match and
 * knows only what the bot perceived.
 *
 * `contested()` is what the item planner reads (ContestedItem): for each pickup
 * an opponent has taken more than once in the last HABIT_WINDOW_SECONDS, how
 * much of a habit it is, 0.5 for twice and 1 for three times or more.
 */

import type { MatchRead } from "./MatchRead";

/** Takes older than this are no longer a habit. */
const HABIT_WINDOW_SECONDS = 180;

export interface Habit {
  /** Who: the taker's player id. */
  by: string;
  pickupId: number;
  kind: string;
  count: number;
  lastTick: number;
}

export class OpponentModel {
  private _habits: Habit[] = [];

  /** Re-read habits from the match read. */
  update(read: MatchRead): void {
    const byKey = new Map<string, Habit>();
    for (const take of read.majorTakes(HABIT_WINDOW_SECONDS).takes) {
      if (take.by === "self" || take.pickupId === undefined) continue;
      const key = `${take.by}:${take.pickupId}`;
      const habit = byKey.get(key) ?? { by: take.by, pickupId: take.pickupId, kind: take.kind, count: 0, lastTick: 0 };
      habit.count++;
      habit.lastTick = Math.max(habit.lastTick, take.tick);
      byKey.set(key, habit);
    }
    this._habits = [...byKey.values()].filter((h) => h.count >= 2).sort((a, b) => b.count - a.count);
  }

  /** Habits, strongest first. */
  habits(): readonly Habit[] {
    return this._habits;
  }

  /** Pickup id → how much of a habit taking it is, 0..1. */
  contested(): ReadonlyMap<number, number> {
    const out = new Map<number, number>();
    for (const habit of this._habits) {
      const strength = Math.min(1, (habit.count - 1) / 2);
      out.set(habit.pickupId, Math.max(out.get(habit.pickupId) ?? 0, strength));
    }
    return out;
  }
}
