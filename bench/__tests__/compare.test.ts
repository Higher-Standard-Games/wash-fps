import { describe, expect, it } from "vitest";
import { compareResults, DEFAULT_NOISE_FLOOR, formatComparison, incomparable } from "../compare";
import { type BenchResult, environment, summarize } from "../harness";

function result(median: number, over: Partial<BenchResult> = {}): BenchResult {
  return {
    schema: 1,
    name: "snapshot.build",
    unit: "us per call",
    commit: "abc1234",
    startedAt: "2026-01-01T00:00:00Z",
    environment: { node: "v22.0.0", cpu: "Test CPU", cores: 4, platform: "linux-x64" },
    config: { players: 16 },
    stats: summarize([median]),
    extras: {},
    ...over,
  };
}

describe("refusing to compare what cannot be compared", () => {
  it("accepts two results from the same machine, Node and settings", () => {
    expect(incomparable(result(10), result(12))).toBeNull();
  });

  it("refuses different scenarios", () => {
    expect(incomparable(result(10), result(10, { name: "pickups.update" }))).toMatch(/different scenarios/);
  });

  it("refuses different units", () => {
    expect(incomparable(result(10), result(10, { unit: "us per tick" }))).toMatch(/different units/);
  });

  it("refuses different Node versions", () => {
    const other = { ...result(10).environment, node: "v20.1.0" };
    expect(incomparable(result(10), result(10, { environment: other }))).toMatch(/different Node versions/);
  });

  it("refuses different machines, by CPU model or by core count", () => {
    const cpu = { ...result(10).environment, cpu: "Other CPU" };
    const cores = { ...result(10).environment, cores: 8 };
    expect(incomparable(result(10), result(10, { environment: cpu }))).toMatch(/different machines/);
    expect(incomparable(result(10), result(10, { environment: cores }))).toMatch(/different machines/);
  });

  it("refuses different settings, in either direction", () => {
    expect(incomparable(result(10), result(10, { config: { players: 8 } }))).toMatch(/players: 16 and 8/);
    expect(incomparable(result(10), result(10, { config: { players: 16, seed: 2 } }))).toMatch(/seed/);
  });

  it("makes compareResults throw rather than return a misleading number", () => {
    expect(() => compareResults(result(10), result(10, { name: "other" }))).toThrow(/Cannot compare/);
  });
});

describe("comparing timings", () => {
  it("calls a change within the noise floor the same", () => {
    const row = compareResults(result(100), result(105));
    expect(row.verdict).toBe("same");
    expect(row.change).toBeCloseTo(0.05, 10);
  });

  it("calls a clear drop faster, with the change as a fraction of the baseline", () => {
    const row = compareResults(result(100), result(60));
    expect(row.verdict).toBe("faster");
    expect(row.change).toBeCloseTo(-0.4, 10);
  });

  it("calls a clear rise slower", () => {
    expect(compareResults(result(100), result(150)).verdict).toBe("slower");
  });

  it("treats exactly the noise floor as a real change", () => {
    expect(compareResults(result(100), result(100 * (1 + DEFAULT_NOISE_FLOOR) + 1e-9)).verdict).toBe("slower");
    expect(compareResults(result(100), result(100 * (1 + DEFAULT_NOISE_FLOOR) - 1e-9)).verdict).toBe("same");
  });

  it("takes the noise floor as a parameter", () => {
    expect(compareResults(result(100), result(105), 0.01).verdict).toBe("slower");
  });

  it("copes with a zero baseline", () => {
    expect(compareResults(result(0), result(5)).change).toBe(0);
  });
});

describe("a changed checksum outranks any timing", () => {
  it("reports behaviour changed even when the new run is faster", () => {
    const row = compareResults(result(100, { checksum: 1234 }), result(10, { checksum: 9999 }));
    expect(row.verdict).toBe("behaviour-changed");
    expect(row.note).toContain("1234");
    expect(row.note).toContain("9999");
  });

  it("is quiet when the checksums agree", () => {
    expect(compareResults(result(100, { checksum: 1 }), result(40, { checksum: 1 })).verdict).toBe("faster");
  });

  it("is not triggered when the baseline has no checksum", () => {
    expect(compareResults(result(100), result(40, { checksum: 5 })).verdict).toBe("faster");
  });
});

describe("formatting", () => {
  it("prints name, both numbers, the change and the verdict on one line", () => {
    const line = formatComparison(compareResults(result(100), result(60)));
    expect(line).toContain("snapshot.build");
    expect(line).toContain("100.00");
    expect(line).toContain("60.00");
    expect(line).toContain("-40.0%");
    expect(line).toContain("faster");
    expect(line).not.toContain("\n");
  });
});

describe("environment", () => {
  it("is what the harness stamps on a result, so a result is comparable with itself", () => {
    const same = result(10, { environment: environment() });
    expect(incomparable(same, same)).toBeNull();
  });
});
