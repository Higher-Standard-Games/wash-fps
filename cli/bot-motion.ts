/**
 * bot:motion — how human bots move, measured in a headless match.
 *
 * Starts a GameServer on the map, adds bots in this process, plays, and
 * watches every command each bot sends (BotClient.observeCommands). Reports:
 *
 * - flip-backs: the brain's wanted view jumps over 60° and returns within 30°
 *   of where it was inside a second. This is the left-right-left a spectator
 *   notices; turning after a strafing enemy does not count. Grouped by brain
 *   state before, during and after.
 * - view turn rate while not firing, and how often the turn reverses.
 * - time standing still, sliding and airborne, of time alive.
 * - out of a fight, moving: how close the bot runs to walls (the gap from its
 *   hull to the nearest wall), how often wall avoidance has to steer, how
 *   fast it moves, and the map cells where it runs closest to walls most.
 * - how far the view sees out of a fight: the median sight line along the
 *   view sent (level, or 10° up over stairs), and how much of the time it
 *   ends at a wall close by.
 * - health and armor picked up per bot-minute.
 * - deaths per minute over all bots, so a change that calms the view without
 *   hurting how they fight can be told from one that stops them fighting.
 *
 * The match demo goes to a temporary folder, deleted when the run ends.
 *
 * Usage:
 *   npm run bot:motion -- --map washoi_dm2 --bots 4 --seconds 120
 *   npm run bot:motion -- --map washoi_dm1 --gametype duel --bots 2 --difficulty hard
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MatchPhase } from "@shared/server/gametype";
import { runCli } from "../../../cli/_runCli";
import type { CollisionWorld } from "../../../engine/network/systems/collision/CollisionWorld";
import { wrapAngle } from "../bot/BotAimController";
import type { BotCommandSample } from "../bot/BotClient";
import { InputButtons } from "../bot/BotConfig";
import { BotServer } from "../bot/BotServer";
import { GameServer } from "../server/GameServer";
import type { BaseGametype } from "../server/gametypes/BaseGametype";
import { Deathmatch } from "../server/gametypes/Deathmatch";
import { Duel } from "../server/gametypes/Duel";
import { loadBspCollision } from "./HeadlessMapLoader";

interface Args {
  map: string;
  bots: number;
  seconds: number;
  gametype: string;
  difficulty: string;
  port: number;
}

const DEG = 180 / Math.PI;
/** A wanted-yaw change this large between decisions is a jump. */
const JUMP = 60 / DEG;
/** Back within this of where it was counts as having flipped back. */
const BACK = 30 / DEG;
/** Seconds a flip-back may take. */
const FLIP_WINDOW = 1;
/** View turning slower than this does not count as turning, deg/s. */
const TURNING = 60 / DEG;
/** Commands this far apart mean the bot was dead in between, seconds. */
const DEATH_GAP = 1;
/** Slower than this counts as standing still, units/s. */
const STILL = 80;
/** Sight lines are measured out to this far, units. */
const SIGHT_RANGE = 1500;
/** Rays cast round the bot for its clearance, and how far. */
const CLEARANCE_RAYS = 16;
const CLEARANCE_REACH = 256;
/** Half the player hull's width: clearance is measured from its side. */
const HULL_HALF = 16;
/** Moving faster than this counts as running, units/s. */
const RUNNING = 150;
/** Map cells for the closest-to-walls list, units. */
const CELL = 128;
/** A view that ends this close is facing a wall, units. */
const WALL = 192;
/** Eye height above the origin, as the bots' own traces use. */
const EYE = 36;
/** Brain states that are not a fight, where where the bot looks is its own choice. */
const ROAMING = new Set(["HUNT", "ITEM_RUN", "RETREAT"]);

function parseArgs(): Args {
  const a: Args = { map: "washoi_dm2", bots: 4, seconds: 120, gametype: "ffa", difficulty: "medium", port: 7795 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--map":
        a.map = next();
        break;
      case "--bots":
        a.bots = Math.max(1, Number(next()) || a.bots);
        break;
      case "--seconds":
        a.seconds = Math.max(10, Number(next()) || a.seconds);
        break;
      case "--gametype":
        a.gametype = next();
        break;
      case "--difficulty":
        a.difficulty = next();
        break;
      case "--port":
        a.port = Number(next()) || a.port;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: npm run bot:motion -- [--map washoi_dm2] [--bots 4] [--seconds 120] [--gametype ffa|duel] [--difficulty medium] [--port 7795]",
        );
        process.exit(0);
    }
  }
  return a;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Sample {
  t: number;
  wanted: number;
  view: number;
  state: string;
  firing: boolean;
  speed: number;
  sliding: boolean;
  grounded: boolean;
  health: number;
  armor: number;
  /** How far the view sent sees, level, out to SIGHT_RANGE. */
  sight: number;
  /** Out of a fight and running: gap from the hull to the nearest wall; NaN otherwise. */
  clearance: number;
  steered: boolean;
  x: number;
  z: number;
}

