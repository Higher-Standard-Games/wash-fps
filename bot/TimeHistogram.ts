/**
 * Durations in fixed buckets, a quarter octave wide from 1 µs: cheap enough to
 * record every bot snapshot, and small enough to send from a `bot:ab` worker.
 * A percentile is read as its bucket's upper edge, within 19% of the time.
 */

const BUCKETS = 4 * 24; // up to 2^24 µs, about 17 s

export interface TimeHistogramData {
  counts: number[];
  maxMs: number;
}

export class TimeHistogram {
  private counts = new Array<number>(BUCKETS).fill(0);
  private total = 0;
  private maxMs = 0;

  add(ms: number): void {
    const us = Math.max(1, ms * 1000);
    const bucket = Math.min(BUCKETS - 1, Math.floor(Math.log2(us) * 4));
    this.counts[bucket]++;
    this.total++;
    if (ms > this.maxMs) this.maxMs = ms;
  }

  get count(): number {
    return this.total;
  }

  get max(): number {
    return this.maxMs;
  }

  /** The duration `p` (0–1) of the recorded ones are at or under, in ms; 0 when none. */
  percentile(p: number): number {
    if (this.total === 0) return 0;
    const rank = Math.max(1, Math.ceil(p * this.total));
    let seen = 0;
    for (let bucket = 0; bucket < BUCKETS; bucket++) {
      seen += this.counts[bucket];
      if (seen >= rank) return Math.min(this.maxMs, 2 ** ((bucket + 1) / 4) / 1000);
    }
    return this.maxMs;
  }

  merge(other: TimeHistogram | TimeHistogramData): void {
    const counts = other instanceof TimeHistogram ? other.counts : other.counts;
    for (let bucket = 0; bucket < BUCKETS; bucket++) {
      const n = counts[bucket] ?? 0;
      this.counts[bucket] += n;
      this.total += n;
    }
    this.maxMs = Math.max(this.maxMs, other instanceof TimeHistogram ? other.maxMs : other.maxMs);
  }

  toJSON(): TimeHistogramData {
    return { counts: [...this.counts], maxMs: this.maxMs };
  }

  /** "p50 0.31 ms, p95 1.2 ms, p99 3.4 ms, max 41 ms (12,345)" */
  summary(): string {
    const ms = (v: number) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2));
    return `p50 ${ms(this.percentile(0.5))} ms, p95 ${ms(this.percentile(0.95))} ms, p99 ${ms(this.percentile(0.99))} ms, max ${ms(this.maxMs)} ms (${this.total.toLocaleString("en-US")})`;
  }
}

/** What a bot's snapshots cost: the whole handling, and its decision within it. */
export interface BotTimings {
  snapshot: TimeHistogram;
  decide: TimeHistogram;
}
