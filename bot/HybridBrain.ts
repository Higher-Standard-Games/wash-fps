/**
 * HybridBrain — StateMachineBrain + TensorFlow.js Neural Enhancement
 *
 * Wraps the existing rule-based StateMachineBrain and optionally enhances
 * its decisions with trained TensorFlow.js neural networks.
 *
 * Architecture:
 *   1. StateMachineBrain.decide() → base decision (always runs)
 *   2. TacticalModel.predict()    → strategic overrides (if loaded)
 *   3. CombatModel.predict()      → combat refinement (if loaded, in FIGHT)
 *
 * Without loaded models, behaves identically to StateMachineBrain.
 * All tensor operations wrapped in tf.tidy() to prevent memory leaks.
 *
 * NOTE: Uses TFBackend abstraction — tries native C++ addon first,
 * falls back to pure JS. BotClient handles the case where TF.js
 * is entirely unavailable.
 */

import type { LayersModel, Tensor } from "@tensorflow/tfjs-node";
import type { BotInput } from "./BotBrain";
import { BotBrain, BotState } from "./BotBrain";
import type { BotDifficulty, GoalArbiterMode } from "./BotConfig";
import { InputButtons } from "./BotConfig";
import type { BotGameState } from "./BotGameState";
import type { Mood, MoodEvent } from "./BotMood";
import { canInitiateSlide } from "./BotMovementProfile";
import type { BotVision, VisionResult } from "./BotVision";
import { getWeaponProfile } from "./BotWeaponProfile";
import {
  angleDelta,
  COMBAT_OUTPUT_KINDS,
  COMBAT_OUTPUT_NAMES,
  decodeOutputs,
  decodeWeaponSlot,
  sharpen,
  TACTICAL_OUTPUT_KINDS,
  TACTICAL_OUTPUT_NAMES,
} from "./CloningTargets";
import { type DenseLayer, extractDenseStack, forward, inputWidth } from "./DenseForward";
import {
  buildModelInputs,
  COMBAT_MODEL_INPUT,
  FeatureHistory,
  intervalMismatch,
  TACTICAL_MODEL_INPUT,
  typicalInterval,
} from "./ModelInputs";
import { checkCompatibility, readMetadata } from "./ModelMetadata";
import { StateMachineBrain } from "./StateMachineBrain";
import { getTF, initTF } from "./TFBackend";
import { LEARNED_SKILL } from "./TrainingReport";
import { typedLoss } from "./TypedLoss";

// ── Output Index Constants ──────────────────────────────────────────
// These map neural network output indices to semantic meanings.
// Changing these requires retraining models.

/**
 * TacticalBrain output indices (5 outputs)
 *
 * Every one of these is something a person presses, which is what makes them
 * trainable from a demo. The head used to begin with three mode confidences —
 * FIGHT, RETREAT, HUNT — that no recording can label; which mode to be in is the
 * state machine's decision, and sharpening it belongs to self-play.
 */
const TACT = {
  MOVE_SPRINT: 0, // 0-1: should sprint
  MOVE_SLIDE: 1, // 0-1: should crouch-slide
  MOVE_JUMP: 2, // 0-1: should jump
  WEAPON_SWITCH: 3, // 0-1: should switch weapon (>0.5 = yes)
  WEAPON_SLOT: 4, // 0-1: which slot, over MAX_WEAPON_SLOT
} as const;

export const TACTICAL_OUTPUT_SIZE = 5;

/** CombatBrain output indices (6 outputs) */
const COMBAT = {
  SHOULD_FIRE: 0, // 0-1: fire weapon
  SHOULD_ADS: 1, // 0-1: aim down sights
  AIM_YAW_ADJUST: 2, // 0-1: yaw adjustment (0.5 = none, 0 = left, 1 = right)
  AIM_PITCH_ADJUST: 3, // 0-1: pitch adjustment (0.5 = none, 0 = down, 1 = up)
  DODGE_LEFT: 4, // 0-1: strafe left to dodge
  DODGE_RIGHT: 5, // 0-1: strafe right to dodge
} as const;

