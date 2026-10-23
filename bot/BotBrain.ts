/**
 * BotBrain - AI decision interface
 *
 * Defines the contract between BotClient and AI logic.
 * The brain receives game state each tick and returns input commands.
 *
 * Two brains implement it: StateMachineBrain, which is rule-based and driven by
 * the goal layer in goals/, and HybridBrain, which layers optional
 * TensorFlow.js networks on top of those rules.
 */

import type { BotDifficulty } from "./BotConfig";
import type { BotGameState } from "./BotGameState";
import type { Mood, MoodEvent } from "./BotMood";
import type { BotNavGraph } from "./BotNavGraph";
import type { BotVision, VisionResult } from "./BotVision";

// ── Bot Input (what the brain outputs) ──────────────────────────────────

export interface BotInput {
  /** Movement direction (view-relative: z=forward, x=strafe) */
  direction: { x: number; y: number; z: number };
  /** Look pitch (radians, positive = up) */
  pitch: number;
  /**
   * Look yaw (radians): where the bot wants to look. The client turns the view
   * there smoothly (BotAimController); movement does not wait for the turn.
   */
  yaw: number;
  /**
   * Yaw `direction` is relative to, when the bot moves one way and looks
   * another (looking ahead along a route, or holding its view in flight).
   * Defaults to `yaw`.
   */
  moveYaw?: number;
  /** Button bitmask (from InputButtons) */
  buttons: number;
  /** Weapon slot to switch to (0 = no change, 1-indexed) */
  weaponSlot: number;
  /**
   * Exact inputs for the next server ticks, one per tick, in order. A movement
   * found offline (a wall jump, say) replays only if every tick's buttons and
   * yaw arrive as simulated, which re-sending the latest decision cannot
   * guarantee. The client sends the script once, then returns to decisions.
   */
  script?: readonly BotInput[];
  /** Stop sending a previous movement script before applying this decision. */
  cancelScript?: boolean;
}

/** The yaw a decision moves along: `direction` is relative to it. */
export function travelYaw(input: BotInput): number {
  return input.moveYaw ?? input.yaw;
}

/** `direction` relative to the look yaw instead, as a player's keys are. */
export function viewDirection(input: BotInput): { x: number; z: number } {
  const turn = travelYaw(input) - input.yaw;
  if (turn === 0) return { x: input.direction.x, z: input.direction.z };
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  return {
    x: input.direction.z * sin + input.direction.x * cos,
    z: input.direction.z * cos - input.direction.x * sin,
  };
}

// ── Bot Brain States ────────────────────────────────────────────────────

export enum BotState {
  SPAWN = "SPAWN",
  FIGHT = "FIGHT",
  CHASE = "CHASE",
  HUNT = "HUNT",
  ITEM_RUN = "ITEM_RUN",
  DODGE = "DODGE",
  RETREAT = "RETREAT",
  IDLE = "IDLE",
}

// ── Abstract Base Class ─────────────────────────────────────────────────

export abstract class BotBrain {
  protected difficulty: BotDifficulty;
  protected currentState: BotState = BotState.SPAWN;

  constructor(difficulty: BotDifficulty) {
    this.difficulty = difficulty;
  }

  /**
   * Make a decision based on current game state and optional vision data.
   *
   * @param state - Raw game state from snapshot
   * @param vision - Optional spatial awareness (null if BSP not loaded)
   * @param visionResult - Optional pre-computed vision query result
   * @param navGraph - Optional navigation graph for pathfinding
   */
  abstract decide(
    state: BotGameState,
    vision?: BotVision | null,
    visionResult?: VisionResult | null,
    navGraph?: BotNavGraph | null,
  ): BotInput;

  /** Get current AI state (for debugging/logging) */
  getState(): BotState {
    return this.currentState;
  }
  /** Compact traversal state for periodic bot diagnostics. */
  getNavigationDebug(): string | null {
    return null;
  }

  /** Update difficulty settings */
  setDifficulty(difficulty: BotDifficulty): void {
    this.difficulty = difficulty;
  }

  /** The settings the view should turn with now; a mood can loosen them. */
  get aimDifficulty(): BotDifficulty {
    return this.difficulty;
  }

  /** Every snapshot, dead or alive, before `decide`: kills and deaths for mood and chat. */
  observe(_state: BotGameState): void {}

  /** Kills and deaths seen since the last call, oldest first. */
  takeMoodEvents(): MoodEvent[] {
    return [];
  }

  /** The mood and streaks, or null for a brain without moods. */
  get moodState(): { mood: Mood; killStreak: number; deathStreak: number } | null {
    return null;
  }
}
