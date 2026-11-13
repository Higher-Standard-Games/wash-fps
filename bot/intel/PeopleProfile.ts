/**
 * How people play, as rules that hold on every map: measured from people's
 * demos by `bot:people` and checked in at `config/bot-intel/people.json`.
 *
 * Each section answers one situation the same way on any map. The bots read
 * them where they used a hand-set number; a missing file leaves those numbers
 * as they were.
 *
 * - `stackByAge`: a player's health plus armor by seconds since their spawn
 *   (quartiles per STACK_AGE_BUCKET seconds). The match read leans on it for
 *   an enemy it has not seen for a while: people pick items up out of sight.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { BASELINE_DIR } from "./IntelBaseline";

export const PEOPLE_FILE = "people.json";
/** Width of a `stackByAge` bucket, seconds. */
export const STACK_AGE_BUCKET = 10;
/** A bucket needs this many samples to be written. */
const MIN_BUCKET_SAMPLES = 200;

export interface Quartiles {
  q1: number;
  median: number;
  q3: number;
  n: number;
}

export interface PeopleProfile {
  version: 1;
  /** Demos and player lives it was measured from. */
  source: { demos: number; players: number };
  /** Index i covers seconds [i * STACK_AGE_BUCKET, (i + 1) * STACK_AGE_BUCKET); the last bucket covers the rest. */
  stackByAge: Quartiles[];
}

export function peopleProfilePath(root = process.cwd()): string {
  return path.join(root, BASELINE_DIR, PEOPLE_FILE);
}

export function savePeopleProfile(profile: PeopleProfile, root = process.cwd()): string {
  const target = peopleProfilePath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(profile, null, 2)}\n`);
  return target;
}

const cache = new Map<string, PeopleProfile | null>();

/** The checked-in profile, or null; read once per root. */
export function loadPeopleProfile(root = process.cwd()): PeopleProfile | null {
  if (cache.has(root)) return cache.get(root) ?? null;
  let profile: PeopleProfile | null = null;
  try {
    const file = JSON.parse(fs.readFileSync(peopleProfilePath(root), "utf8")) as PeopleProfile;
    if (file.version === 1 && Array.isArray(file.stackByAge)) profile = file;
  } catch {
    profile = null;
  }
  cache.set(root, profile);
  return profile;
}

/** The median stack people have `seconds` after spawning, between bucket middles; null without a profile. */
export function typicalStackAfter(profile: PeopleProfile | null, seconds: number): number | null {
  const buckets = profile?.stackByAge ?? [];
  if (buckets.length === 0) return null;
  const at = Math.max(0, seconds / STACK_AGE_BUCKET - 0.5);
  const i = Math.min(buckets.length - 1, Math.floor(at));
  const next = Math.min(buckets.length - 1, i + 1);
  const f = Math.min(1, at - i);
  return buckets[i].median + (buckets[next].median - buckets[i].median) * f;
}

/** Quartiles of each bucket's samples, stopping at the first bucket with too few. */
export function stackQuartiles(byBucket: readonly (readonly number[] | undefined)[]): Quartiles[] {
  const out: Quartiles[] = [];
  for (const samples of byBucket) {
    if (!samples || samples.length < MIN_BUCKET_SAMPLES) break;
    const sorted = [...samples].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))];
    out.push({ q1: q(0.25), median: q(0.5), q3: q(0.75), n: sorted.length });
  }
  return out;
}