export const COMBAT_OUTPUT_SIZE = 6;

/** Decisions to watch before comparing this server's snapshot spacing with training's. */
const INTERVAL_SAMPLE = 64;

/** Adam's step size when the trainer names none. */
export const DEFAULT_LEARNING_RATE = 0.001;

// ── Confidence Thresholds ───────────────────────────────────────────
// Only override state machine when neural net is confident enough.

/**
 * How decisive the network's yes-or-no answers are made before they are drawn.
 *
 * Buttons are sampled, not thresholded: at temperature 1 a bot presses a button
 * exactly as often as the network thinks a person would in its place, so two bots
 * in the same spot do not do the same thing. A half leans toward the likelier
 * answer, so a held button is not dropped on the one frame in ten the network is
 * unsure about.
 */
const SAMPLING_TEMPERATURE = 0.5;

// ── Model type alias ──
// The module itself is loaded at run time through getTF(); this is a type
// import only, so nothing of TensorFlow loads with this file.

type TFModel = LayersModel;

// ── HybridBrain ─────────────────────────────────────────────────────

export class HybridBrain extends BotBrain {
  private _stateMachine: StateMachineBrain;
  private _tacticalModel: TFModel | null = null;
  private _combatModel: TFModel | null = null;
  /** The last few frames each head has seen, stacked the way training stacks them. */
  private readonly _tacticalHistory = new FeatureHistory();
  private readonly _combatHistory = new FeatureHistory();
  /**
   * The same weights as plain arrays, so a decision does not pay a round trip
   * into TensorFlow. Null when not yet read, or when a model is something the
   * plain forward pass cannot run — then inference goes through TensorFlow.
   */
  private _tacticalForward: DenseLayer[] | null = null;
  private _combatForward: DenseLayer[] | null = null;
  /** Set whenever the weights may have changed since they were last read out. */
  private _forwardStale = true;
  private readonly _random: () => number;
  /**
   * Held-out skill per output, from the weights' metadata. An output is acted on
   * only as far as this says it was learned; empty means nothing was proven and
   * the network advises nothing, however confident its outputs look.
   */
  private _skill: Record<string, number> = {};
  /** Frame spacing the loaded weights were trained on, from their metadata. */
  private _trainedInterval: number | null = null;
  /** Ticks of recent decisions, to measure this server's spacing once. */
  private _decisionTicks: number[] = [];
  private _intervalChecked = false;
  private _warmedUp: boolean = false;

  /**
   * @param random Where sampled decisions draw from — `Math.random` in a match,
   *   something fixed in a test.
   */
  constructor(difficulty: BotDifficulty, random: () => number = Math.random, goalArbiter?: GoalArbiterMode) {
    super(difficulty);
    this._stateMachine = new StateMachineBrain(difficulty, goalArbiter);
    this._random = random;
  }

