/**
 * BotTrainer — Autonomous Training Loop
 *
 * Runs headless training sessions: spins up a game server, connects
 * HybridBrain bots, records episodes, computes rewards, and trains
 * the neural networks using TensorFlow.js.
 *
 * Usage:
 *   const trainer = new BotTrainer({ map: 'wdm7', rounds: 100 });
 *   await trainer.train();
 *
 * Architecture:
 *   1. Start headless GameServer (WebSocket only, no WebTransport)
 *   2. Connect 2+ HybridBrain bots with fresh or loaded models
 *   3. Play round (time-limited)
 *   4. BotEpisodeRecorder captures every tick
 *   5. BotRewardComputer assigns delayed rewards
 *   6. Convert frames to tensors → model.fit()
 *   7. Log progress, save checkpoint every N rounds
 *   8. Repeat
 *
 * Performance with @tensorflow/tfjs-node C++ backend:
 *   - 3-min match (~10,800 frames) trains in ~3-5 seconds
 *   - 500 rounds ≈ 25-40 minutes total
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LayersModel } from "@tensorflow/tfjs-node";
import type { BotClient } from "./BotClient";
import { getDifficultyTiers, getNextBotName, resetBotNameIndex } from "./BotConfig";
import { BotEpisodeRecorder, type TrainingFrame } from "./BotEpisodeRecorder";
import { COMBAT_INPUT_SIZE, TACTICAL_INPUT_SIZE } from "./BotInputNormalizer";
import { BotRewardComputer } from "./BotRewardComputer";
import { BotServer } from "./BotServer";
import {
  buildCorpusPairs,
  COMBAT_OUTPUT_KINDS,
  COMBAT_OUTPUT_NAMES,
  resampleByWeight,
  rewardWeights,
  TACTICAL_OUTPUT_KINDS,
  TACTICAL_OUTPUT_NAMES,
  type TrainingPair,
} from "./CloningTargets";
import { HybridBrain } from "./HybridBrain";
import { typicalInterval } from "./ModelInputs";
import { describeCurrentFeatures, writeMetadata } from "./ModelMetadata";
import { getTF } from "./TFBackend";
import { LEARNED_SKILL, scoreModel, skillByName } from "./TrainingReport";

// ── Training Configuration ──────────────────────────────────────────

export interface TrainerConfig {
  /** Map name to train on */
  map: string;
  /** Number of training rounds */
  rounds: number;
  /** Number of bots per round (2+ for fights) */
  botCount: number;
  /** Match duration in ms (default: 180_000 = 3 min) */
  matchDurationMs: number;
  /** Game server port for training (default: 17777) */
  serverPort: number;
  /** Directory to save/load models */
  modelDir: string;
  /** Save checkpoint every N rounds */
  checkpointInterval: number;
  /** Training epochs per round */
  epochs: number;
  /** Training batch size */
  batchSize: number;
  /** Learning rate */
  learningRate: number;
  /** Bot difficulty for training */
  difficulty: string;
  /** Load existing models to continue training */
  resumeTraining: boolean;
  /** Gametype for training matches */
  gametype: string;
}

export const DEFAULT_TRAINER_CONFIG: TrainerConfig = {
  map: "wdm7",
  rounds: 100,
  botCount: 2,
  matchDurationMs: 180_000, // 3 minutes
  serverPort: 17777, // Different from regular server
  modelDir: "./src/games/fps/models",
  checkpointInterval: 10,
  epochs: 5,
  batchSize: 32,
  learningRate: 0.001,
  difficulty: "medium",
  resumeTraining: false,
  gametype: "duel",
};

// ── Training Statistics ─────────────────────────────────────────────

interface RoundStats {
  round: number;
  duration: number;
  totalFrames: number;
  totalKills: number;
  totalDeaths: number;
  avgReward: number;
  tacticalLoss: number;
  combatLoss: number;
}

// ── BotTrainer ──────────────────────────────────────────────────────

