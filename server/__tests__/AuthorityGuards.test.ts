import { describe, expect, it } from "vitest";
import { nextAckedTick, rateLimited } from "../AuthorityGuards";

describe("server authority guards", () => {
  it("ignores acked ticks from the future", () => {
    expect(nextAckedTick(10, 1000, 50)).toBe(10);
  });

  it("accepts monotonic acked ticks up to the current server tick", () => {
    expect(nextAckedTick(10, 40, 50)).toBe(40);
  });

  it("ignores duplicate or older acked ticks", () => {
    expect(nextAckedTick(10, 10, 50)).toBe(10);
    expect(nextAckedTick(10, 9, 50)).toBe(10);
  });

  it("rate-limits only after an accepted timestamp exists", () => {
    expect(rateLimited(undefined, 100, 500)).toBe(false);
    expect(rateLimited(100, 599, 500)).toBe(true);
    expect(rateLimited(100, 600, 500)).toBe(false);
  });
});