  /**
   * Load pre-trained TF.js models from disk.
   * Initializes TF.js backend if not already done.
   * Gracefully falls back if models don't exist.
   */
  /**
   * Load both heads' weights from a directory. Resolves true if either loaded;
   * a missing or refused model leaves the bot on the state machine, which is a
   * working bot, so it is reported rather than thrown.
   */
  async loadModels(modelDir: string): Promise<boolean> {
    await initTF();
    const tf = getTF();

    // Weights carry no record of the features they expect, so a normalizer
    // change would otherwise load cleanly and read nonsense.
    const metadata = readMetadata(modelDir);
    this._trainedInterval = metadata?.frameIntervalTicks ?? null;
    this._skill = metadata?.outputSkill ?? {};
    const compatibility = checkCompatibility(metadata);
    if (!compatibility.ok) {
      console.error(`[HybridBrain] Refusing models in ${modelDir}: ${compatibility.reason}`);
      console.error("[HybridBrain] Retrain them, or point at models built for this feature set.");
      return false;
    }
    if (compatibility.reason) {
      console.warn(`[HybridBrain] ${compatibility.reason} (${modelDir})`);
    }

    try {
      const model = await tf.loadLayersModel(`file://${modelDir}/tactical/model.json`);
      this._tacticalModel = this._acceptModel(model, TACTICAL_MODEL_INPUT, "tactical", modelDir);
      if (this._tacticalModel) console.log(`[HybridBrain] Loaded tactical model from ${modelDir}/tactical/`);
    } catch {
      console.warn(`[HybridBrain] No tactical model found at ${modelDir}/tactical/ — using state machine`);
    }

    try {
      const model = await tf.loadLayersModel(`file://${modelDir}/combat/model.json`);
      this._combatModel = this._acceptModel(model, COMBAT_MODEL_INPUT, "combat", modelDir);
      if (this._combatModel) console.log(`[HybridBrain] Loaded combat model from ${modelDir}/combat/`);
    } catch {
      console.warn(`[HybridBrain] No combat model found at ${modelDir}/combat/ — using state machine`);
    }

    if (this.hasModels && Object.keys(this._skill).length === 0) {
      console.warn(
        `[HybridBrain] No held-out skill recorded for ${modelDir} — nothing was measured on a match the weights ` +
          "never saw, so the network advises nothing. Train on two or more matches.",
      );
    }

    // A model loaded from disk comes back uncompiled, and --resume threw on its
    // first fit. Compiling here makes a loaded model trainable; a trainer calls
    // prepareForTraining again with its own learning rate.
    this.prepareForTraining();

    // Warm up models with dummy predictions to avoid cold-start latency
    this._forwardStale = true;
    this._warmup();
    return this.hasModels;
  }

  /**
   * Compile both heads for training with the loss their output kinds need —
   * cross-entropy on the yes-or-no answers, Huber on the turns.
   */
  prepareForTraining(learningRate: number = DEFAULT_LEARNING_RATE): void {
    if (!this.hasModels) return;
    const tf = getTF();
    this._tacticalModel?.compile({
      optimizer: tf.train.adam(learningRate),
      loss: typedLoss(tf, TACTICAL_OUTPUT_KINDS),
    });
    this._combatModel?.compile({
      optimizer: tf.train.adam(learningRate),
      loss: typedLoss(tf, COMBAT_OUTPUT_KINDS),
    });
  }

  /**
   * Create fresh untrained models (for training from scratch).
   * Initializes TF.js backend if not already done.
   *
   * The learning rate is the caller's, because `--lr` is the trainer's to set;
   * it used to be fixed here, so the flag was accepted and then ignored.
   */
  async createFreshModels(learningRate = DEFAULT_LEARNING_RATE): Promise<void> {
    await initTF();
    const tf = getTF();

    this._tacticalModel = tf.sequential({
      layers: [
        tf.layers.dense({ inputShape: [TACTICAL_MODEL_INPUT], units: 16, activation: "relu" }),
        tf.layers.dense({ units: 12, activation: "relu" }),
        tf.layers.dense({ units: TACTICAL_OUTPUT_SIZE, activation: "linear" }),
      ],
    });

    this._combatModel = tf.sequential({
      layers: [
        tf.layers.dense({ inputShape: [COMBAT_MODEL_INPUT], units: 12, activation: "relu" }),
        tf.layers.dense({ units: 8, activation: "relu" }),
        tf.layers.dense({ units: COMBAT_OUTPUT_SIZE, activation: "linear" }),
      ],
    });
    this.prepareForTraining(learningRate);

    console.log("[HybridBrain] Created fresh untrained models");
    this._forwardStale = true;
    this._warmup();
  }

  /**
   * Save current models to disk.
   */
  async saveModels(modelDir: string): Promise<void> {
    if (this._tacticalModel) {
      await this._tacticalModel.save(`file://${modelDir}/tactical`);
      console.log(`[HybridBrain] Saved tactical model to ${modelDir}/tactical/`);
    }
    if (this._combatModel) {
      await this._combatModel.save(`file://${modelDir}/combat`);
      console.log(`[HybridBrain] Saved combat model to ${modelDir}/combat/`);
    }
  }