export class BotTrainer {
  private _config: TrainerConfig;
  private _brain: HybridBrain;
  private _rewardComputer: BotRewardComputer;
  private _roundStats: RoundStats[] = [];
  private _startTime: number = 0;
  /** Spawns each round's bots the way the bot server does: with the map and the weights. */
  private _botServer: BotServer | null = null;
  /** Whether the weights in the latest directory were trained, so bots may play them. */
  private _playable = false;
  private _roundsTrained = 0;
  private _framesTrained = 0;
  private _frameInterval: number | undefined;
  /**
   * Held-out skill of the weights, measured on each new round before training on
   * it — play those weights have never seen. Saved beside them, so a bot acts on
   * an output only as far as it was learned.
   */
  private _outputSkill: Record<string, number> | undefined;

  constructor(config?: Partial<TrainerConfig>) {
    this._config = { ...DEFAULT_TRAINER_CONFIG, ...config };
    this._brain = new HybridBrain({
      aimAccuracy: 0.5,
      reactionTimeMs: 200,
      trackingSpeed: 3.0,
      predictionSkill: 0.5,
      itemTimingSkill: 0.5,
      strafeJumpSkill: 0.5,
      dodgeSkill: 0.5,
      mistakeRate: 2,
      lookAroundInterval: 4,
    });
    this._rewardComputer = new BotRewardComputer();
  }

  // ── Main Training Loop ──────────────────────────────────────────

  async train(): Promise<void> {
    this._startTime = Date.now();

    console.log("");
    console.log("╔═══════════════════════════════════════════════╗");
    console.log("║          Bot Training Gym 🧠⚡                ║");
    console.log("║       TensorFlow.js Neural Training           ║");
    console.log("╚═══════════════════════════════════════════════╝");
    console.log("");
    console.log(`[Trainer] Map: ${this._config.map}`);
    console.log(`[Trainer] Rounds: ${this._config.rounds}`);
    console.log(`[Trainer] Bots per round: ${this._config.botCount}`);
    console.log(`[Trainer] Match duration: ${this._config.matchDurationMs / 1000}s`);
    console.log(`[Trainer] Model dir: ${this._config.modelDir}`);
    console.log(`[Trainer] Checkpoint every: ${this._config.checkpointInterval} rounds`);
    console.log("");

    // Load or create models
    if (this._config.resumeTraining) {
      await this._brain.loadModels(this._config.modelDir);
      if (!this._brain.hasModels) {
        console.log("[Trainer] No existing models found, creating fresh ones");
        await this._brain.createFreshModels(this._config.learningRate);
      }
      this._brain.prepareForTraining(this._config.learningRate);
    } else {
      await this._brain.createFreshModels(this._config.learningRate);
    }

    // Resumed weights were trained, so the first round may already play them.
    // Fresh ones are random, and a random network at a coin-flip threshold
    // fires at nothing: the first round of a new run plays the state machine.
    if (this._config.resumeTraining && this._brain.hasModels) {
      await this._saveWeights(this._latestDir);
      this._playable = true;
    }
    this._botServer = new BotServer(this._config.serverPort + 100);

    // Ensure model directory exists
    fs.mkdirSync(path.resolve(this._config.modelDir), { recursive: true });

    // Training loop
    for (let round = 0; round < this._config.rounds; round++) {
      const roundStart = Date.now();
      console.log(`\n[Trainer] ═══ Round ${round + 1}/${this._config.rounds} ═══`);

      try {
        // 1. Play a match and collect episodes
        const episodes = await this._playTrainingRound();

        // 2. Compute rewards
        for (const episode of episodes) {
          this._rewardComputer.computeRewards(episode.frames);
          this._rewardComputer.normalizeRewards(episode.frames);
        }

        // 3. Train models on collected data. One episode is one bot playing one
        // match, which is a run: the aim and weapon labels are differences
        // between neighbouring frames, so two bots' frames must never meet.
        const runs = episodes.map((episode) => episode.frames);
        const allFrames = episodes.flatMap((e) => e.frames);

        // Before learning from this round, see how the weights do on it: none of
        // it has been trained on yet, so this is the held-out measure a bot reads
        if (this._roundsTrained > 0) this._measureSkill(runs);

        const { tacticalLoss, combatLoss } = await this._trainOnRuns(runs);

        // The next round's bots play what this round taught. Without this the
        // bots never played the models being trained: every round was the state
        // machine, and the network only ever learned to imitate it.
        if (allFrames.length > 0) {
          this._roundsTrained++;
          this._framesTrained += allFrames.length;
          this._frameInterval = typicalInterval(runs[0]?.map((frame) => frame.tick) ?? []) ?? this._frameInterval;
          await this._saveWeights(this._latestDir);
          this._playable = true;
        }

        // 4. Log stats
        const totalKills = episodes.reduce((s, e) => s + e.summary.kills, 0);
        const totalDeaths = episodes.reduce((s, e) => s + e.summary.deaths, 0);
        const avgReward = allFrames.length > 0 ? allFrames.reduce((s, f) => s + f.reward, 0) / allFrames.length : 0;

        const stats: RoundStats = {
          round: round + 1,
          duration: Date.now() - roundStart,
          totalFrames: allFrames.length,
          totalKills,
          totalDeaths,
          avgReward,
          tacticalLoss,
          combatLoss,
        };
        this._roundStats.push(stats);

        console.log(
          `[Trainer] Round ${round + 1}: ${allFrames.length} frames, ` +
            `K/D: ${totalKills}/${totalDeaths}, ` +
            `avgReward: ${avgReward.toFixed(4)}, ` +
            `loss: T=${tacticalLoss.toFixed(6)} C=${combatLoss.toFixed(6)}, ` +
            `${stats.duration}ms`,
        );

        // 5. Save checkpoint
        if ((round + 1) % this._config.checkpointInterval === 0) {
          await this._saveCheckpoint(round + 1);
        }
      } catch (e) {
        console.error(`[Trainer] Round ${round + 1} failed:`, e);
      }
    }

    // Final save
    await this._saveCheckpoint(this._config.rounds);
    await this._botServer?.stop();
    this._botServer = null;
    this._printSummary();
  }

