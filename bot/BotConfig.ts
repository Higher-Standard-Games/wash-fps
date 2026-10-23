/**
 * BotConfig - Bot difficulty, personality, and configuration settings
 *
 * Defines how bots behave: their skill level, reaction speed, aim accuracy,
 * and other parameters that make them feel more or less human.
 */

import { BOT_NAMES } from "../shared/bot/BotNames";

// Re-export InputButtons for convenience (bots use these to construct button bitmasks)
export { InputButtons } from "../../../engine/network/components/InputComponent";

// ── Bot Difficulty ──────────────────────────────────────────────────────────

export interface BotDifficulty {
  /** 0-1: how close to perfect aim (1 = aimbot, 0 = never hits) */
  aimAccuracy: number;
  /** Delay in ms before bot reacts to new threats (50-500ms) */
  reactionTimeMs: number;
  /** How fast crosshair tracks a moving target (radians/sec) */
  trackingSpeed: number;

  /** 0-1: how well they predict enemy movement for projectile weapons */
  predictionSkill: number;
  /** 0-1: how precisely they track item respawn timers */
  itemTimingSkill: number;

  /** 0-1: quality of strafe-jump chains (speed building) */
  strafeJumpSkill: number;
  /** 0-1: how well they dodge incoming projectiles */
  dodgeSkill: number;

  /** Random dumb decisions per minute (forgetting to pick up items, etc.) */
  mistakeRate: number;
  /** Random head scanning movement frequency (seconds between scans) */
  lookAroundInterval: number;
}

/** Preset difficulty levels */
export const DIFFICULTY_PRESETS: Record<string, BotDifficulty> = {
  easy: {
    aimAccuracy: 0.25,
    reactionTimeMs: 450,
    trackingSpeed: 1.5,
    predictionSkill: 0.2,
    itemTimingSkill: 0.1,
    strafeJumpSkill: 0.1,
    dodgeSkill: 0.15,
    mistakeRate: 8,
    lookAroundInterval: 2.0,
  },
  medium: {
    aimAccuracy: 0.5,
    reactionTimeMs: 280,
    trackingSpeed: 3.0,
    predictionSkill: 0.5,
    itemTimingSkill: 0.4,
    strafeJumpSkill: 0.4,
    dodgeSkill: 0.4,
    mistakeRate: 3,
    lookAroundInterval: 3.5,
  },
  hard: {
    aimAccuracy: 0.75,
    reactionTimeMs: 150,
    trackingSpeed: 5.0,
    predictionSkill: 0.75,
    itemTimingSkill: 0.7,
    strafeJumpSkill: 0.7,
    dodgeSkill: 0.7,
    mistakeRate: 1,
    lookAroundInterval: 5.0,
  },
  insane: {
    aimAccuracy: 0.92,
    reactionTimeMs: 60,
    trackingSpeed: 8.0,
    predictionSkill: 0.9,
    itemTimingSkill: 0.9,
    strafeJumpSkill: 0.9,
    dodgeSkill: 0.9,
    mistakeRate: 0.2,
    lookAroundInterval: 8.0,
  },
};

// ── Bot Options (passed when spawning a bot) ────────────────────────────────

export interface BotOptions {
  /** Display name for the bot */
  name: string;
  /** Difficulty level or custom difficulty */
  difficulty: string | BotDifficulty;
  /** Team to join (undefined = auto-balance) */
  team?: string;
  /** Path to TF.js model directory for HybridBrain (undefined = pure state machine) */
  modelDir?: string;
  /**
   * Item-goal arbiter mode (docs/research/BOT_WEIGHTS_AND_GOALS.md §7.7).
   * Per-bot rather than process-wide so two bots can be A/B'd in one match via
   * the BotServer control API. Defaults from BOT_GOAL_ARBITER.
   */
  goalArbiter?: GoalArbiterMode;
  /**
   * Whether the bot says the odd line in chat to humans (bot/chat/BotChat.ts).
   * Defaults to on unless BOT_CHAT=0; training turns it off.
   */
  chat?: boolean;
}

/** Bot chat's default: on unless the BOT_CHAT environment variable is 0. */
export function defaultBotChat(): boolean {
  return process.env.BOT_CHAT !== "0";
}

/**
 * How a bot chooses which item to go for.
 *   legacy  — the old nearest-pickup-wins behaviour
 *   on      — scored goal arbitration
 *   verbose — arbitration plus a per-decision explanation in the bot log
 */
export type GoalArbiterMode = "legacy" | "on" | "verbose";

/**
 * Process default for the arbiter, from `BOT_GOAL_ARBITER`.
 * Follows the `BOT_NAV_CACHE_DIR` precedent — the bot runs as a Node process
 * and has no access to the client `Cvar` system.
 */
export function defaultGoalArbiterMode(): GoalArbiterMode {
  const raw = (process.env.BOT_GOAL_ARBITER ?? "").toLowerCase();
  if (raw === "legacy" || raw === "0" || raw === "off") return "legacy";
  if (raw === "verbose" || raw === "2") return "verbose";
  return "on";
}

// ── Bot Names ──────────────────────────────────────────────────────────────

let _botNameIndex = 0;

/** Reset the name counter (call when all bots are removed) */
export function resetBotNameIndex(): void {
  _botNameIndex = 0;
}

/** Get a unique bot name, cycling through the list with suffixes */
export function getNextBotName(): string {
  const name = BOT_NAMES[_botNameIndex % BOT_NAMES.length];
  const suffix = _botNameIndex >= BOT_NAMES.length ? `_${Math.floor(_botNameIndex / BOT_NAMES.length) + 1}` : "";
  _botNameIndex++;
  return `${name}${suffix}`;
}

/** Resolve a difficulty preset string to a BotDifficulty object */
export function resolveDifficulty(difficulty: string | BotDifficulty): BotDifficulty {
  if (typeof difficulty === "string") {
    return DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.medium;
  }
  return difficulty;
}

// ── Difficulty Tier → Model Directory Mapping ───────────────────────────────

/**
 * How many training rounds each difficulty tier needs.
 * Used by BotTrainer to save checkpoints at tier boundaries.
 *
 *   easy:   0 rounds   (fresh untrained models — pure state machine + noise)
 *   medium: 100 rounds (basic pattern recognition)
 *   hard:   500 rounds (strong tactical awareness)
 *   insane: 2000 rounds (near-optimal play)
 */
export const DIFFICULTY_TRAINING_ROUNDS: Record<string, number> = {
  easy: 0,
  medium: 100,
  hard: 500,
  insane: 2000,
};

/**
 * Get all difficulty tiers in order of training progression.
 * Used by the trainer to save checkpoints at tier boundaries.
 */
export function getDifficultyTiers(): Array<{ name: string; rounds: number }> {
  return Object.entries(DIFFICULTY_TRAINING_ROUNDS)
    .map(([name, rounds]) => ({ name, rounds }))
    .sort((a, b) => a.rounds - b.rounds);
}
