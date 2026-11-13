/**
 * IntelBaseline — what bots know about a map from earlier matches, checked in
 * at `config/bot-intel/<map>.json`.
 *
 * `bot:intel` distils the bot-intel database (IntelStore.ts) into it, on
 * demand, like a route library: reviewed and committed, so every bot has the
 * same floor and it changes only when a new export is committed. Generic and
 * about no one: per gametype, how fights went in each map cell, and what each
 * strategy paid for each diagnosis. Bots read the payoffs as the bandit's
 * starting estimates (Strategist.setPriors).
 *
 * The export is deterministic: the same matches give the same file.
 */

import fs from "node:fs";
import path from "node:path";
import type { IntelStore } from "./IntelStore";

export const BASELINE_DIR = path.join("config", "bot-intel");

export interface FightCell {
  cell: string;
  against: string;
  n: number;
  /** Shares of these fights the bot won and lost; the rest ended apart. */
  won: number;
  lost: number;
  dealt: number;
  taken: number;
}

export interface Payoff {
  diagnosis: string;
  strategy: string;
  n: number;
  mean: number;
}

export interface GametypeBaseline {
  matches: number;
  fights: FightCell[];
  payoffs: Payoff[];
}

export interface BaselineFile {
  version: 1;
  map: string;
  gametypes: Record<string, GametypeBaseline>;
}

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The baseline for one map from what the store holds. */
export function buildBaseline(store: IntelStore, map: string): BaselineFile {
  const gametypes: Record<string, GametypeBaseline> = {};
  for (const row of store.maps().filter((m) => m.map === map)) {
    gametypes[row.gametype] = {
      matches: row.matches,
      fights: store
        .fightsByCell(map, row.gametype)
        .map((f) => ({
          cell: f.cell,
          against: f.against,
          n: f.n,
          won: round(f.kills / f.n),
          lost: round(f.deaths / f.n),
          dealt: round(f.dealt, 1),
          taken: round(f.taken, 1),
        }))
        .sort((a, b) => b.n - a.n || a.cell.localeCompare(b.cell) || a.against.localeCompare(b.against)),
      payoffs: store
        .payoffs(map, row.gametype)
        .map((p) => ({ diagnosis: p.diagnosis, strategy: p.strategy, n: p.n, mean: round(p.mean) }))
        .sort((a, b) => a.diagnosis.localeCompare(b.diagnosis) || a.strategy.localeCompare(b.strategy)),
    };
  }
  return { version: 1, map, gametypes };
}

export function baselinePath(map: string, root = process.cwd()): string {
  return path.join(root, BASELINE_DIR, `${map}.json`);
}

export function saveBaseline(file: BaselineFile, root = process.cwd()): string {
  const target = baselinePath(file.map, root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`);
  return target;
}

/** The checked-in baseline for a map and gametype, or null. */
export function loadBaseline(map: string, gametype: string, root = process.cwd()): GametypeBaseline | null {
  try {
    const file = JSON.parse(fs.readFileSync(baselinePath(map, root), "utf8")) as BaselineFile;
    if (file.version !== 1) return null;
    return file.gametypes[gametype] ?? null;
  } catch {
    return null;
  }
}

/** Payoffs keyed "diagnosis:strategy", as the strategist takes them. */
export function payoffPriors(baseline: GametypeBaseline | null): Map<string, { n: number; mean: number }> {
  const out = new Map<string, { n: number; mean: number }>();
  for (const p of baseline?.payoffs ?? []) out.set(`${p.diagnosis}:${p.strategy}`, { n: p.n, mean: p.mean });
  return out;
}
