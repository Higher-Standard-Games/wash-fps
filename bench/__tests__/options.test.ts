import { describe, expect, it } from "vitest";
import { parseArgs } from "../options";

describe("benchmark command line", () => {
  it("defaults to three runs of everything", () => {
    expect(parseArgs([])).toEqual({ runs: 3, list: false });
  });

  it("reads each option", () => {
    expect(parseArgs(["--only", "snapshot", "--runs", "5", "--out", "results", "--list"])).toEqual({
      only: "snapshot",
      runs: 5,
      out: "results",
      list: true,
    });
  });

  it("reads a comparison as a baseline followed by a candidate", () => {
    expect(parseArgs(["--compare", "before.json", "after.json"]).compare).toEqual(["before.json", "after.json"]);
  });

  it("never lets the number of runs fall below one", () => {
    expect(parseArgs(["--runs", "0"]).runs).toBe(1);
    expect(parseArgs(["--runs", "nonsense"]).runs).toBe(1);
  });

  it("ignores what it does not know", () => {
    expect(parseArgs(["--unknown", "x"])).toEqual({ runs: 3, list: false });
  });
});