interface Decision {
  t: number;
  wanted: number;
  state: string;
}

/** The longer of a level ray and one 10° up, so stairs ahead do not count as a wall. */
function sightLine(world: CollisionWorld, self: BotCommandSample["self"], yaw: number): number {
  const eye = { x: self.position.x, y: self.position.y + EYE, z: self.position.z };
  let best = 0;
  for (const pitch of [0, 10 / DEG]) {
    const reach = SIGHT_RANGE * Math.cos(pitch);
    const end = {
      x: eye.x + Math.sin(yaw) * reach,
      y: eye.y + SIGHT_RANGE * Math.sin(pitch),
      z: eye.z + Math.cos(yaw) * reach,
    };
    best = Math.max(best, world.trace(eye, end).fraction * SIGHT_RANGE);
  }
  return best;
}

/** Gap from the hull to the nearest wall at the bot's origin height, out to CLEARANCE_REACH. */
function clearanceAt(world: CollisionWorld, self: BotCommandSample["self"]): number {
  const p = self.position;
  let nearest = CLEARANCE_REACH;
  for (let i = 0; i < CLEARANCE_RAYS; i++) {
    const a = (i / CLEARANCE_RAYS) * Math.PI * 2;
    const end = { x: p.x + Math.sin(a) * CLEARANCE_REACH, y: p.y, z: p.z + Math.cos(a) * CLEARANCE_REACH };
    nearest = Math.min(nearest, world.trace(p, end).fraction * CLEARANCE_REACH);
  }
  return Math.max(0, nearest - HULL_HALF);
}

function record(
  world: CollisionWorld,
  samples: Sample[],
  decisions: Decision[],
  at: number,
  sample: BotCommandSample,
): void {
  const firing = (sample.decision.buttons & (InputButtons.FIRE | InputButtons.ALT_FIRE)) !== 0;
  const roaming = ROAMING.has(sample.brainState) && !sample.self.isDead;
  const speed = Math.hypot(sample.self.velocity.x, sample.self.velocity.z);
  const running = roaming && speed > RUNNING;
  samples.push({
    t: at,
    wanted: sample.decision.yaw,
    view: sample.sent.yaw,
    state: sample.brainState,
    firing,
    speed,
    sliding: sample.self.isSliding,
    grounded: sample.self.isGrounded,
    health: sample.self.health,
    armor: sample.self.armor,
    sight: roaming ? sightLine(world, sample.self, sample.sent.yaw) : Number.NaN,
    clearance: running ? clearanceAt(world, sample.self) : Number.NaN,
    steered: sample.steeredOffWall,
    x: sample.self.position.x,
    z: sample.self.position.z,
  });
  const last = decisions[decisions.length - 1];
  if (!last || last.wanted !== sample.decision.yaw || last.state !== sample.brainState) {
    decisions.push({ t: at, wanted: sample.decision.yaw, state: sample.brainState });
  }
}

interface Report {
  flips: number;
  jumps: number;
  byStates: Map<string, number>;
  turn: number;
  reversals: number;
  quietTime: number;
  /** View turning while not firing, per brain state: radians and seconds. */
  turnByState: Map<string, { turn: number; time: number }>;
  alive: number;
  still: number;
  /** Seconds standing still, per brain state. */
  stillByState: Map<string, number>;
  /** Health and armor points picked up while alive. */
  gainedPoints: number;
  sliding: number;
  airborne: number;
  deaths: number;
  /** Sight lines out of a fight, one per command. */
  sights: number[];
  /** Out of a fight and running, one per command. */
  runs: Run[];
}

interface Run {
  state: string;
  clearance: number;
  steered: boolean;
  speed: number;
  grounded: boolean;
  cell: string;
}