  /** Where each round's weights go, for the next round's bots to play. */
  private get _latestDir(): string {
    // Its own directory: a bot prefers its difficulty's subdirectory, and the
    // trainer freezes one there at every tier boundary, so bots pointed at the
    // base would lock onto that snapshot and stop playing anything newer.
    return path.join(path.resolve(this._config.modelDir), "latest");
  }

  /** Save the weights with what they were trained on, so any bot can check them. */
  private async _saveWeights(dir: string): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    await this._brain.saveModels(dir);
    writeMetadata(dir, {
      ...describeCurrentFeatures(),
      frameIntervalTicks: this._frameInterval,
      trainedAt: new Date().toISOString(),
      matches: this._roundsTrained,
      trainFrames: this._framesTrained,
      validationFrames: 0,
      includedBots: true,
      matchIds: [],
      outputSkill: this._outputSkill,
    });
  }

  /** Score the current weights on a round they have not trained on. */
  private _measureSkill(runs: TrainingFrame[][]): void {
    const tf = getTF();
    const tactical = scoreModel(
      tf,
      this._brain.tacticalModel,
      buildCorpusPairs(runs, "tactical", TACTICAL_INPUT_SIZE).pairs,
      TACTICAL_OUTPUT_NAMES,
      TACTICAL_OUTPUT_KINDS,
    );
    const combat = scoreModel(
      tf,
      this._brain.combatModel,
      buildCorpusPairs(runs, "combat", COMBAT_INPUT_SIZE).pairs,
      COMBAT_OUTPUT_NAMES,
      COMBAT_OUTPUT_KINDS,
    );
    this._outputSkill = { ...skillByName(tactical), ...skillByName(combat) };
    const learned = Object.entries(this._outputSkill).filter(([, skill]) => skill >= LEARNED_SKILL);
    console.log(
      `[Trainer] Held-out skill of last round's weights — what the next bots act on: ${
        learned.length > 0 ? learned.map(([name, skill]) => `${name} ${skill.toFixed(2)}`).join(", ") : "nothing yet"
      }`,
    );
  }

  // ── Play Training Round ─────────────────────────────────────────

  /**
   * Play a single training round:
   * Start a game server, connect bots, play match, return episodes.
   */
  private async _playTrainingRound(): Promise<
    Array<{
      frames: TrainingFrame[];
      summary: { kills: number; deaths: number; damageDealt: number; damageTaken: number };
    }>
  > {
    resetBotNameIndex();

    // Connect bots to an external game server
    // The trainer expects a running game server on the configured port
    const serverUrl = `ws://localhost:${this._config.serverPort}`;
    const bots: Array<{ client: BotClient; recorder: BotEpisodeRecorder }> = [];
    const botServer = this._botServer;
    if (!botServer) throw new Error("[Trainer] No bot server — train() creates one before the first round");

    for (let i = 0; i < this._config.botCount; i++) {
      const botName = getNextBotName();
      const recorder = new BotEpisodeRecorder(botName, this._config.map);

      try {
        // Through the bot server, as a match's bots are made: with the map's
        // vision and navigation, which a bare client lacks — without them two
        // bots never found each other and a round had no fight in it — and,
        // from the second round, with the weights the last round trained.
        const client = await botServer.addBot(serverUrl, {
          name: botName,
          difficulty: this._config.difficulty,
          modelDir: this._playable ? this._latestDir : undefined,
          chat: false,
        });
        // Wire recorder into client so recordTick() is called each snapshot
        client.setRecorder(recorder);
        recorder.startRecording(0);
        bots.push({ client, recorder });
      } catch (e) {
        console.error(`[Trainer] Failed to connect bot ${botName}:`, e);
      }
    }

    if (bots.length < 2) {
      console.warn("[Trainer] Not enough bots connected, skipping round");
      for (const bot of bots) {
        await bot.client.disconnect();
      }
      return [];
    }

    console.log(`[Trainer] ${bots.length} bots connected, playing ${this._config.matchDurationMs / 1000}s match...`);

    // Wait for match duration
    await new Promise((r) => setTimeout(r, this._config.matchDurationMs));

    // Stop recording and disconnect
    const episodes: Array<{
      frames: TrainingFrame[];
      summary: { kills: number; deaths: number; damageDealt: number; damageTaken: number };
    }> = [];

    for (const bot of bots) {
      bot.recorder.stopRecording();
      const summary = bot.recorder.getSummary();
      episodes.push({
        frames: bot.recorder.getFrames(),
        summary: {
          kills: summary.kills,
          deaths: summary.deaths,
          damageDealt: summary.damageDealt,
          damageTaken: summary.damageTaken,
        },
      });
      await bot.client.disconnect();
    }

    return episodes;
  }

  // ── Model Training ──────────────────────────────────────────────

  /**
   * Train both models on the runs a round produced.
   *
   * The labels are the same ones a human demo produces — what the player did —
   * built by the one shared builder, so an output cannot come to mean one thing
   * in self-play and another when cloning a person. Reward decides how often a
   * frame is trained on: the best frames of a round appear most, the worst not at
   * all. It used to be folded into the target itself, which said the bot had
   * pressed a button halfway, something no player ever does.
   *
   * Returns loss values for logging.
   */
  private async _trainOnRuns(runs: TrainingFrame[][]): Promise<{
    tacticalLoss: number;
    combatLoss: number;
  }> {
    if (runs.every((run) => run.length === 0)) {
      return { tacticalLoss: 0, combatLoss: 0 };
    }

    const tactical = await this._fitHead(this._brain.tacticalModel, runs, "tactical", TACTICAL_INPUT_SIZE);
    const combat = await this._fitHead(this._brain.combatModel, runs, "combat", COMBAT_INPUT_SIZE);
    return { tacticalLoss: tactical, combatLoss: combat };
  }

  /** Fit one head on one round of play. Returns the final loss, or 0. */
  private async _fitHead(
    model: LayersModel | null,
    runs: TrainingFrame[][],
    head: "tactical" | "combat",
    inputSize: number,
  ): Promise<number> {
    if (!model) return 0;

    const { pairs: all } = buildCorpusPairs(runs, head, inputSize);
    // The round's frames, drawn as often as their reward says they deserve.
    // TensorFlow.js throws on per-sample weights, so this is how they apply.
    const weights = rewardWeights(all.map((pair: TrainingPair) => pair.reward));
    const pairs = resampleByWeight(all, weights, all.length, Math.random());
    if (pairs.length === 0) return 0;

    const tf = getTF();
    const inputTensor = tf.tensor2d(pairs.map((pair: TrainingPair) => pair.input));
    const targetTensor = tf.tensor2d(pairs.map((pair: TrainingPair) => pair.target));

    const result = await model.fit(inputTensor, targetTensor, {
      epochs: this._config.epochs,
      batchSize: this._config.batchSize,
      shuffle: true,
      verbose: 0,
    });

    inputTensor.dispose();
    targetTensor.dispose();

    return result.history.loss ? (result.history.loss[result.history.loss.length - 1] as number) : 0;
  }

  // ── Checkpoint Management ───────────────────────────────────────

  private async _saveCheckpoint(round: number): Promise<void> {
    const dir = path.resolve(this._config.modelDir);
    fs.mkdirSync(dir, { recursive: true });

    // Save current models (latest)
    await this._saveWeights(dir);

    // Save checkpoint copy
    const checkpointDir = path.join(dir, "checkpoints", `round_${round}`);
    await this._saveWeights(checkpointDir);

    // ── Difficulty Tier Snapshots ────────────────────────────────
    // When training reaches a tier boundary, save models to the
    // tier-specific directory. Running --rounds 2000 automatically
    // produces all 4 tiers (easy/medium/hard/insane).
    const tiers = getDifficultyTiers();
    for (const tier of tiers) {
      if (tier.rounds > 0 && round === tier.rounds) {
        const tierDir = path.join(dir, tier.name);
        await this._saveWeights(tierDir);
        console.log(`[Trainer] 🏆 Difficulty tier "${tier.name}" saved (round ${round}) → ${tierDir}`);
      }
    }

    // Save training stats
    const statsPath = path.join(dir, "training_stats.json");
    fs.writeFileSync(
      statsPath,
      JSON.stringify(
        {
          config: this._config,
          rounds: this._roundStats,
          lastRound: round,
          timestamp: new Date().toISOString(),
          // Record which tiers have been reached
          completedTiers: tiers.filter((t) => round >= t.rounds).map((t) => t.name),
        },
        null,
        2,
      ),
    );

    console.log(`[Trainer] 💾 Checkpoint saved: round ${round} → ${dir}`);
  }

  // ── Summary ─────────────────────────────────────────────────────

  private _printSummary(): void {
    const elapsed = (Date.now() - this._startTime) / 1000;
    const totalFrames = this._roundStats.reduce((s, r) => s + r.totalFrames, 0);
    const totalKills = this._roundStats.reduce((s, r) => s + r.totalKills, 0);
    const avgLoss =
      this._roundStats.length > 0
        ? this._roundStats.reduce((s, r) => s + r.tacticalLoss, 0) / this._roundStats.length
        : 0;

    console.log("");
    console.log("╔═══════════════════════════════════════════════╗");
    console.log("║            Training Complete! 🎉               ║");
    console.log("╚═══════════════════════════════════════════════╝");
    console.log("");
    console.log(`[Trainer] Total time: ${elapsed.toFixed(1)}s`);
    console.log(`[Trainer] Rounds: ${this._roundStats.length}`);
    console.log(`[Trainer] Total frames: ${totalFrames}`);
    console.log(`[Trainer] Total kills: ${totalKills}`);
    console.log(`[Trainer] Avg tactical loss: ${avgLoss.toFixed(6)}`);
    console.log(`[Trainer] Models saved to: ${path.resolve(this._config.modelDir)}`);
    console.log("");
  }
}
