/**
 * Motion measures for people and bots: flicks and their corrections, hop
 * chains, and what counts as out of a fight.
 */

import { describe, expect, it } from "vitest";
import { accumulateMotion, emptyTotals, type MotionSample } from "../MotionStats";

const DEG = Math.PI / 180;
const STEP = 1 / 60;

function sample(t: number, over: Partial<MotionSample> = {}): MotionSample {
  return {
    t,
    dead: false,
    yaw: 0,
    pitch: 0,
    firing: false,
    speed: 300,
    grounded: true,
    sliding: false,
    health: 100,
    armor: 0,
    clearance: Number.NaN,
    ...over,
  };
}

/** `seconds` of samples whose yaw follows `yawAt(t)`. */
function run(seconds: number, yawAt: (t: number) => number, over: Partial<MotionSample> = {}): MotionSample[] {
  const out: MotionSample[] = [];
  for (let t = 0; t <= seconds; t += STEP) out.push(sample(t, { yaw: yawAt(t), ...over }));
  return out;
}

describe("MotionStats", () => {
  it("counts a fast 90° turn as one flick, without a correction", () => {
    const totals = emptyTotals();
    accumulateMotion(
      run(3, (t) => (t < 1 ? 0 : t < 1.2 ? (90 * DEG * (t - 1)) / 0.2 : 90 * DEG)),
      totals,
    );
    expect(totals.flicks).toBe(1);
    expect(totals.overshoots).toBe(0);
    expect(totals.flickSizes[0]).toBeGreaterThan(70);
  });

  it("counts a flick that turns back a little afterwards as an overshoot", () => {
    const totals = emptyTotals();
    accumulateMotion(
      run(3, (t) => {
        if (t < 1) return 0;
        if (t < 1.2) return (100 * DEG * (t - 1)) / 0.2;
        if (t < 1.35) return 100 * DEG - (10 * DEG * (t - 1.2)) / 0.15;
        return 90 * DEG;
      }),
      totals,
    );
    expect(totals.flicks).toBe(1);
    expect(totals.overshoots).toBe(1);
  });

  it("does not measure the view while firing or for a second after", () => {
    const totals = emptyTotals();
    const samples = run(3, (t) => t * 4, {});
    for (const s of samples) if (s.t < 1.5) s.firing = true;
    accumulateMotion(samples, totals);
    // Only the last half second is out of a fight.
    expect(totals.calmTime).toBeLessThan(0.6);
    expect(totals.calmTime).toBeGreaterThan(0.3);
  });

  it("tells a hop chain from separate jumps", () => {
    const totals = emptyTotals();
    const samples: MotionSample[] = [];
    // Air 0.5 s, ground 0.1 s, air again: chained. Then ground 1 s, air: not chained.
    const air = (t: number) => (t >= 0.2 && t < 0.7) || (t >= 0.8 && t < 1.3) || t >= 2.3;
    for (let t = 0; t <= 3; t += STEP) samples.push(sample(t, { grounded: !air(t) }));
    accumulateMotion(samples, totals);
    expect(totals.takeoffs).toBe(3);
    expect(totals.chainedTakeoffs).toBe(1);
  });

  it("counts a death and skips the time dead", () => {
    const totals = emptyTotals();
    const samples = run(2, () => 0);
    for (const s of samples) if (s.t > 1) s.dead = true;
    accumulateMotion(samples, totals);
    expect(totals.deaths).toBe(1);
    expect(totals.alive).toBeLessThan(1.05);
  });
});
