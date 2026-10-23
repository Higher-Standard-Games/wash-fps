/**
 * A bot in a match must be fed exactly what training was fed.
 *
 * Everything else about a trained model is secondary to this. The vectors were
 * built three ways at one point — the demo extractor, the self-play recorder and
 * the brain itself — and each disagreed with the others about something: which
 * enemy the combat vector was about, whether the map was consulted, and, once
 * inputs were stacked, whether a respawn joined on to the moment of death.
 *
 * This walks a `HybridBrain` through the same recorded match the training
 * pipeline reads, frame by frame the way a bot receives snapshots, and compares
 * the stack it would feed each network with the training input for that frame.
 *
 * TF-11 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toClientKey } from "../../ClientEntityKey";
import { InputButtons, resolveDifficulty } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import { COMBAT_INPUT_SIZE, TACTICAL_INPUT_SIZE } from "../BotInputNormalizer";
import { buildCorpusPairs } from "../CloningTargets";
import { DemoTrainingExtractor } from "../DemoTrainingExtractor";
import { HybridBrain } from "../HybridBrain";
import { initTF, isTFAvailable } from "../TFBackend";
import { buildCorpus } from "../TrainingCorpus";
import { BOT, blind, demoTempDir, HUMAN, human, scriptedRecorder, snapshot } from "./fixtures/scriptedDemo";

let dir: string;
let file: string;

beforeAll(async () => {
  await initTF();
  dir = demoTempDir("parity");
  const recorder = scriptedRecorder(dir, "parity-match");

  // Alive and turning, then dead for a stretch, then alive again elsewhere
  const alive = [6, 12, 18, 24, 30];
  alive.forEach((tick, index) => {
    recorder.recordInput(HUMAN.playerId, {
      buttons: InputButtons.FORWARD,
      yaw: 0.1 * index,
      pitch: 0,
      forward: 1,
      right: 0,
      weaponSlot: 2,
    });
    recorder.recordFrame(snapshot(tick, [human(0.1 * index, 100 - index * 10), BOT]));
  });
  for (let tick = 36; tick <= 120; tick += 6) recorder.recordFrame(snapshot(tick, [human(0.4, 0, true), BOT]));
  for (const tick of [126, 132, 138]) {
    recorder.recordInput(HUMAN.playerId, { buttons: 0, yaw: 2, pitch: 0, forward: 0, right: 0, weaponSlot: 1 });
    recorder.recordFrame(snapshot(tick, [human(2, 100), BOT]));
  }
  file = await recorder.stop();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("training and a bot in a match", () => {
  it("feed each network the same stacked vector, frame for frame", async () => {
    if (!isTFAvailable()) return; // decide() only builds stacks when a model is loaded

    // What training builds
    const corpus = await buildCorpus(dir, blind);
    const run = corpus.train[0];
    const tactical = buildCorpusPairs(corpus.train, "tactical", TACTICAL_INPUT_SIZE).pairs;
    const combat = buildCorpusPairs(corpus.train, "combat", COMBAT_INPUT_SIZE).pairs;
    const trainingTactical = new Map(run.map((frame, index) => [frame.tick, tactical[index].input]));
    const trainingCombat = new Map(run.map((frame, index) => [frame.tick, combat[index].input]));

    // What a bot is fed, receiving the same snapshots in the same order. A bot is
    // not asked to decide while it is dead, so neither is this one.
    const brain = new HybridBrain(resolveDifficulty("medium"));
    await brain.createFreshModels();
    const state = new BotGameState();
    const { frames } = DemoTrainingExtractor.decode(new Uint8Array(fs.readFileSync(file)));

    let compared = 0;
    for (const frame of frames) {
      // A bot knows itself by the keys the server's join accept gives it
      const self = toClientKey(HUMAN.playerId);
      const entityId = frame.state.players.get(self)?.entityId;
      if (!entityId) continue;
      state.selfEntityId = entityId;
      state.selfPlayerId = self;
      state.update(frame.state);
      if (state.self.isDead) continue;

      brain.decide(state);
      const fed = brain.lastInputs;
      expect(fed.tactical, `tactical stack at tick ${frame.tick}`).toEqual(trainingTactical.get(frame.tick));
      expect(fed.combat, `combat stack at tick ${frame.tick}`).toEqual(trainingCombat.get(frame.tick));
      compared++;
    }

    // Every living frame on both sides — five before the death, three after
    expect(compared).toBe(8);
    brain.dispose();
  });
});
