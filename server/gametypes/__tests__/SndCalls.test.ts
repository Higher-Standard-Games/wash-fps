import { describe, expect, it } from "vitest";
import { siteCall } from "../SndCalls";

describe("site calls in team chat", () => {
  it("reads a site from the usual ways of calling it", () => {
    for (const [line, site] of [
      ["a", "A"],
      ["B", "B"],
      ["go a", "A"],
      ["rush b!", "B"],
      ["site a", "A"],
      ["[TEAM] b now", "B"],
      ["all b", "B"],
    ] as const) {
      expect(siteCall(line)).toBe(site);
    }
  });

  it("leaves ordinary chat alone", () => {
    for (const line of ["gg", "a bit laggy", "bomb dropped at Station", "go", "abc"]) expect(siteCall(line)).toBeNull();
  });
});
