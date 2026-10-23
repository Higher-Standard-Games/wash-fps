/**
 * A corpus is many matches, and the validation set is whole matches held back.
 *
 * Splitting frames at random would put seconds of the same fight on both sides
 * of the split and report a score that means nothing. TF-10 in
 * docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import { describe, expect, it } from "vitest";
import { splitByMatch } from "../TrainingCorpus";

// biome-ignore lint/suspicious/noExplicitAny: only the count matters here
const match = (n: number, tag: string): any[] => Array.from({ length: n }, (_, i) => ({ tick: i, tag }));

// biome-ignore lint/suspicious/noExplicitAny: fixture frames carry a tag the real type does not
const tagsIn = (runs: any[][]): string[] => [...new Set(runs.flat().map((f) => f.tag as string))].sort();

describe("splitByMatch", () => {
  it("holds whole matches back, never part of one", () => {
    const { train, validation } = splitByMatch([[match(100, "a")], [match(100, "b")], [match(100, "c")]], 0.34);
    // Every frame of a held-out match goes together
    for (const tag of tagsIn(validation)) {
      expect(tagsIn(train)).not.toContain(tag);
    }
    expect(validation.flat().length % 100).toBe(0);
  });

  it("keeps everything for training when there is only one match", () => {
    const { train, validation } = splitByMatch([[match(500, "solo")]], 0.2);
    expect(train.flat()).toHaveLength(500);
    expect(validation).toEqual([]);
  });

  it("never holds back every match", () => {
    const { train, validation } = splitByMatch([[match(10, "a")], [match(10, "b")]], 1);
    expect(train.flat().length).toBeGreaterThan(0);
    expect(validation.flat().length).toBeGreaterThan(0);
  });

  it("holds nothing back when asked for nothing", () => {
    const { train, validation } = splitByMatch([[match(10, "a")], [match(10, "b")]], 0);
    expect(train.flat()).toHaveLength(20);
    expect(validation).toEqual([]);
  });

  it("prefers the smaller matches, and undershoots rather than overshooting", () => {
    // 10% of 2000 is 200, and the next smallest match is 900 — holding it too
    // would make the validation set half the corpus
    const { validation } = splitByMatch([[match(1000, "big")], [match(100, "small")], [match(900, "big2")]], 0.1);
    expect(tagsIn(validation)).toEqual(["small"]);
  });

  it("holds one match back even when every match exceeds the share", () => {
    // Asking for 10% of two 1000-frame matches cannot be satisfied exactly;
    // some validation beats none
    const { train, validation } = splitByMatch([[match(1000, "a")], [match(1000, "b")]], 0.1);
    expect(validation.flat()).toHaveLength(1000);
    expect(train.flat()).toHaveLength(1000);
  });
});
