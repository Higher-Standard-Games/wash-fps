import { describe, expect, it } from "vitest";
import {
  type BenchResult,
  environment,
  measureBatch,
  measureEach,
  medianOfRuns,
  percentile,
  summarize,
} from "../harness";

describe("percentile", () => {
  const sorted = [10, 20, 30, 40, 50];

  it("picks the ends and the middle", () => {
    expect(percentile(sorted, 0)).toBe(10);
    expect(percentile(sorted, 0.5)).toBe(30);
    expect(percentile(sorted, 1)).toBe(50);
  });

  it("interpolates between neighbours", () => {
    expect(percentile(sorted, 0.125)).toBe(15);
    expect(percentile([0, 100], 0.95)).toBeCloseTo(95, 10);
  });

  it("handles a single value, an empty list, and out-of-range fractions", () => {
    expect(percentile([7], 0.99)).toBe(7);
    expect(percentile([], 0.5)).toBeNaN();
    expect(percentile(sorted, -1)).toBe(10);
    expect(percentile(sorted, 2)).toBe(50);
  });
});

describe("summarize", () => {
  it("reports the order statistics of unsorted input", () => {
    const stats = summarize([5, 1, 3, 2, 4]);
    expect(stats).toMatchObject({ samples: 5, min: 1, median: 3, max: 5, mean: 3 });
  });

  it("takes the median of an even count as the middle pair's average", () => {
    expect(summarize([1, 2, 3, 4]).median).toBe(2.5);
  });

  it("measures spread as the median absolute deviation, which ignores one wild sample", () => {
    const steady = summarize([100, 101, 99, 100, 100]);
    const withSpike = summarize([100, 101, 99, 100, 5000]);
    expect(steady.mad).toBe(0); // deviations 1,0,0,0,1: the middle one is 0
    expect(withSpike.median).toBe(100);
    expect(withSpike.mad).toBe(1); // deviations 1,0,0,1,4900: the middle one is 1
    expect(withSpike.mean).toBeGreaterThan(1000); // while the mean was dragged up by the one spike
  });

  it("puts the 99th percentile near the top and does not mutate its input", () => {
    const input = Array.from({ length: 100 }, (_, i) => 100 - i);
    const copy = [...input];
    const stats = summarize(input);
    expect(stats.p99).toBeCloseTo(99.01, 2);
    expect(stats.p95).toBeCloseTo(95.05, 2);
    expect(input).toEqual(copy);
  });

  it("refuses to summarize nothing", () => {
    expect(() => summarize([])).toThrow(/at least one sample/);
  });
});

describe("measureBatch", () => {
  it("calls the function warmup + iterations * repeats times and reports one sample per repeat", () => {
    let calls = 0;
    const stats = measureBatch(
      () => {
        calls++;
      },
      { warmup: 7, iterations: 11, repeats: 5 },
    );
    expect(calls).toBe(7 + 11 * 5);
    expect(stats.samples).toBe(5);
  });

  it("reports microseconds per call: a 2 ms busy-wait reads about 2000", () => {
    const stats = measureBatch(
      () => {
        const end = performance.now() + 2;
        while (performance.now() < end) {
          /* spin */
        }
      },
      { warmup: 1, iterations: 3, repeats: 3 },
    );
    expect(stats.median).toBeGreaterThan(1900);
    expect(stats.median).toBeLessThan(4000);
  });
});

describe("measureEach", () => {
  it("times every call separately", () => {
    let calls = 0;
    const stats = measureEach(
      () => {
        calls++;
      },
      { warmup: 4, iterations: 25 },
    );
    expect(calls).toBe(29);
    expect(stats.samples).toBe(25);
    expect(stats.p99).toBeGreaterThanOrEqual(stats.median);
  });

  it("shows a rare slow call in the tail, not the median", () => {
    let call = 0;
    const stats = measureEach(
      () => {
        if (++call % 50 === 0) {
          const end = performance.now() + 1;
          while (performance.now() < end) {
            /* spin */
          }
        }
      },
      { warmup: 0, iterations: 500 },
    );
    expect(stats.median).toBeLessThan(200);
    expect(stats.max).toBeGreaterThan(900);
  });
});

function result(median: number, over: Partial<BenchResult> = {}): BenchResult {
  const stats = summarize([median]);
  return {
    schema: 1,
    name: "scenario",
    unit: "us per call",
    commit: "abc",
    startedAt: "2026-01-01T00:00:00Z",
    environment: environment(),
    config: {},
    stats,
    extras: {},
    ...over,
  };
}

describe("medianOfRuns", () => {
  it("reports the run with the median median, and the spread between runs", () => {
    const combined = medianOfRuns([result(300), result(100), result(200), result(900), result(150)]);
    // Run medians sorted: 100, 150, 200, 300, 900. The middle one is 200.
    expect(combined.stats.median).toBe(200);
    // Their distances from 200 are 100, 50, 0, 100, 700; sorted, the middle one is 100.
    expect(combined.stats.mad).toBe(100);
    expect(combined.extras.runs).toBe(5);
  });

  it("returns a single run unchanged apart from the run count", () => {
    const only = result(42, { extras: { bytes: 10 } });
    const combined = medianOfRuns([only]);
    expect(combined.stats.median).toBe(42);
    expect(combined.extras).toEqual({ bytes: 10, runs: 1 });
  });

  it("refuses an empty list", () => {
    expect(() => medianOfRuns([])).toThrow();
  });
});

describe("environment", () => {
  it("names the machine so results can be told apart", () => {
    const env = environment();
    expect(env.node).toMatch(/^v\d+/);
    expect(env.cores).toBeGreaterThan(0);
    expect(env.cpu.length).toBeGreaterThan(0);
    expect(env.platform).toContain("-");
  });
});
