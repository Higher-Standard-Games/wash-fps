/**
 * Bot Training CLI — bot:train
 *
 * Autonomous training script that connects bots to a running game server
 * and trains TensorFlow.js neural networks through gameplay.
 *
 * Two training modes:
 *   1. Live self-play (default): Bots play on a running server, train in-memory
 *   2. Demo training (--demo): Extract training data from .shagdemo recordings
 *
 * Usage:
 *   npx vite-node src/games/fps/cli/bot-train.ts -- --map wdm7 --rounds 100
 *   npx vite-node src/games/fps/cli/bot-train.ts -- --resume --models ./models/wdm7
 *   npx vite-node src/games/fps/cli/bot-train.ts -- --demo match.shagdemo --epochs 50
 *
 * Prerequisites (live mode):
 *   A game server must be running on the specified port (default: 17777).
 *   Start one with: npm run net:server -- --port 17777 --map wdm7
 */

import type { History, LayersModel } from "@tensorflow/tfjs-node";
import { runCli } from "../../../cli/_runCli";
import { BotTrainer, DEFAULT_TRAINER_CONFIG, type TrainerConfig } from "../bot/BotTrainer";
import type { OutputKind } from "../bot/CloningTargets";

// ── Argument Parsing ────────────────────────────────────────────────

interface CLIArgs {
  trainerConfig: Partial<TrainerConfig>;
  demoFile?: string;
  /** Train on every player in the demo, bots included. Default: people only. */
  includeBots: boolean;
  /** Epochs without improvement on held-out play before stopping. 0 to run them all. */
  patience: number;
}

/**
 * Epochs to keep going after the held-out loss stops improving.
 *
 * Past that point the network is learning the training matches rather than how
 * people play, and the weights get worse at the only thing anyone wants from
 * them. Five is loose enough to ride out a noisy epoch.
 */
const DEFAULT_PATIENCE = 5;

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const config: Partial<TrainerConfig> = {};
  let demoFile: string | undefined;
  let includeBots = false;
  let patience = DEFAULT_PATIENCE;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--map":
        config.map = args[++i];
        break;
      case "--rounds":
        config.rounds = parseInt(args[++i], 10);
        break;
      case "--bots":
        config.botCount = parseInt(args[++i], 10);
        break;
      case "--duration":
        config.matchDurationMs = parseInt(args[++i], 10) * 1000;
        break;
      case "--port":
        config.serverPort = parseInt(args[++i], 10);
        break;
      case "--models":
        config.modelDir = args[++i];
        break;
      case "--checkpoint":
        config.checkpointInterval = parseInt(args[++i], 10);
        break;
      case "--epochs":
        config.epochs = parseInt(args[++i], 10);
        break;
      case "--batch":
        config.batchSize = parseInt(args[++i], 10);
        break;
      case "--lr":
        config.learningRate = parseFloat(args[++i]);
        break;
      case "--difficulty":
        config.difficulty = args[++i];
        break;
      case "--resume":
        config.resumeTraining = true;
        break;
      case "--gametype":
        config.gametype = args[++i];
        break;
      case "--include-bots":
        includeBots = true;
        break;
      case "--patience":
        patience = parseInt(args[++i], 10);
        break;
      case "--demo":
        demoFile = args[++i];
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }

  return { trainerConfig: config, demoFile, includeBots, patience };
}

