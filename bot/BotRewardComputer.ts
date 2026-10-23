/**
 * BotRewardComputer — Delayed retrospective reward assignment
 *
 * After a match (episode), this module walks through the recorded
 * TrainingFrames and assigns rewards. Rewards are DELAYED:
 *
 *   Kill at tick 500  → positive reward flows back to ticks ~480-499
 *   Death at tick 500  → negative reward flows back to ticks ~480-499
 *
 * This teaches the network which SEQUENCES of actions led to good/bad
 * outcomes, not just immediate results.
 *
 * Reward signal:
 *   +1.0   Kill
 *   -1.0   Death
 *   +0.3   Damage dealt (per 100 damage)
 *   -0.2   Damage taken (per 100 damage)
 *   +0.2   Item pickup
 *   +0.1   Health gained (from pickup)
 *   +0.05  Staying alive (survival bonus per tick)
 *
 * Rewards decay with a discount factor (gamma) when flowing backward.
 */

import type { TrainingFrame } from "./BotEpisodeRecorder";

// ── Reward Configuration ────────────────────────────────────────────

export interface RewardConfig {
  /** Reward for getting a kill */
  killReward: number;
  /** Penalty for dying */
  deathPenalty: number;
  /** Reward per 100 damage dealt */
  damageDealtReward: number;
  /** Penalty per 100 damage taken */
  damageTakenPenalty: number;
  /** Reward for picking up an item */
  itemPickupReward: number;
  /** Reward per health point gained from pickup */
  healthGainReward: number;
  /** Per-tick survival bonus */
  survivalBonus: number;
  /** Discount factor for backward reward propagation (0-1) */
  gamma: number;
  /** How many ticks backward to propagate rewards */
  lookbackTicks: number;
}

/** Default reward configuration */
export const DEFAULT_REWARDS: RewardConfig = {
  killReward: 1.0,
  deathPenalty: -1.0,
  damageDealtReward: 0.3,
  damageTakenPenalty: -0.2,
  itemPickupReward: 0.2,
  healthGainReward: 0.001,
  survivalBonus: 0.001,
  gamma: 0.95,
  lookbackTicks: 20,
};

// ── BotRewardComputer ───────────────────────────────────────────────

export class BotRewardComputer {
  private _config: RewardConfig;

  constructor(config?: Partial<RewardConfig>) {
    this._config = { ...DEFAULT_REWARDS, ...config };
  }

  /**
   * Compute rewards for all frames in an episode.
   * Modifies frames in-place (sets frame.reward).
   *
   * Two-pass algorithm:
   *   1. Forward pass: assign immediate rewards from events
   *   2. Backward pass: propagate rewards to preceding frames
   */
  computeRewards(frames: TrainingFrame[]): void {
    if (frames.length === 0) return;

    const cfg = this._config;

    // ── Pass 1: Immediate rewards ───────────────────────────────
    for (const frame of frames) {
      let reward = cfg.survivalBonus; // Small reward just for being alive

      // Kill reward
      if (frame.events.kill) {
        reward += cfg.killReward;
      }

      // Death penalty
      if (frame.events.death) {
        reward += cfg.deathPenalty;
      }

      // Damage dealt (normalized per 100 damage)
      if (frame.events.damageDealt > 0) {
        reward += (frame.events.damageDealt / 100) * cfg.damageDealtReward;
      }

      // Damage taken (normalized per 100 damage)
      if (frame.events.damageTaken > 0) {
        reward += (frame.events.damageTaken / 100) * cfg.damageTakenPenalty;
      }

      // Item pickup
      if (frame.events.itemPickedUp) {
        reward += cfg.itemPickupReward;
      }

      // Health gained from pickup
      const healthGained = frame.events.healthAfter - frame.events.healthBefore;
      if (healthGained > 0 && frame.events.damageTaken === 0) {
        reward += healthGained * cfg.healthGainReward;
      }

      frame.reward = reward;
    }

    // ── Pass 2: Backward reward propagation ─────────────────────
    // Significant events (kills, deaths) propagate reward backward
    // to the actions that led up to them.

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];

      // Only propagate from significant events
      const isSignificant = frame.events.kill || frame.events.death || frame.events.damageDealt > 0;

      if (!isSignificant) continue;

      // The reward to propagate (excluding survival bonus)
      const eventReward = frame.reward - cfg.survivalBonus;
      if (Math.abs(eventReward) < 0.001) continue;

      // Propagate backward with exponential decay
      const lookback = Math.min(cfg.lookbackTicks, i);
      for (let j = 1; j <= lookback; j++) {
        const pastIdx = i - j;
        const decay = cfg.gamma ** j;
        frames[pastIdx].reward += eventReward * decay;
      }
    }
  }

  /**
   * Normalize rewards across an episode to [-1, 1] range.
   * Call AFTER computeRewards() for more stable training.
   */
  normalizeRewards(frames: TrainingFrame[]): void {
    if (frames.length === 0) return;

    // Find min/max
    let min = Infinity;
    let max = -Infinity;
    for (const frame of frames) {
      if (frame.reward < min) min = frame.reward;
      if (frame.reward > max) max = frame.reward;
    }

    // Normalize to [-1, 1]
    const range = max - min;
    if (range < 0.001) {
      // All rewards are basically the same — zero them out
      for (const frame of frames) {
        frame.reward = 0;
      }
      return;
    }

    for (const frame of frames) {
      frame.reward = (2 * (frame.reward - min)) / range - 1;
    }
  }

  /**
   * Get episode reward statistics.
   */
  getStats(frames: TrainingFrame[]): {
    totalReward: number;
    avgReward: number;
    minReward: number;
    maxReward: number;
  } {
    if (frames.length === 0) {
      return { totalReward: 0, avgReward: 0, minReward: 0, maxReward: 0 };
    }

    let total = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const frame of frames) {
      total += frame.reward;
      if (frame.reward < min) min = frame.reward;
      if (frame.reward > max) max = frame.reward;
    }

    return {
      totalReward: total,
      avgReward: total / frames.length,
      minReward: min,
      maxReward: max,
    };
  }
}