function analyse(samples: Sample[], decisions: Decision[], report: Report): void {
  for (let i = 1; i < decisions.length; i++) {
    const before = decisions[i - 1];
    const after = decisions[i];
    if (Math.abs(wrapAngle(after.wanted - before.wanted)) < JUMP) continue;
    report.jumps++;
    for (let j = i + 1; j < decisions.length && decisions[j].t - after.t <= FLIP_WINDOW; j++) {
      if (Math.abs(wrapAngle(decisions[j].wanted - before.wanted)) < BACK) {
        const key = `${before.state} > ${after.state} > ${decisions[j].state}`;
        report.byStates.set(key, (report.byStates.get(key) ?? 0) + 1);
        report.flips++;
        break;
      }
    }
  }

  // View turning on 48 ms windows, so the spring's step-to-step jitter is not counted.
  const window = 6;
  let lastSign = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dt = b.t - a.t;
    if (dt > DEATH_GAP) {
      report.deaths++;
      lastSign = 0;
      continue;
    }
    if (dt <= 0) continue;
    report.alive += dt;
    // Rises while alive are pickups: respawning happens across a death gap.
    report.gainedPoints += Math.max(0, b.health - a.health) + Math.max(0, b.armor - a.armor);
    if (b.speed < STILL) {
      report.still += dt;
      report.stillByState.set(b.state, (report.stillByState.get(b.state) ?? 0) + dt);
    }
    if (!Number.isNaN(b.sight)) report.sights.push(b.sight);
    if (!Number.isNaN(b.clearance)) {
      report.runs.push({
        state: b.state,
        clearance: b.clearance,
        steered: b.steered,
        speed: b.speed,
        grounded: b.grounded,
        cell: `${Math.round(b.x / CELL) * CELL},${Math.round(b.z / CELL) * CELL}`,
      });
    }
    if (b.sliding) report.sliding += dt;
    if (!b.grounded) report.airborne += dt;
    if (i % window !== 0 || i < window) continue;
    const w = samples[i - window];
    const span = b.t - w.t;
    if (span <= 0 || span > 0.2 || b.firing) {
      lastSign = 0;
      continue;
    }
    const rate = wrapAngle(b.view - w.view) / span;
    report.turn += Math.abs(rate) * span;
    report.quietTime += span;
    const byState = report.turnByState.get(b.state) ?? { turn: 0, time: 0 };
    byState.turn += Math.abs(rate) * span;
    byState.time += span;
    report.turnByState.set(b.state, byState);
    const sign = Math.abs(rate) > TURNING ? Math.sign(rate) : 0;
    if (sign && lastSign && sign !== lastSign) report.reversals++;
    if (sign) lastSign = sign;
  }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
};

const share = (rows: Run[], test: (r: Run) => boolean) =>
  `${((100 * rows.filter(test).length) / Math.max(1, rows.length)).toFixed(0)}%`;

function printRunning(runs: Run[]): void {
  const clear = median(runs.map((r) => r.clearance)).toFixed(0);
  console.log(
    `  running clear   ${clear} u from walls (median), within 8 u ${share(runs, (r) => r.clearance < 8)}, within 24 u ${share(runs, (r) => r.clearance < 24)}; wall avoidance steering ${share(runs, (r) => r.steered)}`,
  );
  const byState = [...ROAMING]
    .map((state) => [state, runs.filter((r) => r.state === state)] as const)
    .filter(([, rows]) => rows.length > 0)
    .map(([state, rows]) => `${state} ${share(rows, (r) => r.clearance < 24)}`);
  console.log(`  within 24 u by state ${byState.join(", ")}`);
  console.log(
    `  running speed   ${median(runs.map((r) => r.speed)).toFixed(0)} u/s (median), over 450 ${share(runs, (r) => r.speed > 450)}, airborne ${share(runs, (r) => !r.grounded)}`,
  );
  const cells = new Map<string, number>();
  for (const r of runs) if (r.clearance < 24) cells.set(r.cell, (cells.get(r.cell) ?? 0) + 1);
  const worst = [...cells]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cell, close]) => `${cell} ${((100 * close) / Math.max(1, runs.length)).toFixed(0)}%`);
  console.log(`  closest cells   ${worst.join(", ")} (x,z: share of running time within 24 u)`);
}

function makeGametype(name: string): BaseGametype {
  return name.toLowerCase() === "duel" ? new Duel() : new Deathmatch();
}