  /** Get the tactical model for external training */
  /**
   * The model itself, for training. Whoever holds it can change its weights, so
   * handing it out marks the plain copy used for decisions stale; it is read out
   * again before the next one.
   */
  get tacticalModel(): TFModel | null {
    this._forwardStale = true;
    return this._tacticalModel;
  }

  /** Get the combat model for external training */
  get combatModel(): TFModel | null {
    this._forwardStale = true;
    return this._combatModel;
  }

  /** Whether any neural models are loaded */
  /**
   * The stacked vectors the networks would be fed at the last decision, or
   * empty before any. The one promise this whole system rests on is that these
   * are built exactly as training builds them; this is how that gets checked.
   */
  get lastInputs(): { tactical: number[]; combat: number[] } {
    return { tactical: this._tacticalHistory.stacked(), combat: this._combatHistory.stacked() };
  }

  get hasModels(): boolean {
    return this._tacticalModel !== null || this._combatModel !== null;
  }
  override get aimDifficulty(): BotDifficulty {
    return this._stateMachine.aimDifficulty;
  }

  override observe(state: BotGameState): void {
    this._stateMachine.observe(state);
  }

  override takeMoodEvents(): MoodEvent[] {
    return this._stateMachine.takeMoodEvents();
  }

  override get moodState(): { mood: Mood; killStreak: number; deathStreak: number } | null {
    return this._stateMachine.moodState;
  }

  override getNavigationDebug(): string | null {
    return this._stateMachine.getNavigationDebug();
  }

  // ── Core Decision Loop ──────────────────────────────────────────

  decide(
    state: BotGameState,
    vision?: BotVision | null,
    visionResult?: VisionResult | null,
    navGraph?: import("./BotNavGraph").BotNavGraph | null,
  ): BotInput {
    // 1. State machine always runs — gives us the baseline decision
    const baseInput = this._stateMachine.decide(state, vision, visionResult, navGraph);
    const currentState = this._stateMachine.getState();

    // Sync our state for external queries
    this.currentState = currentState;

    // 2. No models loaded → pure state machine (perfectly functional!)
    if (!this._tacticalModel && !this._combatModel) {
      return baseInput;
    }

    // A dead frame never enters a stack. A bot is not normally asked to decide
    // while dead, and the stacks' own gap rule is what notices the respawn.
    if (state.self.isDead) {
      return baseInput;
    }

    // 3. Keep the stacks current on every decision, whether or not the network
    // is consulted this time, because a demo's stacks are built from every frame
    // a person played — including the ones spent mid-manoeuvre.
    const inputs = buildModelInputs(state, vision ?? null, visionResult ?? null);
    this._tacticalHistory.push(inputs.tactical, state.tick);
    this._checkInterval(state.tick);
    if (inputs.combat) {
      this._combatHistory.push(inputs.combat, state.tick);
    } else {
      this._combatHistory.clear();
    }

    // Authored sequences own their complete input while active. Neural layers
    // may score future candidates but cannot mutate an in-flight sequence.
    if (this._stateMachine.isSequenceActive()) {
      return baseInput;
    }

    // 4. Tactical model: strategic decision enhancement
    if (this._tacticalModel) {
      const tactOutput = this._runTactical(this._tacticalHistory.stacked());
      if (tactOutput) {
        this._applyTactical(tactOutput, baseInput, state, currentState);
      }
    }

    // 5. Combat model: aim/fire refinement (only during FIGHT), about the same
    // enemy the stack was built about — the first in line of sight, else the
    // nearest, exactly as in training
    if (this._combatModel && currentState === BotState.FIGHT && inputs.combat) {
      const combatOutput = this._runCombat(this._combatHistory.stacked());
      if (combatOutput) {
        this._applyCombat(combatOutput, baseInput, state);
      }
    }

    return baseInput;
  }

