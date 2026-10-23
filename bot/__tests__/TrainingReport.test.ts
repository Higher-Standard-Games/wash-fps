/**
 * A loss number on its own cannot tell you whether anything was learned.
 *
 * Most of these outputs are off most of the time, so a network that answers "no"
 * to everything scores a fine mean error. The floor — the squared error of the
 * best fixed answer, the column's mean, which is its variance — is what makes the
 * difference visible.
 *
 * TF-6 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import { describe, expect, it } from "vitest";
import {
  COMBAT_OUTPUT_NAMES,
  COMBAT_TARGET_SIZE,
  TACTICAL_OUTPUT_NAMES,
  TACTICAL_TARGET_SIZE,
} from "../CloningTargets";
import { formatScores, LEARNED_SKILL, scoreOutputs, skillOf } from "../TrainingReport";

describe("scoreOutputs", () => {
  it("scores each output on its own, not the head as a whole", () => {
    // Output 0 is answered exactly; output 1 is answered backwards
    const targets = [
      [1, 1],
      [0, 0],
      [1, 1],
      [0, 0],
    ];
    const predictions = [
      [1, 0],
      [0, 1],
      [1, 0],
      [0, 1],
    ];
    const [first, second] = scoreOutputs(["right", "wrong"], predictions, targets);
    expect(first.error).toBe(0);
    expect(second.error).toBe(1);
    // Both columns are on half the time: the best fixed answer is 0.5, off by 0.5
    expect(first.floor).toBeCloseTo(0.25, 5);
    expect(second.floor).toBeCloseTo(0.25, 5);
  });

  it("gives a rare output a floor low enough to expose a lazy network", () => {
    // On in one frame of ten: answering "never" is wrong a tenth of the time,
    // and answering "a tenth" always does slightly better — so "never" is not
    // even as good as ignoring the input sensibly
    const targets = Array.from({ length: 10 }, (_, index) => [index === 0 ? 1 : 0]);
    const lazy = Array.from({ length: 10 }, () => [0]);
    const [score] = scoreOutputs(["jump"], lazy, targets);

    expect(score.positiveRate).toBeCloseTo(0.1, 5);
    // A tenth of an error looks respectable until it is read against the floor
    expect(score.error).toBeCloseTo(0.1, 5);
    expect(score.floor).toBeCloseTo(0.09, 5);
    expect(score.error).toBeGreaterThanOrEqual(score.floor);
    expect(formatScores("Tactical", [score]).join("\n")).toContain("no better than a fixed answer");
  });

  it("credits a network that knows when a rare button is pressed, without a hard yes", () => {
    // On in one frame of ten. The network says 0.6 on that frame and 0.1 on the
    // others: it never commits, but it has plainly learned when. Scored by
    // absolute error against the median, this looked worse than answering "never"
    const targets = Array.from({ length: 10 }, (_, index) => [index === 0 ? 1 : 0]);
    const knowing = Array.from({ length: 10 }, (_, index) => [index === 0 ? 0.6 : 0.1]);
    const [score] = scoreOutputs(["jump"], knowing, targets);
    expect(score.error).toBeLessThan(score.floor);
    expect(formatScores("Tactical", [score]).join("\n")).toContain("learned");
  });

  it("does not credit a network that only learned how often, not when", () => {
    // The base rate on every frame is calibrated and useless
    const targets = Array.from({ length: 10 }, (_, index) => [index === 0 ? 1 : 0]);
    const rate = Array.from({ length: 10 }, () => [0.1]);
    const [score] = scoreOutputs(["jump"], rate, targets);
    expect(score.error).toBeCloseTo(score.floor, 10);
    expect(formatScores("Tactical", [score]).join("\n")).toContain("no better than a fixed answer");
  });

  it("does not call a hair under the floor learned", () => {
    // Half on, half off: floor 0.25. An error of 0.249 removed 0.4% of it — luck
    const targets = [[1], [0], [1], [0]];
    const nearly = [[0.5005], [0.4995], [0.5005], [0.4995]];
    const [score] = scoreOutputs(["aim yaw"], nearly, targets);
    expect(score.error).toBeLessThan(score.floor);
    expect(skillOf(score)).toBeLessThan(LEARNED_SKILL);
    expect(formatScores("Combat", [score]).join("\n")).toContain("within the noise");
  });

  it("says an output was learned only when it beat that floor", () => {
    const targets = [[1], [0], [1], [0]];
    const good = [[0.9], [0.1], [0.9], [0.1]];
    const [score] = scoreOutputs(["fire"], good, targets);
    expect(score.error).toBeLessThan(score.floor);
    expect(formatScores("Combat", [score]).join("\n")).toContain("learned");
  });

  it("refuses to score rows that do not line up", () => {
    expect(() => scoreOutputs(["a"], [[1]], [[1], [0]])).toThrow(/predictions/);
  });

  it("has nothing to say when nothing was held out", () => {
    expect(scoreOutputs(["a"], [], [])).toEqual([]);
    expect(formatScores("Tactical", []).join("")).toContain("nothing held out");
  });
});

describe("output names", () => {
  it("names every output of both heads", () => {
    expect(TACTICAL_OUTPUT_NAMES).toHaveLength(TACTICAL_TARGET_SIZE);
    expect(COMBAT_OUTPUT_NAMES).toHaveLength(COMBAT_TARGET_SIZE);
  });
});