async function main(): Promise<void> {
  const args = parseArgs();
  const bsp = await loadBspCollision(args.map, "./game");
  if (!bsp) throw new Error(`Could not load map "${args.map}"`);
  const demoDir = await mkdtemp(join(tmpdir(), "bot-motion-"));
  process.env.SHAG_DEMO_DIR = demoDir;

  const server = new GameServer(
    {
      port: args.port,
      serverName: "bot-motion",
      mapName: args.map,
      maxClients: 16,
      tickRate: 125,
      snapshotRate: 60,
      certPath: "",
      keyPath: "",
    },
    makeGametype(args.gametype),
  );
  server.setCollisionWorld(bsp.collision);
  server.setSpawnPoints(bsp.spawnPoints, bsp.teamSpawnPoints);
  server.setMapData(bsp.entities, bsp.models);
  server.setPickupItems(bsp.pickups);
  server.setTriggerVolumes(bsp.triggers);
  server.setPickupRespawnTime(15);
  if (bsp.pvs) server.setPVSData(bsp.pvs);
  await server.start();

  const botServer = new BotServer(args.port + 100, {});
  const started = performance.now();
  const now = () => (performance.now() - started) / 1000;
  const logs: { samples: Sample[]; decisions: Decision[] }[] = [];
  const unsubscribes: (() => void)[] = [];
  for (let i = 0; i < args.bots; i++) {
    if (i > 0) await wait(400);
    const bot = await botServer.addBot(`ws://localhost:${args.port}`, { difficulty: args.difficulty });
    const log = { samples: [] as Sample[], decisions: [] as Decision[] };
    logs.push(log);
    unsubscribes.push(
      bot.observeCommands((sample) => record(bsp.collision, log.samples, log.decisions, now(), sample)),
    );
  }

  // The match's own chatter would bury the report.
  const print = console.log;
  console.log = () => {};
  try {
    await wait(2000);
    const match = server.getGametypeController().getMatchState();
    match.expireWarmup();
    for (let i = 0; i < 100 && match.phase !== MatchPhase.Active; i++) await wait(100);
    const liveAt = now();
    await wait(args.seconds * 1000);

    for (const unsubscribe of unsubscribes) unsubscribe();
    const report: Report = {
      flips: 0,
      jumps: 0,
      byStates: new Map(),
      turn: 0,
      reversals: 0,
      quietTime: 0,
      turnByState: new Map(),
      alive: 0,
      still: 0,
      stillByState: new Map(),
      gainedPoints: 0,
      sliding: 0,
      airborne: 0,
      deaths: 0,
      sights: [],
      runs: [],
    };
    // Still time per bot: one bot stuck for a minute moves the total far more than run-to-run noise.
    const stillPerBot: number[] = [];
    for (const log of logs) {
      const still = report.still;
      const alive = report.alive;
      analyse(
        log.samples.filter((s) => s.t >= liveAt),
        log.decisions.filter((d) => d.t >= liveAt),
        report,
      );
      stillPerBot.push((report.still - still) / Math.max(1e-9, report.alive - alive));
    }

    console.log = print;
    const botMinutes = (args.bots * args.seconds) / 60;
    const pct = (part: number) => `${((100 * part) / Math.max(1e-9, report.alive)).toFixed(0)}%`;
    console.log(`\nbot:motion — ${args.map} ${args.gametype}, ${args.bots} ${args.difficulty} bots, ${args.seconds}s`);
    console.log(
      `  flip-backs      ${(report.flips / botMinutes).toFixed(1)} per bot-minute (of ${(report.jumps / botMinutes).toFixed(1)} view jumps over 60°)`,
    );
    console.log(
      `  turning         ${((report.turn * DEG) / Math.max(1e-9, report.quietTime)).toFixed(0)}°/s while not firing, reversing ${((report.reversals / Math.max(1e-9, report.quietTime)) * 60).toFixed(0)} times a minute`,
    );
    const states = [...report.turnByState]
      .filter(([, v]) => v.time >= 5)
      .sort((a, b) => b[1].time - a[1].time)
      .map(([state, v]) => `${state} ${((v.turn * DEG) / v.time).toFixed(0)}°/s`);
    console.log(`  turning by state ${states.join(", ")}`);
    console.log(
      `  alive time      still ${pct(report.still)}, sliding ${pct(report.sliding)}, airborne ${pct(report.airborne)}`,
    );
    const stillStates = [...report.stillByState]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([state, time]) => `${state} ${pct(time)}`);
    console.log(`  still by state  ${stillStates.join(", ")}`);
    console.log(`  still per bot   ${stillPerBot.map((f) => `${(100 * f).toFixed(0)}%`).join(", ")}`);
    printRunning(report.runs);
    const sights = [...report.sights].sort((a, b) => a - b);
    const median = sights.length > 0 ? sights[Math.floor(sights.length / 2)] : 0;
    const walled = sights.filter((d) => d < WALL).length / Math.max(1, sights.length);
    console.log(
      `  view out of a fight  sees ${median.toFixed(0)} units (median), at a wall within ${WALL} ${(100 * walled).toFixed(0)}% of the time`,
    );
    console.log(`  picked up       ${(report.gainedPoints / botMinutes).toFixed(0)} health and armor per bot-minute`);
    console.log(`  deaths          ${(report.deaths / (args.seconds / 60)).toFixed(1)} per minute, all bots`);
    const top = [...report.byStates].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length > 0) console.log("  flip-backs by brain state (before > during > after):");
    for (const [states, count] of top) console.log(`    ${String(count).padStart(4)}  ${states}`);
  } finally {
    console.log = print;
    await botServer.removeAllBots().catch(() => 0);
    await server.stop();
    await rm(demoDir, { recursive: true, force: true });
  }
}

void runCli(main).then(() => process.exit(process.exitCode ?? 0));
