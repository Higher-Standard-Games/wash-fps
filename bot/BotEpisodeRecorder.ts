/**
 * BotEpisodeRecorder — Per-tick training frame recording
 *
 * Records every tick of a bot's gameplay as a TrainingFrame:
 *   - Neural network inputs (tactical + combat)
 *   - Actions taken (buttons, weapon, aim)
 *   - Outcomes (filled in later by BotRewardComputer)
 *
 * An "episode" = one full match. After the match:
 *   1. BotRewardComputer assigns delayed rewards
 *   2. BotTrainer converts frames to tensors for model.fit()
 *
 * Memory: ~200 bytes per frame × 10,800 frames (3min match) = ~2.1MB per episode
 */

import { type BotInput, viewDirection } from "./BotBrain";
import type { BotGameState } from "./BotGameState";
import type { BotVision, VisionResult } from "./BotVision";
import { buildModelInputs } from "./ModelInputs";

// ── Training Frame ──────────────────────────────────────────────────

export interface TrainingFrame {
  tick: number;

  /** Tactical network input (Float32Array serialized to number[]) */
  tacticalInput: number[];

  /** Combat network input (null if no enemy visible) */
  combatInput: number[] | null;

  /** What the bot actually did */
  action: {
    buttons: number;
    weaponSlot: number;
    yaw: number;
    pitch: number;
    directionX: number;
    directionZ: number;
  };

  /** Game events that happened on this tick (filled during recording) */
  events: {
    damageDealt: number;
    damageTaken: number;
    kill: boolean;
    death: boolean;
    itemPickedUp: boolean;
    healthBefore: number;
    healthAfter: number;
    armorBefore: number;
    armorAfter: number;
  };

  /** Computed reward (filled in later by BotRewardComputer) */
  reward: number;
}

// ── Episode Summary ─────────────────────────────────────────────────

export interface EpisodeSummary {
  botName: string;
  mapName: string;
  startTick: number;
  endTick: number;
  totalFrames: number;
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
  itemsPickedUp: number;
}

// ── BotEpisodeRecorder ─────────────────────────────────────────────

export class BotEpisodeRecorder {
  private _frames: TrainingFrame[] = [];
  private _botName: string;
  private _mapName: string;
  private _startTick: number = 0;
  private _isRecording: boolean = false;

  // Tracking for delta events
  private _prevHealth: number = 100;
  private _prevArmor: number = 0;

  // Episode stats
  private _kills: number = 0;
  private _deaths: number = 0;
  private _totalDamageDealt: number = 0;
  private _totalDamageTaken: number = 0;
  private _itemsPickedUp: number = 0;

  constructor(botName: string, mapName: string) {
    this._botName = botName;
    this._mapName = mapName;
  }

  // ── Recording Control ───────────────────────────────────────────

  startRecording(tick: number): void {
    this._frames = [];
    this._startTick = tick;
    this._isRecording = true;
    this._kills = 0;
    this._deaths = 0;
    this._totalDamageDealt = 0;
    this._totalDamageTaken = 0;
    this._itemsPickedUp = 0;
  }

  stopRecording(): void {
    this._isRecording = false;
  }

  get isRecording(): boolean {
    return this._isRecording;
  }

  get frameCount(): number {
    return this._frames.length;
  }

  // ── Per-Tick Recording ──────────────────────────────────────────

  /**
   * Record a single tick's data. Call AFTER BotBrain.decide().
   *
   * @param state - Current game state
   * @param input - The BotInput that was sent this tick
   * @param vision - This bot's own vision, as the brain used it
   * @param visionResult - What that vision saw this tick
   */
  recordTick(
    state: BotGameState,
    input: BotInput,
    vision: BotVision | null,
    visionResult: VisionResult | null = null,
  ): void {
    if (!this._isRecording) return;

    // Record death frames (death is a critical training signal!)
    // Skip only if we were already dead on the PREVIOUS tick too
    if (state.self.isDead && this._prevHealth <= 0) return;

    const tick = state.tick;
    const self = state.self;

    // The vectors the brain was fed, built by the same code that fed it
    const { tactical: tacticalInput, combat: combatInput } = buildModelInputs(state, vision, visionResult);

    // Detect events by comparing with previous tick
    const healthDelta = self.health - this._prevHealth;
    const damageTaken = healthDelta < 0 ? -healthDelta : 0;

    // Check for damage dealt via recentDamage events (from our attacks to others)
    // We detect kills by checking score changes
    let damageDealt = 0;
    let kill = false;

    // Note: state.recentDamage contains damage TO us.
    // Damage dealt BY us is tracked via kill events only for now.
    // Future: add outgoing damage tracking to BotGameState.

    // Detect kills by checking kill events
    for (const killEvent of state.recentKills) {
      if (killEvent.tick === tick) {
        if (killEvent.killerId === state.selfPlayerId) {
          kill = true;
          this._kills++;
          damageDealt += 100; // Approximate — kill = at least 100 damage
        }
      }
    }

    // Detect death (health just dropped to 0 or below, or isDead flag set)
    const death = state.self.isDead && this._prevHealth > 0;
    if (death) {
      this._deaths++;
    }

    // Detect item pickup (health or armor increased without combat)
    const armorDelta = self.armor - this._prevArmor;
    const itemPickedUp = (healthDelta > 0 && damageTaken === 0) || armorDelta > 0;
    if (itemPickedUp) {
      this._itemsPickedUp++;
    }

    // Track cumulative stats
    this._totalDamageDealt += damageDealt;
    this._totalDamageTaken += damageTaken;

    // Record frame
    const direction = viewDirection(input);
    const frame: TrainingFrame = {
      tick,
      tacticalInput,
      combatInput,
      action: {
        buttons: input.buttons,
        weaponSlot: input.weaponSlot,
        yaw: input.yaw,
        pitch: input.pitch,
        directionX: direction.x,
        directionZ: direction.z,
      },
      events: {
        damageDealt,
        damageTaken,
        kill,
        death,
        itemPickedUp,
        healthBefore: this._prevHealth,
        healthAfter: self.health,
        armorBefore: this._prevArmor,
        armorAfter: self.armor,
      },
      reward: 0, // Filled in later by BotRewardComputer
    };

    this._frames.push(frame);

    // Update prev state for next tick
    this._prevHealth = self.health;
    this._prevArmor = self.armor;
  }

  // ── Data Access ─────────────────────────────────────────────────

  /** Get all recorded frames (for reward computation + training) */
  getFrames(): TrainingFrame[] {
    return this._frames;
  }

  /** Get episode summary statistics */
  getSummary(): EpisodeSummary {
    const lastTick = this._frames.length > 0 ? this._frames[this._frames.length - 1].tick : this._startTick;

    return {
      botName: this._botName,
      mapName: this._mapName,
      startTick: this._startTick,
      endTick: lastTick,
      totalFrames: this._frames.length,
      kills: this._kills,
      deaths: this._deaths,
      damageDealt: this._totalDamageDealt,
      damageTaken: this._totalDamageTaken,
      itemsPickedUp: this._itemsPickedUp,
    };
  }

  /** Clear all frames (free memory after training) */
  clear(): void {
    this._frames = [];
  }
}
