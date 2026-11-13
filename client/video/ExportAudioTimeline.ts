import { MATCH_MAX_SECONDS } from "./MovieClock";

/** Piecewise-constant rates sampled by the same fixed-step movie traversal. */
export class ExportAudioTimeline {
  private readonly points: Array<{ time: number; source: number; rate: number }> = [];

  constructor(
    samples: readonly { time: number; rate: number }[],
    readonly duration: number,
  ) {
    if (
      !samples.length ||
      samples[0].time !== 0 ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > MATCH_MAX_SECONDS
    )
      throw new Error("Invalid audio movie duration");
    let source = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      if (
        !Number.isFinite(sample.rate) ||
        !Number.isFinite(sample.time) ||
        sample.rate <= 0 ||
        sample.time < 0 ||
        sample.time >= duration ||
        (i > 0 && sample.time <= samples[i - 1].time)
      )
        throw new Error("Invalid audio movie rate schedule");
      if (i) source += (sample.time - samples[i - 1].time) * samples[i - 1].rate;
      this.points.push({ ...sample, source });
    }
  }

  private index(value: number, key: "time" | "source"): number {
    let lo = 0,
      hi = this.points.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.points[mid][key] <= value) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  sourceAt(time: number): number {
    const bounded = Math.max(0, Math.min(this.duration, time));
    const point = this.points[this.index(bounded, "time")];
    return point.source + (bounded - point.time) * point.rate;
  }

  rateAt(time: number): number {
    return this.points[this.index(time, "time")].rate;
  }

  timeAt(source: number): number {
    const bounded = Math.max(0, Math.min(this.sourceAt(this.duration), source));
    const point = this.points[this.index(bounded, "source")];
    return Math.min(this.duration, point.time + (bounded - point.source) / point.rate);
  }
}