function printHelp(): void {
  const d = DEFAULT_TRAINER_CONFIG;
  console.log(`
Bot Training Gym 🧠⚡

Trains TensorFlow.js neural networks through autonomous bot gameplay
or from recorded .shagdemo files.

Usage: npx vite-node src/games/fps/cli/bot-train.ts [options]

═══════════════════════════════════════════════════════════════════
  LIVE SELF-PLAY MODE (default)
═══════════════════════════════════════════════════════════════════

  Requires a running game server on the target port.

  --map <name>       Map to train on (default: ${d.map})
  --rounds <n>       Number of training rounds (default: ${d.rounds})
  --bots <n>         Bots per round (default: ${d.botCount})
  --duration <sec>   Match duration in seconds (default: ${d.matchDurationMs / 1000})
  --port <n>         Game server port (default: ${d.serverPort})

═══════════════════════════════════════════════════════════════════
  DEMO TRAINING MODE
═══════════════════════════════════════════════════════════════════

  Extracts training data from .shagdemo recordings — no server needed.

  --demo <path>      Train from a .shagdemo file, or a directory of them.
                     A directory is read as one corpus: matches already counted
                     are skipped by match id, and whole matches are held out for
                     validation rather than random frames, which would leak.
  --include-bots     Train on every player in the demo, bots included.
                     By default only players with a verified account are used,
                     because the point is to learn from people.
  --patience <n>     Stop after N epochs without improvement on the held-out
                     matches (default: ${DEFAULT_PATIENCE}; 0 runs every epoch).
                     Needs more than one match, or there is nothing to watch.

═══════════════════════════════════════════════════════════════════
  SHARED OPTIONS
═══════════════════════════════════════════════════════════════════

  --models <dir>     Model save/load directory (default: ${d.modelDir})
  --checkpoint <n>   Save every N rounds (default: ${d.checkpointInterval})
  --epochs <n>       Training epochs per round (default: ${d.epochs})
  --batch <n>        Batch size (default: ${d.batchSize})
  --lr <n>           Learning rate (default: ${d.learningRate})
  --difficulty <lvl> Bot difficulty (default: ${d.difficulty})
  --gametype <type>  Gametype: duel, dm, tdm (default: ${d.gametype})
  --resume           Continue training from existing models
  --help, -h         Show this help

Examples:
  # Live: Start a game server, then train bots:
  npm run net:server -- --port 17777 --map wdm7
  npx vite-node src/games/fps/cli/bot-train.ts -- --map wdm7 --rounds 100

  # Demo: Train from a recorded match (no server needed):
  npx vite-node src/games/fps/cli/bot-train.ts -- --demo public/data/demos/wdm7_duel.shagdemo --epochs 50

  # Resume training with existing models:
  npx vite-node src/games/fps/cli/bot-train.ts -- --resume --models ./models/wdm7
`);
}

// ── Demo Training ───────────────────────────────────────────────────

/**
 * Frames across every run. A corpus is a list of runs and a run holds many
 * frames, so counting the outer array reports a handful where there are
 * thousands — and wrote that number into the model's provenance.
 */
function countFrames(runs: readonly { length: number }[]): number {
  return runs.reduce((sum, run) => sum + run.length, 0);
}

/** Say what the run achieved, and whether it was measured on unseen play. */
function reportLoss(label: string, result: History): void {
  const history = result?.history ?? {};
  const last = (values: unknown): number | null =>
    Array.isArray(values) && values.length > 0 ? (values[values.length - 1] as number) : null;
  const loss = last(history.loss);
  const valLoss = last(history.val_loss);
  const lossText = loss === null ? "n/a" : loss.toFixed(6);
  console.log(
    valLoss === null
      ? `[Trainer] ${label} model loss: ${lossText} (training only — no held-out matches)`
      : `[Trainer] ${label} model loss: ${lossText}, held-out: ${valLoss.toFixed(6)}`,
  );
}

