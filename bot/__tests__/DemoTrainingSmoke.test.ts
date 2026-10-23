/**
 * One real fit, on two recorded matches, with the held-out one as validation.
 *
 * Everything else in this area checks values. This checks that the tensors are
 * shapes TensorFlow will actually accept and that a training step runs to
 * completion — including `validationData`, which throws at runtime if its width
 * does not match the model's input, and which no amount of reading catches.
 *
 * Two matches, because that is the smallest corpus that has anything to hold
 * back: with one, validation is empty by design and the loss only says the
 * frames were memorised.
 *
 * TF-7 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDifficulty } from "../BotConfig";
import { TACTICAL_INPUT_SIZE } from "../BotInputNormalizer";
import { buildCorpusPairs, TACTICAL_OUTPUT_KINDS, TACTICAL_OUTPUT_NAMES } from "../CloningTargets";
import { HybridBrain } from "../HybridBrain";
import { getTF, initTF, isTFAvailable } from "../TFBackend";
import { buildCorpus } from "../TrainingCorpus";
import { scoreModel } from "../TrainingReport";
import { blind, demoTempDir, recordPlainMatch } from "./fixtures/scriptedDemo";

let demoDir: string;

beforeAll(async () => {
  await initTF();
  demoDir = demoTempDir("smoke");
  // Different frame counts, so the split has a smaller match to hold back
  await recordPlainMatch(demoDir, "match-a", 40);
  await recordPlainMatch(demoDir, "match-b", 12);
});

afterAll(() => {
  fs.rmSync(demoDir, { recursive: true, force: true });
});

describe("training on a recorded corpus", () => {
  it("holds one match back rather than splitting frames", async () => {
    const corpus = await buildCorpus(demoDir, blind);
    expect(corpus.matches).toHaveLength(2);

    const trainFrames = corpus.train.flat();
    const heldFrames = corpus.validation.flat();
    expect(trainFrames.length).toBeGreaterThan(0);
    expect(heldFrames.length).toBeGreaterThan(0);

    // The shorter match is held back, whole, and no frame is on both sides: a
    // leak would make the held-out loss a measure of memory, not of play.
    const held = new Set(heldFrames);
    expect(trainFrames.some((frame) => held.has(frame))).toBe(false);
    expect(heldFrames.length).toBeLessThan(trainFrames.length);
  });

  it("fits a head on the corpus and scores it on the match it never saw", async () => {
    if (!isTFAvailable()) return; // No TF here — the CLI reports the same

    const corpus = await buildCorpus(demoDir, blind);
    const train = buildCorpusPairs(corpus.train, "tactical", TACTICAL_INPUT_SIZE);
    const held = buildCorpusPairs(corpus.validation, "tactical", TACTICAL_INPUT_SIZE);
    expect(train.pairs.length).toBeGreaterThan(0);
    expect(held.pairs.length).toBeGreaterThan(0);
    expect(train.dropped).toBe(0);

    const brain = new HybridBrain(resolveDifficulty("medium"));
    await brain.createFreshModels();
    expect(brain.tacticalModel).not.toBeNull();

    const tf = getTF();
    const input = tf.tensor2d(train.pairs.map((pair) => pair.input));
    const target = tf.tensor2d(train.pairs.map((pair) => pair.target));
    const heldInput = tf.tensor2d(held.pairs.map((pair) => pair.input));
    const heldTarget = tf.tensor2d(held.pairs.map((pair) => pair.target));

    const result = await brain.tacticalModel?.fit(input, target, {
      epochs: 3,
      batchSize: 8,
      shuffle: true,
      verbose: 0,
      validationData: [heldInput, heldTarget],
      // The trainer stops early on the held-out loss; a wrong monitor name or a
      // missing validation set only shows up when the callback actually runs
      callbacks: tf.callbacks.earlyStopping({ monitor: "val_loss", patience: 1 }),
    });

    const loss = (result!.history.loss as number[])[0];
    const valLoss = (result!.history.val_loss as number[])[0];
    expect(Number.isFinite(loss)).toBe(true);
    expect(Number.isFinite(valLoss)).toBe(true);
    // Early stopping may cut the run short, never lengthen it
    expect((result!.history.loss as number[]).length).toBeLessThanOrEqual(3);

    // The per-output report puts logits into label space before scoring them
    const scores = scoreModel(tf, brain.tacticalModel, held.pairs, TACTICAL_OUTPUT_NAMES, TACTICAL_OUTPUT_KINDS);
    expect(scores).toHaveLength(TACTICAL_OUTPUT_NAMES.length);
    for (const score of scores) {
      expect(Number.isFinite(score.error)).toBe(true);
      expect(Number.isFinite(score.floor)).toBe(true);
    }

    input.dispose();
    target.dispose();
    heldInput.dispose();
    heldTarget.dispose();
    brain.dispose();
  });
});
