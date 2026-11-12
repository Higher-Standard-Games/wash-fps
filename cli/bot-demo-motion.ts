/**
 * bot:demo-motion — people against bots, measured from demos by the same code.
 *
 * Reads recorded matches, follows every player through every frame and
 * measures how they move and look (bot/MotionStats.ts). Players are grouped as
 * people or bots by name, so a recorded match of a person against a bot gives
 * both sides from the same map, the same rate and the same code. A demo kept by
 * `bot:motion --keep-demo` measures bots alone the same way.
 *
 * Usage:
 *   npm run bot:demo-motion -- <demo or folder>... [--per-player] [--json out.json] [--no-walls]
 *
 * Old recordings name maps as they were then; `wfdm5`, `wfdm11` and `wdm2`
 * are measured on `washoi_dm5`, `washoi_dm11` and `washoi_dm2`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runCli } from "../../../cli/_runCli";
import type { CollisionWorld } from "../../../engine/network/systems/collision/CollisionWorld";
import { type DemoFrame, DemoReader } from "../../../shared/demo/DemoReader";
import { InputButtons } from "../bot/BotConfig";
import { BotGameState, type BotSelf } from "../bot/BotGameState";
import {
  accumulateMotion,
  CALM_AFTER_FIRE,
  emptyTotals,
  type MotionSample,
  type MotionTotals,
  motionRows,
  RUNNING_SPEED,
} from "../bot/MotionStats";
import { ensureClientKey } from "../ClientEntityKey";
import { isBotName } from "../shared/bot/BotNames";
import { loadBspCollision } from "./HeadlessMapLoader";

const MAP_ALIASES: Record<string, string> = {
  wfdm5: "washoi_dm5",
  wfdm11: "washoi_dm11",
  wdm2: "washoi_dm2",
};
const CLEARANCE_RAYS = 16;
const CLEARANCE_REACH = 256;
const HULL_HALF = 16;

interface Args {
  inputs: string[];
  perPlayer: boolean;
  json: string | null;
  walls: boolean;
}

function parseArgs(): Args {
  const a: Args = { inputs: [], perPlayer: false, json: null, walls: true };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--per-player") a.perPlayer = true;
    else if (arg === "--no-walls") a.walls = false;
    else if (arg === "--json") a.json = argv[++i] ?? null;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npm run bot:demo-motion -- <demo or folder>... [--per-player] [--json out.json] [--no-walls]",
      );
      process.exit(0);
    } else if (arg !== "--") a.inputs.push(arg);
  }
  return a;
}

function demoFiles(inputs: string[]): string[] {
  const files: string[] = [];
  for (const input of inputs) {
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      for (const f of fs.readdirSync(input).sort()) if (f.endsWith(".shagdemo")) files.push(path.join(input, f));
    } else files.push(input);
  }
  return files;
}

function clearanceAt(world: CollisionWorld, p: BotSelf["position"]): number {
  let nearest = CLEARANCE_REACH;
  for (let i = 0; i < CLEARANCE_RAYS; i++) {
    const a = (i / CLEARANCE_RAYS) * Math.PI * 2;
    const end = { x: p.x + Math.sin(a) * CLEARANCE_REACH, y: p.y, z: p.z + Math.cos(a) * CLEARANCE_REACH };
    nearest = Math.min(nearest, world.trace(p, end).fraction * CLEARANCE_REACH);
  }
  return Math.max(0, nearest - HULL_HALF);
}

/** One player's samples through a demo. */
function samplesFor(
  playerId: string,
  frames: readonly DemoFrame[],
  tickRate: number,
  world: CollisionWorld | null,
): MotionSample[] {
  const state = new BotGameState();
  const wireKey = ensureClientKey(playerId);
  const samples: MotionSample[] = [];
  let lastFire = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    const player = frame.state.players.get(wireKey);
    if (!player?.entityId) continue;
    state.selfEntityId = player.entityId;
    state.selfPlayerId = wireKey;
    state.update(frame.state);
    const self = state.self;
    const t = frame.tick / tickRate;
    const input = frame.inputs.find((entry) => entry.playerId === playerId);
    const firing = input ? (input.buttons & (InputButtons.FIRE | InputButtons.ALT_FIRE)) !== 0 : false;
    if (firing) lastFire = t;
    const speed = Math.hypot(self.velocity.x, self.velocity.z);
    const running = !self.isDead && speed > RUNNING_SPEED && t - lastFire > CALM_AFTER_FIRE;
    samples.push({
      t,
      dead: self.isDead,
      yaw: input?.yaw ?? self.yaw ?? 0,
      pitch: input?.pitch ?? self.pitch ?? 0,
      firing,
      speed,
      grounded: self.isGrounded,
      sliding: self.isSliding,
      health: self.health,
      armor: self.armor,
      clearance: running && world ? clearanceAt(world, self.position) : Number.NaN,
    });
  }
  return samples;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const files = demoFiles(args.inputs);
  if (files.length === 0) throw new Error("No demos given");
  const groups = { people: emptyTotals(), bots: emptyTotals() };
  const perPlayer: { file: string; name: string; group: string; totals: MotionTotals }[] = [];
  const worlds = new Map<string, CollisionWorld | null>();
  const quiet = console.log;
  for (const file of files) {
    const reader = new DemoReader(new Uint8Array(fs.readFileSync(file)));
    const header = reader.readHeader();
    const frames = reader.readAllFrames();
    const map = MAP_ALIASES[header.map] ?? header.map;
    if (args.walls && !worlds.has(map)) {
      console.log = () => {};
      try {
        worlds.set(map, (await loadBspCollision(map, "./game"))?.collision ?? null);
      } finally {
        console.log = quiet;
      }
      if (!worlds.get(map)) console.warn(`  (no collision for ${map}: wall gaps not measured)`);
    }
    const world = worlds.get(map) ?? null;
    const hasInputs = frames.some((f) => f.inputs.length > 0);
    for (const player of header.players) {
      const group = isBotName(player.name) ? "bots" : "people";
      const totals = emptyTotals();
      console.log = () => {};
      try {
        accumulateMotion(samplesFor(player.playerId, frames, header.tickRate || 125, world), totals);
      } finally {
        console.log = quiet;
      }
      // A player who never ran (idle, spectating) says nothing about how people move.
      if (totals.runTime < 20) continue;
      merge(groups[group], totals);
      perPlayer.push({ file: path.basename(file), name: player.name, group, totals });
    }
    console.log(
      `  ${path.basename(file)}: ${map} ${header.gametype}, ${frames.length} frames${hasInputs ? "" : " (no recorded inputs: view and fire guessed)"}`,
    );
  }

  const people = motionRows(groups.people);
  const bots = motionRows(groups.bots);
  console.log(`\nbot:demo-motion — ${files.length} demos\n`);
  console.log(`  ${"measure".padEnd(36)} ${"people".padStart(9)} ${"bots".padStart(9)}`);
  for (let i = 0; i < people.length; i++) {
    console.log(`  ${people[i][0].padEnd(36)} ${people[i][1].padStart(9)} ${bots[i][1].padStart(9)}`);
  }
  if (args.perPlayer) {
    console.log("");
    for (const row of perPlayer) {
      const r = Object.fromEntries(motionRows(row.totals));
      console.log(
        `  ${row.group.padEnd(6)} ${row.name.padEnd(14)} ${row.file.padEnd(40)} speed ${r["running speed (median u/s)"]}, airborne ${r.airborne}, walls<24 ${r["running within 24 u of a wall"]}, turn ${r["turning out of a fight (°/s)"]}°/s, flicks ${r["flicks per minute"]}/min`,
      );
    }
  }
  if (args.json) {
    const out = {
      demos: files.map((f) => path.basename(f)),
      people: Object.fromEntries(people),
      bots: Object.fromEntries(bots),
    };
    fs.writeFileSync(args.json, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`\n  written ${args.json}`);
  }
}

function merge(into: MotionTotals, from: MotionTotals): void {
  for (const key of Object.keys(from) as (keyof MotionTotals)[]) {
    const value = from[key];
    if (Array.isArray(value)) (into[key] as number[]).push(...value);
    else (into[key] as number) += value as number;
  }
}

void runCli(main).then(() => process.exit(process.exitCode ?? 0));