  /**
   * Once enough snapshots have arrived, say whether they are spaced like the
   * frames the weights learned from. Nothing is refused over it — the bot still
   * plays — but a stack spanning twice the time it did in training reads every
   * movement at the wrong speed, and nobody would otherwise know why.
   */
  private _checkInterval(tick: number): void {
    if (this._intervalChecked || this._trainedInterval === null) return;
    this._decisionTicks.push(tick);
    if (this._decisionTicks.length < INTERVAL_SAMPLE) return;
    this._intervalChecked = true;
    const observed = typicalInterval(this._decisionTicks);
    this._decisionTicks = [];
    const mismatch = observed === null ? null : intervalMismatch(this._trainedInterval, observed);
    if (mismatch) console.warn(`[HybridBrain] ${mismatch}`);
  }

  // ── Neural Inference ────────────────────────────────────────────

  /**
   * Read the weights out into plain arrays if they may have changed. A stack the
   * plain pass cannot run, or one whose width is not what this build feeds, is
   * left to TensorFlow — slower, never wrong.
   */
  private _refreshForward(): void {
    if (!this._forwardStale) return;
    this._forwardStale = false;
    const read = (model: TFModel | null, width: number): DenseLayer[] | null => {
      try {
        const layers = extractDenseStack(model);
        return layers && inputWidth(layers) === width ? layers : null;
      } catch {
        return null;
      }
    };
    this._tacticalForward = read(this._tacticalModel, TACTICAL_MODEL_INPUT);
    this._combatForward = read(this._combatModel, COMBAT_MODEL_INPUT);
  }

  /**
   * Run tactical model inference on a stacked input. Returns the outputs or null.
   */
  private _runTactical(stacked: number[]): Float32Array | null {
    this._refreshForward();
    if (this._tacticalForward) return forward(this._tacticalForward, stacked);
    try {
      const tf = getTF();
      return tf.tidy(() => {
        const tensor = tf.tensor2d([stacked]);
        const prediction = this._tacticalModel!.predict(tensor);
        return (prediction as Tensor).dataSync() as Float32Array;
      });
    } catch (e) {
      console.error("[HybridBrain] Tactical inference error:", e);
      return null;
    }
  }

  /**
   * Run combat model inference on a stacked input. Returns the outputs or null.
   */
  private _runCombat(stacked: number[]): Float32Array | null {
    this._refreshForward();
    if (this._combatForward) return forward(this._combatForward, stacked);
    try {
      const tf = getTF();
      return tf.tidy(() => {
        const tensor = tf.tensor2d([stacked]);
        const prediction = this._combatModel!.predict(tensor);
        return (prediction as Tensor).dataSync() as Float32Array;
      });
    } catch (e) {
      console.error("[HybridBrain] Combat inference error:", e);
      return null;
    }
  }

  // ── Output Interpretation ───────────────────────────────────────

  /**
   * Apply tactical model outputs to enhance the base decision.
   *
   * Each output is acted on only if it was learned — positive skill on matches
   * the weights never saw — and then drawn, not thresholded. An output that was
   * not learned leaves the state machine's decision exactly as it was.
   */
  private _applyTactical(raw: Float32Array, input: BotInput, state: BotGameState, currentState: BotState): void {
    const output = decodeOutputs(raw, TACTICAL_OUTPUT_KINDS);
    // Movement mechanics (additive — don't remove what state machine set)
    const speed = Math.sqrt(state.self.velocity.x ** 2 + state.self.velocity.y ** 2 + state.self.velocity.z ** 2);

    // Sprint suggestion
    if (this._draws(TACTICAL_OUTPUT_NAMES, TACT.MOVE_SPRINT, output) && currentState !== BotState.FIGHT) {
      input.buttons |= InputButtons.SPRINT;
      input.buttons |= InputButtons.FORWARD;
    }

    // Crouch-slide suggestion (only if speed allows)
    if (
      this._draws(TACTICAL_OUTPUT_NAMES, TACT.MOVE_SLIDE, output) &&
      canInitiateSlide(speed, true) &&
      (input.buttons & InputButtons.ALT_FIRE) === 0
    ) {
      input.buttons |= InputButtons.CROUCH | InputButtons.FORWARD | InputButtons.SPRINT;
    }

    // Jump suggestion
    if (this._draws(TACTICAL_OUTPUT_NAMES, TACT.MOVE_JUMP, output)) {
      input.buttons |= InputButtons.JUMP;
    }

    // Weapon switch suggestion. The slot is decoded with the inverse of the
    // label it was trained on, so an output means the same weapon on both sides
    // of the network, and is taken only if the bot is carrying it.
    if (
      this._draws(TACTICAL_OUTPUT_NAMES, TACT.WEAPON_SWITCH, output) &&
      this._skillAt(TACTICAL_OUTPUT_NAMES, TACT.WEAPON_SLOT) > 0
    ) {
      const slot = decodeWeaponSlot(output[TACT.WEAPON_SLOT]);
      if (slot >= 1 && slot <= state.self.weapons.length) {
        input.weaponSlot = slot;
      }
    }
  }

