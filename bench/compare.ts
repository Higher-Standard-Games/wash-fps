/**
 * Compare two benchmark results of the same scenario.
 *
 * Refuses to compare results taken on different machines, Node versions or settings, because the
 * difference would be the machine's and not the code's. A changed checksum is reported before any
 * timing: it means behaviour changed, and a faster wrong answer is not an improvement.
 */

import type { BenchResult } from "./harness";

/** Differences smaller than this fraction of the baseline are called noise until the real spread is measured. */
export const DEFAULT_NOISE_FLOOR = 0.1;

export type Verdict = "faster" | "slower" | "same" | "behaviour-changed";

export interface Comparison {
  name: string;
  verdict: Verdict;
  /** Baseline and candidate medians, in the result's unit. */
  baseline: number;
  candidate: number;
  /** (candidate - baseline) / baseline. Negative is faster. */
  change: number;
  /** Why the verdict is what it is, in one line. */
  note: string;
}

/** Why two results cannot be compared, or null if they can. */
export function incomparable(a: BenchResult, b: BenchResult): string | null {
  if (a.name !== b.name) return `different scenarios (${a.name} and ${b.name})`;
  if (a.unit !== b.unit) return `different units (${a.unit} and ${b.unit})`;
  if (a.environment.node !== b.environment.node) {
    return `different Node versions (${a.environment.node} and ${b.environment.node})`;
  }
  if (a.environment.cpu !== b.environment.cpu || a.environment.cores !== b.environment.cores) {
    return `different machines (${a.environment.cpu} and ${b.environment.cpu})`;
  }
  const keys = new Set([...Object.keys(a.config), ...Object.keys(b.config)]);
  for (const key of keys) {
    if (a.config[key] !== b.config[key]) return `different settings (${key}: ${a.config[key]} and ${b.config[key]})`;
  }
  return null;
}

export function compareResults(
  baseline: BenchResult,
  candidate: BenchResult,
  noiseFloor = DEFAULT_NOISE_FLOOR,
): Comparison {
  const refusal = incomparable(baseline, candidate);
  if (refusal) throw new Error(`Cannot compare ${baseline.name}: ${refusal}`);

  const before = baseline.stats.median;
  const after = candidate.stats.median;
  const change = before === 0 ? 0 : (after - before) / before;
  const base = { name: baseline.name, baseline: before, candidate: after, change };

  if (baseline.checksum !== undefined && baseline.checksum !== candidate.checksum) {
    return {
      ...base,
      verdict: "behaviour-changed",
      note: `checksum ${baseline.checksum} became ${candidate.checksum}: the result is no longer the same`,
    };
  }
  if (Math.abs(change) < noiseFloor) {
    return { ...base, verdict: "same", note: `within ${Math.round(noiseFloor * 100)}% (noise)` };
  }
  return {
    ...base,
    verdict: change < 0 ? "faster" : "slower",
    note: `${change < 0 ? "" : "+"}${(change * 100).toFixed(1)}%`,
  };
}

/** One line per comparison, for the terminal. */
export function formatComparison(row: Comparison): string {
  const sign = row.change >= 0 ? "+" : "";
  return `${row.name.padEnd(32)} ${row.baseline.toFixed(2).padStart(10)} -> ${row.candidate.toFixed(2).padStart(10)}  ${sign}${(
    row.change * 100
  )
    .toFixed(1)
    .padStart(6)}%  ${row.verdict}  (${row.note})`;
}
