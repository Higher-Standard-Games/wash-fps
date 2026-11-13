/**
 * bot:people — measure how people play from their demos, as rules that hold on
 * every map, and write them to `config/bot-intel/people.json`
 * (bot/intel/PeopleProfile.ts). Bots read the file where they used a hand-set
 * number. Only people are measured: a player with an account and no bot name.
 * Nothing per player or per map is kept.
 *
 * Run on demand, like `bot:intel`: review what changed, then commit it.
 *
 * Usage:
 *   npm run bot:people -- <demo or folder>... [--dry-run]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runCli } from "../../../cli/_runCli";
import { DemoReader } from "../../../shared/demo/DemoReader";
import { type PeopleProfile, STACK_AGE_BUCKET, savePeopleProfile, stackQuartiles } from "../bot/intel/PeopleProfile";
import { toClientKey } from "../ClientEntityKey";
import { isBotName } from "../shared/bot/BotNames";

const TICK_RATE = 125;
/** Buckets of `stackByAge`; the last holds everything older. */
const AGE_BUCKETS = 10;

function demoFiles(inputs: string[]): string[] {
  const files: string[] = [];
  for (const input of inputs) {
    if (fs.statSync(input).isDirectory()) {
      for (const f of fs.readdirSync(input).sort()) if (f.endsWith(".shagdemo")) files.push(path.join(input, f));
    } else files.push(input);
  }
  return files;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npm run bot:people -- <demo or folder>... [--dry-run]");
    return;
  }
  const files = demoFiles(args.filter((a) => !a.startsWith("--")));
  const byAge: number[][] = [];
  let demos = 0;
  let players = 0;
  for (const file of files) {
    const reader = new DemoReader(new Uint8Array(fs.readFileSync(file)));
    const header = reader.readHeader();
    const people = new Set(
      header.players.filter((p) => p.accountId !== undefined && !isBotName(p.name)).map((p) => toClientKey(p.playerId)),
    );
    if (people.size === 0) continue;
    demos++;
    players += people.size;
    // A life starts at the first living combat_state after a dead one (or the first seen).
    const spawnTick = new Map<string, number>();
    const dead = new Map<string, boolean>();
    for (const frame of reader.readAllFrames()) {
      for (const event of frame.state.events ?? []) {
        const e = event as { type: string; entityId?: string; dead?: boolean; health?: number; armor?: number };
        if (e.type !== "combat_state" || !e.entityId || !people.has(e.entityId)) continue;
        if (e.dead) {
          dead.set(e.entityId, true);
          continue;
        }
        if (dead.get(e.entityId) !== false) {
          spawnTick.set(e.entityId, frame.tick);
          dead.set(e.entityId, false);
        }
        const age = (frame.tick - (spawnTick.get(e.entityId) ?? frame.tick)) / TICK_RATE;
        const bucket = Math.min(AGE_BUCKETS - 1, Math.floor(age / STACK_AGE_BUCKET));
        const samples = byAge[bucket] ?? [];
        byAge[bucket] = samples;
        samples.push((e.health ?? 0) + (e.armor ?? 0));
      }
    }
  }
  const profile: PeopleProfile = {
    version: 1,
    source: { demos, players },
    stackByAge: stackQuartiles(Array.from({ length: AGE_BUCKETS }, (_, i) => byAge[i])),
  };

  console.log(`bot:people — ${demos} demos with people, ${players} player slots`);
  console.log("  stack by seconds since spawn (median, middle half):");
  profile.stackByAge.forEach((q, i) => {
    const to = i === AGE_BUCKETS - 1 ? "+" : `–${(i + 1) * STACK_AGE_BUCKET}`;
    console.log(`    ${i * STACK_AGE_BUCKET}${to} s`.padEnd(14) + `${q.median} (${q.q1}–${q.q3}), ${q.n} samples`);
  });
  if (args.includes("--dry-run")) return;
  console.log(`  → ${savePeopleProfile(profile)}`);
}

void runCli(main).then(() => process.exit(process.exitCode ?? 0));
