import { describe, expect, it } from "vitest";
import { calibrateAccuracy, runAccuracyTrial } from "../Calibrate";

describe("Calibrate — anti-cheat accuracy calibration (WO-AC3)", () => {
  it("runAccuracyTrial is deterministic (seeded)", () => {
    const a = runAccuracyTrial(5, 6, 400);
    const b = runAccuracyTrial(5, 6, 400);
    expect(a).toEqual(b);
    expect(a.shots).toBeGreaterThan(20); // enough shots for a meaningful ratio
  });

  it("a low-noise aimbot scores far higher accuracy than a high-noise human", () => {
    const aimbot = runAccuracyTrial(100001, 0.4, 800).accuracy;
    const human = runAccuracyTrial(1, 6, 800).accuracy;
    expect(aimbot).toBeGreaterThan(0.9);
    expect(human).toBeLessThan(0.7);
    expect(aimbot).toBeGreaterThan(human);
  });

  it("finds a threshold with high detection and low false positives", () => {
    const { rows, aimbotAccuracies, humanAccuracies } = calibrateAccuracy({ trials: 8, ticks: 800 });
    expect(aimbotAccuracies).toHaveLength(8);
    expect(humanAccuracies).toHaveLength(8);

    const t80 = rows.find((r) => r.threshold === 0.8)!;
    expect(t80.detectionRate).toBeGreaterThan(0.9); // catches the aimbots
    expect(t80.falsePositiveRate).toBeLessThan(0.1); // spares the humans
  });

  it("false-positive rate is monotonically non-increasing as the threshold rises", () => {
    const { rows } = calibrateAccuracy({ trials: 6, ticks: 600 });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].falsePositiveRate).toBeLessThanOrEqual(rows[i - 1].falsePositiveRate + 1e-9);
    }
  });
});