  /**
   * Apply combat model outputs to refine aim and fire decisions.
   *
   * Buttons are drawn as in the tactical head. Aim is a turn from where the bot is
   * looking now — the label is the turn a person made between two frames — and
   * the bot moves from the state machine's aim toward that turn by as much as the
   * output's skill: a network that learned aim well steers, one that barely
   * learned it nudges, one that did not leaves the aim alone.
   */
  private _applyCombat(raw: Float32Array, input: BotInput, state: BotGameState): void {
    const output = decodeOutputs(raw, COMBAT_OUTPUT_KINDS);
    const profile = getWeaponProfile(state.self.currentWeapon);
    const baseAltFireCharge =
      profile.hasChargedProjectile &&
      (input.buttons & InputButtons.ALT_FIRE) !== 0 &&
      (input.buttons & InputButtons.FIRE) === 0;

    // Fire control: a learned fire output decides either way
    if (this._skillAt(COMBAT_OUTPUT_NAMES, COMBAT.SHOULD_FIRE) > 0) {
      if (this._draws(COMBAT_OUTPUT_NAMES, COMBAT.SHOULD_FIRE, output)) {
        input.buttons |= InputButtons.FIRE;
      } else {
        input.buttons &= ~InputButtons.FIRE;
      }
    }

    // ADS control. ALT_FIRE is allowed only as part of an attack: either firing
    // a ranged weapon or holding an existing charged alt-fire attack.
    if (this._skillAt(COMBAT_OUTPUT_NAMES, COMBAT.SHOULD_ADS) > 0) {
      const isFiring = (input.buttons & InputButtons.FIRE) !== 0;
      if (this._draws(COMBAT_OUTPUT_NAMES, COMBAT.SHOULD_ADS, output) && (isFiring || baseAltFireCharge)) {
        input.buttons |= InputButtons.ALT_FIRE;
      } else if (!baseAltFireCharge) {
        input.buttons &= ~InputButtons.ALT_FIRE;
      }
    }

    // Aim: toward where a person would have turned from here, by as far as that
    // output was learned
    const yawTrust = Math.min(1, Math.max(0, this._skillAt(COMBAT_OUTPUT_NAMES, COMBAT.AIM_YAW_ADJUST)));
    if (yawTrust > 0) {
      const turnedTo = state.self.yaw + output[COMBAT.AIM_YAW_ADJUST];
      input.yaw += yawTrust * angleDelta(input.yaw, turnedTo);
    }
    const pitchTrust = Math.min(1, Math.max(0, this._skillAt(COMBAT_OUTPUT_NAMES, COMBAT.AIM_PITCH_ADJUST)));
    if (pitchTrust > 0) {
      const turnedTo = state.self.pitch + output[COMBAT.AIM_PITCH_ADJUST];
      input.pitch += pitchTrust * (turnedTo - input.pitch);
    }

    // Dodge suggestions (strafe direction override)
    // Must set LEFT/RIGHT button flags — server strafe physics requires them
    const left = this._draws(COMBAT_OUTPUT_NAMES, COMBAT.DODGE_LEFT, output);
    const right = this._draws(COMBAT_OUTPUT_NAMES, COMBAT.DODGE_RIGHT, output);
    const goLeft = left && (!right || output[COMBAT.DODGE_LEFT] >= output[COMBAT.DODGE_RIGHT]);
    if (goLeft) {
      input.direction.x = -1;
      input.buttons |= InputButtons.LEFT;
      input.buttons &= ~InputButtons.RIGHT;
    } else if (right) {
      input.direction.x = 1;
      input.buttons |= InputButtons.RIGHT;
      input.buttons &= ~InputButtons.LEFT;
    }
  }

