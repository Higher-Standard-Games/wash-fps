import { describe, expect, it } from "vitest";
import { cleanClientText, nextAckedTick, rateLimited } from "../AuthorityGuards";

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

describe("cleaning client text", () => {
  it("turns control characters into spaces, collapses runs and trims", () => {
    expect(cleanClientText("  a\n\tb\u007f  c  ", 128)).toBe("a b c");
  });

  it("caps the result", () => {
    expect(cleanClientText("x".repeat(500), 32)).toBe("x".repeat(32));
  });

  it("keeps the text after a run of spaces when it fits the cap", () => {
    expect(cleanClientText(`${" ".repeat(60)}hello`, 32)).toBe("hello");
  });

  it("works on a bounded slice of a huge input", () => {
    expect(cleanClientText("y".repeat(60_000), 16)).toBe("y".repeat(16));
  });

  it("keeps characters outside ASCII", () => {
    expect(cleanClientText("Mäkelä 日本", 32)).toBe("Mäkelä 日本");
  });
});
