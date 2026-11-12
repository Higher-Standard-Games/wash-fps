/** The sign test bot:ab judges wins by. */

import { describe, expect, it } from "vitest";
import { signTest } from "../AbStats";

describe("signTest", () => {
  it("gives 1 for an even split and for no decided matches", () => {
    expect(signTest(5, 5)).toBe(1);
    expect(signTest(0, 0)).toBe(1);
  });

  it("matches the binomial tail", () => {
    // P(X >= 10 | n = 13, p = 0.5) = (286 + 78 + 13 + 1) / 8192; two-sided doubles it.
    expect(signTest(10, 3)).toBeCloseTo((2 * 378) / 8192, 9);
    expect(signTest(3, 10)).toBeCloseTo(signTest(10, 3), 12);
    expect(signTest(12, 2)).toBeLessThan(0.05);
  });
});