  /**
   * Held-out skill of one output, or 0 when nothing was measured or what was
   * measured is within the noise of a fixed answer — the same line the training
   * report draws, so what it calls learned is what a bot acts on.
   */
  private _skillAt(names: readonly string[], index: number): number {
    const skill = this._skill[names[index]];
    return typeof skill === "number" && Number.isFinite(skill) && skill >= LEARNED_SKILL ? skill : 0;
  }

  /**
   * Whether this yes-or-no output says yes this time: only if it was learned,
   * and then drawn from its probability rather than compared with a threshold.
   */
  private _draws(names: readonly string[], index: number, output: readonly number[]): boolean {
    if (this._skillAt(names, index) <= 0) return false;
    return this._random() < sharpen(output[index], SAMPLING_TEMPERATURE);
  }

  // ── Warmup ──────────────────────────────────────────────────────

  /**
   * Run dummy predictions to warm up TF.js (first call is ~50-100ms).
   */
  /**
   * Keep a loaded model only if it takes the vector this build feeds it.
   *
   * Metadata catches most mismatches, but weights with none beside them still
   * load — and a model of the wrong width does not fail once, it throws on every
   * decision for the rest of the match. Checking the shape the weights declare
   * turns that into one refusal at load.
   */
  private _acceptModel(model: TFModel, expected: number, label: string, modelDir: string): TFModel | null {
    const width = model?.inputs?.[0]?.shape?.[1];
    const layers = model?.layers ?? [];
    const lastActivation = layers[layers.length - 1]?.getConfig?.()?.activation;
    let problem: string | null = null;
    if (width !== expected) problem = `it takes ${width} inputs, this build feeds ${expected}`;
    // Weights from when every output went through a sigmoid answer in
    // probabilities where this build reads logits and turns
    else if (lastActivation !== undefined && lastActivation !== "linear") {
      problem = `its outputs go through a ${lastActivation}, this build reads logits and turns from a linear layer`;
    }
    if (!problem) return model;
    console.error(`[HybridBrain] Refusing the ${label} model in ${modelDir}: ${problem}`);
    model?.dispose?.();
    return null;
  }

  private _warmup(): void {
    if (this._warmedUp) return;

    try {
      const tf = getTF();
      tf.tidy(() => {
        if (this._tacticalModel) {
          const dummyTact = tf.zeros([1, TACTICAL_MODEL_INPUT]);
          this._tacticalModel.predict(dummyTact);
        }
        if (this._combatModel) {
          const dummyCombat = tf.zeros([1, COMBAT_MODEL_INPUT]);
          this._combatModel.predict(dummyCombat);
        }
      });
    } catch (e) {
      console.warn("[HybridBrain] Warmup failed:", e);
    }

    this._warmedUp = true;
    console.log("[HybridBrain] Model warmup complete");
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  /**
   * Dispose TF.js models to free memory.
   * Call when the bot is being removed.
   */
  dispose(): void {
    this._tacticalForward = null;
    this._combatForward = null;
    this._forwardStale = true;
    if (this._tacticalModel) {
      this._tacticalModel.dispose();
      this._tacticalModel = null;
    }
    if (this._combatModel) {
      this._combatModel.dispose();
      this._combatModel = null;
    }
  }
}
