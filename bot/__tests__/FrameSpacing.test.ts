/**
 * A stack of frames only means the same stretch of time in training and in a
 * match if the frames are the same distance apart.
 *
 * TF-14 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveDifficulty } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import { HybridBrain } from "../HybridBrain";
import { intervalMismatch, typicalInterval } from "../ModelInputs";
import { describeCurrentFeatures, writeMetadata } from "../ModelMetadata";
import { initTF, isTFAvailable } from "../TFBackend";
import { buildCorpus } from "../TrainingCorpus";
import { blind, demoTempDir, recordPlainMatch } from "./fixtures/scriptedDemo";

describe("typicalInterval", () => {
  it("is the usual spacing between frames", () => {
    expect(typicalInterval([10, 12, 14, 17, 19])).toBe(2);
  });

  it("does not count a death as an interval", () => {
    // A respawn hundreds of ticks later says nothing about the snapshot rate
    expect(typicalInterval([10, 12, 14, 300, 302, 304])).toBe(2);
  });

  it("has nothing to say about fewer than two frames that follow on", () => {
    expect(typicalInterval([])).toBeNull();
    expect(typicalInterval([10])).toBeNull();
    expect(typicalInterval([10, 500])).toBeNull();
  });
});

describe("intervalMismatch", () => {
  it("lets through spacing close enough that a stack means the same thing", () => {
    expect(intervalMismatch(2, 2)).toBeNull();
    expect(intervalMismatch(4, 5)).toBeNull();
  });

  it("says which way the speed is wrong when it is not", () => {
    // Trained at 60 Hz snapshots, playing at 20 Hz: a stack spans three times as long
    expect(intervalMismatch(2, 6)).toContain("faster");
    expect(intervalMismatch(6, 2)).toContain("slower");
  });
});

describe("the spacing a corpus was recorded at", () => {
  let dir: string;
  beforeAll(async () => {
    dir = demoTempDir("spacing");
    await recordPlainMatch(dir, "match-spacing", 10);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is measured from the recorded frames", async () => {
    const corpus = await buildCorpus(dir, blind);
    // The fixture writes a frame every six ticks
    expect(corpus.matches[0].frameInterval).toBe(6);
  });
});

describe("a bot on a server with a different snapshot rate", () => {
  let dir: string;
  beforeAll(async () => {
    await initTF();
    dir = demoTempDir("spacing-models");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("says so once it has seen enough snapshots", async () => {
    if (!isTFAvailable()) return;

    // Weights trained on frames two ticks apart
    const trainer = new HybridBrain(resolveDifficulty("medium"));
    await trainer.createFreshModels();
    await trainer.saveModels(dir);
    trainer.dispose();
    writeMetadata(dir, {
      ...describeCurrentFeatures(),
      frameIntervalTicks: 2,
      trainedAt: "2026-09-24T00:00:00.000Z",
      matches: 1,
      trainFrames: 100,
      validationFrames: 0,
      includedBots: false,
      matchIds: [],
    });

    const brain = new HybridBrain(resolveDifficulty("medium"));
    expect(await brain.loadModels(dir)).toBe(true);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = new BotGameState();
    // A 20 Hz server at 125 Hz ticks: a snapshot every six ticks
    for (let index = 0; index < 80; index++) {
      state.tick = 1000 + index * 6;
      brain.decide(state);
    }
    const said = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("tick(s) apart"));
    warn.mockRestore();
    brain.dispose();

    // Once, not every decision
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("every 6");
  });

  it("stays quiet when the spacing matches", async () => {
    if (!isTFAvailable()) return;
    const brain = new HybridBrain(resolveDifficulty("medium"));
    await brain.loadModels(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = new BotGameState();
    for (let index = 0; index < 80; index++) {
      state.tick = 1000 + index * 2;
      brain.decide(state);
    }
    const said = warn.mock.calls.filter((call) => String(call[0]).includes("tick(s) apart"));
    warn.mockRestore();
    brain.dispose();
    expect(said).toHaveLength(0);
  });

  it("is kept in the metadata a real run writes", () => {
    const written = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf-8"));
    expect(written.frameIntervalTicks).toBe(2);
  });
});
