/**
 * Bot Inference Benchmark — bot:bench
 *
 * What the neural overlay costs per decision, and what it costs with a server's
 * worth of bots running it. Eight bots each own their own brain and their own
 * copy of the weights, so both time and memory matter.
 *
 * This measures the overlay, not a bot's whole frame: the state it decides
 * against is synthetic, so there is no BSP, no vision raycast and no navigation
 * graph in the number. That is deliberate — those costs are the state machine's
 * and are unchanged by training. What is reported is the difference training
 * makes to a decision.
 *
 * Usage:
 *   npm run bot:bench
 *   npm run bot:bench -- --bots 8 --decisions 2000
 *
 * TF-8 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import { runCli } from "../../../cli/_runCli";
import { resolveDifficulty } from "../bot/BotConfig";
import { BotGameState } from "../bot/BotGameState";
import { HybridBrain } from "../bot/HybridBrain";
import { getBackendName, getTF, initTF, isTFAvailable } from "../bot/TFBackend";

interface Args {
  bots: number;
  decisions: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let bots = 8;
  let decisions = 2000;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bots") bots = Math.max(1, parseInt(argv[++i], 10) || 8);
    if (argv[i] === "--decisions") decisions = Math.max(100, parseInt(argv[++i], 10) || 2000);
    if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: npm run bot:bench -- [--bots 8] [--decisions 2000]");
      process.exit(0);
    }
  }
  return { bots, decisions };
}

/**
 * A plausible mid-fight state: one enemy in view, at a distance where the combat
 * head runs. Combat inference only happens with an enemy, so a state without one
 * would measure the cheaper half and call it the cost.
 */
function fightingState(seed: number): BotGameState {
  const state = new BotGameState();
  state.selfEntityId = "e_self";
  state.selfPlayerId = "p_self";
  state.tick = 1000 + seed;
  state.self = {
    position: { x: seed % 64, y: 0, z: 0 },
    velocity: { x: 300, y: 0, z: 100 },
    pitch: 0.05,
    yaw: 0.4,
    health: 85,
    armor: 40,
    isDead: false,
    isGrounded: true,
    isSliding: false,
    isCrouching: false,
    currentWeapon: "electrobolt",
    weapons: ["electrobolt", "rocketlauncher", "lasergun"],
    ammo: { electrobolt: 10, rocketlauncher: 5, lasergun: 80 },
    isReloading: false,
    team: "",
  };
  state.players = [
    {
      entityId: "e_enemy",
      playerId: "p_enemy",
      position: { x: 600, y: 0, z: 200 },
      velocity: { x: -200, y: 0, z: 0 },
      isDead: false,
      team: "",
      relation: "enemy",
      distance: 632,
    },
  ];
  return state;
}

/** Wall-clock statistics over one run of decisions, in milliseconds. */
function summarise(samples: number[]): { mean: number; median: number; p95: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (share: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
  return {
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  };
}

function report(label: string, samples: number[], decisions: number): void {
  const stats = summarise(samples);
  console.log(
    `[Bench] ${label.padEnd(22)} mean ${stats.mean.toFixed(3)}ms  median ${stats.median.toFixed(3)}ms  ` +
      `p95 ${stats.p95.toFixed(3)}ms  max ${stats.max.toFixed(3)}ms  (${decisions} decisions)`,
  );
}

async function main(): Promise<void> {
  const { bots, decisions } = parseArgs();

  await initTF();
  console.log("");
  console.log(`[Bench] Backend: ${getBackendName()}${isTFAvailable() ? "" : " — no TF, overlay cannot run"}`);
  console.log(`[Bench] ${bots} bot(s), ${decisions} decisions each`);
  console.log("");

  const difficulty = resolveDifficulty("hard");
  const states = Array.from({ length: 64 }, (_, index) => fightingState(index));

  // The floor: the state machine alone, which is what a bot runs without weights
  const plain = new HybridBrain(difficulty);
  const plainSamples: number[] = [];
  for (let i = 0; i < decisions; i++) {
    const state = states[i % states.length];
    const started = performance.now();
    plain.decide(state);
    plainSamples.push(performance.now() - started);
  }
  report("state machine only", plainSamples, decisions);

  if (!isTFAvailable()) {
    console.log("[Bench] Nothing else to measure without TensorFlow.");
    return;
  }

  const tf = getTF();
  const before = tf.memory();

  // One brain per bot, each with its own weights, as a real fleet has
  const brains: HybridBrain[] = [];
  for (let i = 0; i < bots; i++) {
    const brain = new HybridBrain(difficulty);
    await brain.createFreshModels();
    brains.push(brain);
  }

  const after = tf.memory();
  const perBotBytes = (after.numBytes - before.numBytes) / bots;
  console.log(
    `[Bench] Weights in memory: ${((after.numBytes - before.numBytes) / 1024).toFixed(1)} KiB for ${bots} bot(s), ` +
      `${(perBotBytes / 1024).toFixed(1)} KiB each, ${after.numTensors - before.numTensors} tensors`,
  );

  // Warm up: the first inference through a fresh graph is not representative
  for (const brain of brains) brain.decide(states[0]);

  const overlaySamples: number[] = [];
  for (let i = 0; i < decisions; i++) {
    const state = states[i % states.length];
    const started = performance.now();
    for (const brain of brains) brain.decide(state);
    overlaySamples.push(performance.now() - started);
  }
  report(`overlay, ${bots} bot(s)`, overlaySamples, decisions);

  const perDecision = summarise(overlaySamples).mean / bots;
  const plainMean = summarise(plainSamples).mean;
  console.log(
    `[Bench] Per decision with weights: ${perDecision.toFixed(3)}ms, ` +
      `of which the network adds ${(perDecision - plainMean).toFixed(3)}ms`,
  );

  // What that means for a bot server. A bot decides when a snapshot arrives, not
  // every tick: the 125Hz input loop re-sends the last decision, so the rate that
  // matters is the server's snapshot rate. One process holds the whole fleet, so
  // the share below is of one thread's wall clock, not of a core each.
  for (const snapshotRate of [20, 30, 60]) {
    const budget = 1000 / snapshotRate;
    const share = ((perDecision * bots) / budget) * 100;
    console.log(
      `[Bench] At ${snapshotRate}Hz snapshots, ${bots} bots deciding on each: ` +
        `${(perDecision * bots).toFixed(2)}ms of a ${budget.toFixed(2)}ms interval — ${share.toFixed(1)}%`,
    );
  }

  for (const brain of brains) brain.dispose();
  plain.dispose();
  console.log("");
}

void runCli(main);
