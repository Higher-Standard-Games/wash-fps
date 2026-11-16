import { describe, expect, it } from "vitest";
import { TimeHistogram } from "../TimeHistogram";

describe("TimeHistogram", () => {
  it("reads percentiles within a bucket of the true value, and merges", () => {
    const h = new TimeHistogram();
    for (let i = 1; i <= 100; i++) h.add(i / 10); // 0.1 .. 10 ms
    expect(h.count).toBe(100);
    expect(h.percentile(0.5)).toBeGreaterThanOrEqual(5);
    expect(h.percentile(0.5)).toBeLessThan(5 * 1.2);
    expect(h.percentile(0.99)).toBeLessThanOrEqual(10);
    expect(h.max).toBe(10);
    const other = new TimeHistogram();
    other.add(40);
    h.merge(JSON.parse(JSON.stringify(other)));
    expect(h.count).toBe(101);
    expect(h.max).toBe(40);
    expect(new TimeHistogram().percentile(0.5)).toBe(0);
  });
});
