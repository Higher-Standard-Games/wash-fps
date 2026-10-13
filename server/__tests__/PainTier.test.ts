import { describe, expect, it } from "vitest";
import { painTier } from "../SnapshotBuilder";

describe("pain tier", () => {
  it("follows Warsow's thresholds on the health left", () => {
    expect([1, 20, 21, 35, 36, 60, 61, 100, 200].map(painTier)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 3]);
  });
});
