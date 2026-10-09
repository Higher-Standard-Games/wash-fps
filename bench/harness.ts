/**
 * Benchmark harness: timing, robust statistics, and the result file.
 *
 * Plain TypeScript with no engine imports, so the statistics can be tested on their own. Design
 * and rules: docs/research/performance-and-demos.md (sections 4, 5 and 6).
 *
 * Two ways to time a function:
 *  - `measureBatch`  runs it many times per sample and reports microseconds per call. For small,
 *                    fast functions where one call is below the clock's resolution.
 *  - `measureEach`   times every call on its own, for a distribution (p95, p99). For work that is
 *                    one unit of something larger, such as a single simulation tick.
 *
 * Both report the median and the median absolute deviation (MAD) over repeats, not the mean:
 * a garbage collection or a busy neighbour makes a few samples slow, and the median ignores them.
 */

import * as os from "node:os";

export interface Stats {
  /** Number of samples the statistics are over. */
  samples: number;
  min: number;
  median: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  /** Median absolute deviation: how far a typical sample is from the median. */
  mad: number;
}

/** The value at fraction `p` (0 to 1) of an already sorted list, by linear interpolation. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const position = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** Summary statistics of a list of samples (any order). */
export function summarize(samples: readonly number[]): Stats {
  if (samples.length === 0) throw new Error("summarize needs at least one sample");
  const sorted = [...samples].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  return {
    samples: sorted.length,
    min: sorted[0],
    median,
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    mad: percentile(deviations, 0.5),
  };
}

export interface BatchOptions {
  /** Calls made and discarded first, so the JIT has warmed up. */
  warmup?: number;
  /** Calls per sample. */
  iterations?: number;
  /** Samples. The statistics are over these. */
  repeats?: number;
}

const now = (): number => performance.now();

/** Microseconds per call, over `repeats` samples of `iterations` calls each. */
export function measureBatch(fn: () => void, options: BatchOptions = {}): Stats {
  const { warmup = 200, iterations = 500, repeats = 15 } = options;
  for (let i = 0; i < warmup; i++) fn();
  const samples: number[] = [];
  for (let r = 0; r < repeats; r++) {
    const start = now();
    for (let i = 0; i < iterations; i++) fn();
    samples.push(((now() - start) * 1000) / iterations);
  }
  return summarize(samples);
}

export interface EachOptions {
  warmup?: number;
  /** Calls timed individually. */
  iterations?: number;
}

/** Microseconds for every individual call, summarised as a distribution. */
export function measureEach(fn: () => void, options: EachOptions = {}): Stats {
  const { warmup = 300, iterations = 3000 } = options;
  for (let i = 0; i < warmup; i++) fn();
  const samples: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const start = now();
    fn();
    samples[i] = (now() - start) * 1000;
  }
  return summarize(samples);
}

/** Where and on what a result was taken. Two results are only comparable if these agree. */
export interface Environment {
  node: string;
  cpu: string;
  cores: number;
  platform: string;
}

export function environment(): Environment {
  const cpus = os.cpus();
  return {
    node: process.version,
    cpu: cpus[0]?.model?.trim() ?? "unknown",
    cores: cpus.length,
    platform: `${os.platform()}-${os.arch()}`,
  };
}

export interface BenchResult {
  schema: 1;
  /** Scenario name, for example "snapshot.build". */
  name: string;
  /** What the numbers are: "us per call" or "us per tick". */
  unit: string;
  commit: string;
  startedAt: string;
  environment: Environment;
  /** The settings and fixture sizes the numbers were taken with. Must match to compare. */
  config: Record<string, number | string | boolean>;
  stats: Stats;
  /** Anything the scenario reports besides time (bytes per snapshot, entity counts). */
  extras: Record<string, number | string>;
  /** For deterministic workloads: a fingerprint of the final state. A change means behaviour changed. */
  checksum?: number | string;
}

/**
 * Combine several runs of one scenario into the one to compare: the run with the median of the
 * run medians, with `mad` replaced by the spread between runs (which says how much to trust a
 * difference) and the number of runs noted in `extras`.
 */
export function medianOfRuns(runs: readonly BenchResult[]): BenchResult {
  if (runs.length === 0) throw new Error("medianOfRuns needs at least one run");
  const sortedByMedian = [...runs].sort((a, b) => a.stats.median - b.stats.median);
  const representative = sortedByMedian[Math.floor((sortedByMedian.length - 1) / 2)];
  const betweenRuns = summarize(runs.map((run) => run.stats.median));
  return {
    ...representative,
    stats: { ...representative.stats, mad: betweenRuns.mad },
    extras: { ...representative.extras, runs: runs.length },
  };
}