async function trainFromDemo(
  demoFile: string,
  config: Partial<TrainerConfig>,
  includeBots = false,
  patience = DEFAULT_PATIENCE,
): Promise<void> {
  // Dynamic import to avoid loading TF.js unless needed
  const { buildCorpus } = await import("../bot/TrainingCorpus");
  const { writeMetadata, describeCurrentFeatures } = await import("../bot/ModelMetadata");
  const { HybridBrain } = await import("../bot/HybridBrain");
  const { getTF } = await import("../bot/TFBackend");
  const { resolveDifficulty } = await import("../bot/BotConfig");
  const { buildCorpusPairs, COMBAT_OUTPUT_KINDS, COMBAT_OUTPUT_NAMES, TACTICAL_OUTPUT_KINDS, TACTICAL_OUTPUT_NAMES } =
    await import("../bot/CloningTargets");
  const { formatScores, scoreModel, skillByName } = await import("../bot/TrainingReport");
  const { TACTICAL_INPUT_SIZE, COMBAT_INPUT_SIZE } = await import("../bot/BotInputNormalizer");
  const { intervalMismatch } = await import("../bot/ModelInputs");
  const fs = await import("node:fs");
  const path = await import("node:path");

  console.log("");
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║        Bot Training Gym 🧠⚡                  ║");
  console.log("║          Demo Training Mode                   ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log("");
  console.log(`[Trainer] Demo file: ${demoFile}`);
  console.log(`[Trainer] Model dir: ${config.modelDir || "./src/games/fps/models"}`);
  console.log("");

  // 1. Gather every recording under the target — a file, or a directory of them
  const corpus = await buildCorpus(demoFile, { includeBots });

  for (const match of corpus.matches) {
    console.log(`[Trainer]   ${path.basename(match.file)} — ${match.map}, ${match.frames} frames`);
  }
  for (const skip of corpus.skipped) {
    console.log(`[Trainer]   skipped ${path.basename(skip.file)} — ${skip.reason}`);
  }
  for (const map of corpus.blindMaps) {
    console.warn(
      `[Trainer]   ${map}: map would not load, so its matches were read without line of sight or item distances`,
    );
  }

  if (corpus.totalFrames === 0) {
    console.error("[Trainer] No training frames. A demo trains nothing unless it holds a verified player;");
    console.error("[Trainer] pass --include-bots to train on bot play instead.");
    process.exit(1);
  }

  const trainFrames = countFrames(corpus.train);
  const validationFrames = countFrames(corpus.validation);
  console.log(
    `[Trainer] ${corpus.totalFrames} frames from ${corpus.matches.length} match(es): ` +
      `${trainFrames} training, ${validationFrames} validation`,
  );
  // A stack means the same stretch of time only at the same snapshot rate, so a
  // corpus that mixes rates teaches one movement at two speeds
  const intervals = corpus.matches
    .map((match) => match.frameInterval)
    .filter((interval): interval is number => interval !== null)
    .sort((a, b) => a - b);
  const frameIntervalTicks = intervals.length > 0 ? intervals[Math.floor(intervals.length / 2)] : undefined;
  if (frameIntervalTicks !== undefined) {
    for (const match of corpus.matches) {
      const mismatch = match.frameInterval === null ? null : intervalMismatch(frameIntervalTicks, match.frameInterval);
      if (mismatch) console.warn(`[Trainer]   ${path.basename(match.file)}: ${mismatch}`);
    }
  }

  if (corpus.validation.length === 0 && corpus.matches.length < 2) {
    console.warn("[Trainer] One match means no validation set — the loss below says memorised, not learned.");
  }

  // 2. Create or load models
  const difficulty = resolveDifficulty(config.difficulty || "medium");
  const brain = new HybridBrain(difficulty);
  const modelDir = config.modelDir || "./src/games/fps/models";

  if (config.resumeTraining) {
    await brain.loadModels(modelDir);
  }
  if (!brain.hasModels) {
    await brain.createFreshModels(config.learningRate);
  }
  // Loaded or fresh, the heads train with this run's learning rate
  brain.prepareForTraining(config.learningRate);

  /** Held-out skill per output, for the bot to read how far to trust each one. */
  const outputSkill: Record<string, number> = {};

  // 3. Train on extracted data
  const epochs = config.epochs || 10;
  const batchSize = config.batchSize || 32;
  const tf = getTF();

  console.log(`[Trainer] Training on ${trainFrames} frames (${epochs} epochs, batch ${batchSize})`);

  /**
   * Fit one head on the corpus, measured against the matches held back.
   *
   * Behaviour cloning, run by run: a run is one player in one match and the
   * labels are differences, so frames from two players must never be adjacent.
   *
   * The held-out matches are passed as `validationData` rather than letting
   * Keras take a `validationSplit` off the tail of the training set. A frame
   * split leaks — frames seconds apart in one match are nearly the same frame,
   * so the network is scored on play it has effectively already seen, which is
   * the whole reason the corpus splits by match.
   */
  const fitHead = async (
    label: string,
    model: LayersModel | null,
    head: "tactical" | "combat",
    inputSize: number,
    outputNames: readonly string[],
    outputKinds: readonly OutputKind[],
  ): Promise<void> => {
    const train = buildCorpusPairs(corpus.train, head, inputSize);
    if (train.dropped > 0) {
      console.log(
        `[Trainer] ${label}: ${train.dropped} frame(s) dropped — wrong feature width, or a value that is not a number`,
      );
    }
    if (train.absent > 0) {
      console.log(`[Trainer] ${label}: ${train.absent} frame(s) had nothing for this head (no enemy to be about)`);
    }
    if (train.pairs.length === 0 || !model) {
      console.warn(`[Trainer] ${label}: nothing to train on.`);
      return;
    }

    const inputTensor = tf.tensor2d(train.pairs.map((pair) => pair.input));
    const targetTensor = tf.tensor2d(train.pairs.map((pair) => pair.target));

    const heldOut = buildCorpusPairs(corpus.validation, head, inputSize);
    const valInput = heldOut.pairs.length > 0 ? tf.tensor2d(heldOut.pairs.map((pair) => pair.input)) : null;
    const valTarget = heldOut.pairs.length > 0 ? tf.tensor2d(heldOut.pairs.map((pair) => pair.target)) : null;

    // Stopping early only makes sense against play the network has not seen. It
    // keeps the last epoch's weights rather than the best ones, which TF.js has
    // no callback for, so patience is the whole of the protection.
    const stopEarly = patience > 0 && valInput !== null;

    const result = await model.fit(inputTensor, targetTensor, {
      epochs,
      batchSize,
      shuffle: true,
      verbose: 1,
      ...(valInput && valTarget ? { validationData: [valInput, valTarget] } : {}),
      ...(stopEarly ? { callbacks: tf.callbacks.earlyStopping({ monitor: "val_loss", patience }) } : {}),
    });

    reportLoss(label, result);
    const ranFor = (result?.history?.loss as unknown[] | undefined)?.length ?? epochs;
    if (stopEarly && ranFor < epochs) {
      console.log(`[Trainer] ${label}: stopped after ${ranFor} of ${epochs} epochs — held-out loss stopped improving`);
    }

    // Per output, against the floor of ignoring the input entirely — and kept,
    // because it is what tells a bot how far to trust each output
    if (valInput && valTarget) {
      const scores = scoreModel(tf, model, heldOut.pairs, outputNames, outputKinds);
      for (const line of formatScores(label, scores)) console.log(line);
      Object.assign(outputSkill, skillByName(scores));
    }

    inputTensor.dispose();
    targetTensor.dispose();
    valInput?.dispose();
    valTarget?.dispose();
  };

  await fitHead(
    "Tactical",
    brain.tacticalModel,
    "tactical",
    TACTICAL_INPUT_SIZE,
    TACTICAL_OUTPUT_NAMES,
    TACTICAL_OUTPUT_KINDS,
  );
  await fitHead("Combat", brain.combatModel, "combat", COMBAT_INPUT_SIZE, COMBAT_OUTPUT_NAMES, COMBAT_OUTPUT_KINDS);

  // 4. Save models, and what they were trained on, and clean up
  fs.mkdirSync(path.resolve(modelDir), { recursive: true });
  await brain.saveModels(modelDir);
  writeMetadata(modelDir, {
    ...describeCurrentFeatures(),
    trainedAt: new Date().toISOString(),
    matches: corpus.matches.length,
    trainFrames,
    validationFrames,
    includedBots: includeBots,
    blindMaps: corpus.blindMaps,
    outputSkill: Object.keys(outputSkill).length > 0 ? outputSkill : undefined,
    frameIntervalTicks,
    matchIds: corpus.matches.map((match) => match.matchId).filter((id): id is string => Boolean(id)),
  });
  brain.dispose();

  console.log("");
  console.log(`[Trainer] ✅ Demo training complete!`);
  console.log(`[Trainer] Models saved to: ${modelDir}`);
  console.log(`[Trainer] Trained on ${corpus.matches.length} match(es); metadata written beside the weights.`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { trainerConfig, demoFile, includeBots, patience } = parseArgs();

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[Trainer] Interrupted — saving final checkpoint...");
    process.exit(0);
  });

  if (demoFile) {
    await trainFromDemo(demoFile, trainerConfig, includeBots, patience);
  } else {
    const trainer = new BotTrainer(trainerConfig);
    await trainer.train();
  }
}

// vite-node keeps a filesystem watcher open for as long as the process lives, so
// a finished run never drains on its own: training completed, saved its weights
// and then sat there. Every other long-running CLI here exits explicitly for the
// same reason. runCli always resolves — a failure sets the exit code — so this
// covers a failed run too, which would otherwise hang just the same.
void runCli(main).then(() => process.exit(process.exitCode ?? 0));
