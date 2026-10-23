/**
 * The whole pipeline over one scripted match: record, read, extract, label.
 *
 * Every other test in this area covers one link. This one records a real
 * `.shagdemo` with the server's own recorder, reads it back through the corpus
 * builder, and checks the labels that come out the far end — which is where the
 * bugs have actually been. Both boundary defects found by reading the code (a
 * label crossing between players, a label crossing a death gap) fail here, and
 * nothing about this test needs a person to play a match.
 *
 * The scripted player holds still — zero velocity in every snapshot — while the
 * recorded commands say otherwise. Anything that leaked in from motion-based
 * inference therefore shows up as a label that disagrees with the script.
 *
 * TF-7 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InputButtons } from "../BotConfig";
import type { TrainingFrame } from "../BotEpisodeRecorder";
import { COMBAT_INPUT_SIZE, TACTICAL_INPUT_SIZE } from "../BotInputNormalizer";
import {
  buildCorpusPairs,
  COMBAT_TARGET_SIZE,
  encodeAimTurn,
  TACTICAL_TARGET_SIZE,
  type TrainingPair,
} from "../CloningTargets";
import { DemoTrainingExtractor } from "../DemoTrainingExtractor";
import { COMBAT_OUTPUT_SIZE, TACTICAL_OUTPUT_SIZE } from "../HybridBrain";
import { FRAME_STACK, TACTICAL_MODEL_INPUT } from "../ModelInputs";
import { buildCorpus } from "../TrainingCorpus";
import { BOT, blind, demoTempDir, HUMAN, human, scriptedRecorder, snapshot } from "./fixtures/scriptedDemo";

/** Ticks the script writes a snapshot at, and which of them survive. */
const ALIVE = [6, 12, 18, 24];
const DIED = 30;
const RESPAWNED = 126;
const KEPT = [...ALIVE, DIED, RESPAWNED];

let demoDir: string;
let demoFile: string;

beforeAll(async () => {
  demoDir = demoTempDir("pipeline");
  const recorder = scriptedRecorder(demoDir, "scripted-match");

  // t6: walking forward with slot 2 out
  recorder.recordInput(HUMAN.playerId, {
    buttons: InputButtons.FORWARD,
    yaw: 0,
    pitch: 0,
    forward: 1,
    right: 0,
    weaponSlot: 2,
  });
  recorder.recordFrame(snapshot(6, [human(0), BOT]));

  // t12: a 0.2 rad turn, and a jump the fixture's velocity cannot account for
  recorder.recordInput(HUMAN.playerId, {
    buttons: InputButtons.FORWARD | InputButtons.JUMP,
    yaw: 0.2,
    pitch: 0,
    forward: 1,
    right: 0,
    weaponSlot: 2,
  });
  recorder.recordFrame(snapshot(12, [human(0.2), BOT]));

  // t18: no command at all — the player pressed nothing over this interval
  recorder.recordFrame(snapshot(18, [human(0.25), BOT]));

  // t24: pressing forward again, still holding slot 2
  recorder.recordInput(HUMAN.playerId, {
    buttons: InputButtons.FORWARD,
    yaw: 0.3,
    pitch: 0,
    forward: 1,
    right: 0,
    weaponSlot: 2,
  });
  recorder.recordFrame(snapshot(24, [human(0.3), BOT]));

  // t30: dead. The death frame itself is kept; the ones after it are not.
  recorder.recordFrame(snapshot(DIED, [human(0.3, 0, true), BOT]));
  for (let tick = 36; tick < RESPAWNED; tick += 6) {
    recorder.recordFrame(snapshot(tick, [human(0.3, 0, true), BOT]));
  }

  // t126: respawned facing somewhere else entirely, with another weapon
  recorder.recordInput(HUMAN.playerId, {
    buttons: InputButtons.FORWARD,
    yaw: 2.5,
    pitch: 0,
    forward: 1,
    right: 0,
    weaponSlot: 7,
  });
  recorder.recordFrame(snapshot(RESPAWNED, [human(2.5), BOT]));

  demoFile = await recorder.stop();
  expect(demoFile).not.toBe("");
});

afterAll(() => {
  fs.rmSync(demoDir, { recursive: true, force: true });
});

describe("a recorded match, all the way to training labels", () => {
  it("keeps the person and drops the bot, by verified account", async () => {
    const dataset = await new DemoTrainingExtractor().extractFromFile(demoFile);
    expect(dataset.header.version).toBe(6);
    expect(dataset.header.private).toBe(false);
    expect(dataset.players.map((player) => player.name)).toEqual(["Person"]);

    const both = await new DemoTrainingExtractor().extractFromFile(demoFile, { includeBots: true });
    expect(both.players).toHaveLength(2);
  });

  it("skips the frames the player spent dead, keeping the death itself", async () => {
    const dataset = await new DemoTrainingExtractor().extractFromFile(demoFile);
    const frames = dataset.players[0].frames;
    expect(frames.map((frame) => frame.tick)).toEqual(KEPT);
    expect(frames[4].events.death).toBe(true);
  });

  it("takes the action from the recorded command, and no command means nothing pressed", async () => {
    const dataset = await new DemoTrainingExtractor().extractFromFile(demoFile);
    const frames = dataset.players[0].frames;

    // t12: the jump is in the label although the body never left the ground
    expect(frames[1].action.buttons & InputButtons.JUMP).toBeTruthy();
    expect(frames[1].action.directionZ).toBeCloseTo(1, 5);

    // t18: silence reads as silence, not as whatever the motion suggested
    expect(frames[2].action.buttons).toBe(0);
    expect(frames[2].action.directionZ).toBe(0);
    // …but the weapon they were holding is still in their hands
    expect(frames[2].action.weaponSlot).toBe(2);
  });

  it("builds every label the network is trained on from that one match", async () => {
    const corpus = await buildCorpus(demoDir, blind);
    expect(corpus.matches).toHaveLength(1);
    expect(corpus.matches[0].matchId).toBe("scripted-match");
    // One match cannot be split without emptying the training set
    expect(corpus.validation).toEqual([]);
    expect(corpus.train).toHaveLength(1);

    const tactical = buildCorpusPairs(corpus.train, "tactical", TACTICAL_INPUT_SIZE);
    const combat = buildCorpusPairs(corpus.train, "combat", COMBAT_INPUT_SIZE);
    expect(tactical.dropped).toBe(0);
    expect(combat.dropped).toBe(0);
    expect(tactical.pairs).toHaveLength(KEPT.length);
    expect(combat.pairs).toHaveLength(KEPT.length);

    const at = (pairs: TrainingPair[], tick: number): TrainingPair => pairs[KEPT.indexOf(tick)];

    // The turn the person made, as a difference — the one label in this
    // pipeline that was never a guess
    expect(at(combat.pairs, 12).target[2]).toBeCloseTo(encodeAimTurn(0.2), 4);
    // Pitch never moved
    expect(at(combat.pairs, 12).target[3]).toBeCloseTo(0, 5);
    // The jump the person pressed
    expect(at(tactical.pairs, 12).target[2]).toBe(1);

    // A weapon carried through an idle frame is not a switch
    expect(at(tactical.pairs, 24).target[3]).toBe(0);

    // Across the death gap there is no previous frame: no invented flick, and
    // no invented switch, although both the view and the weapon changed
    const respawn = at(combat.pairs, RESPAWNED);
    expect(respawn.target[2]).toBe(0);
    expect(respawn.target[3]).toBe(0);
    expect(at(tactical.pairs, RESPAWNED).target[3]).toBe(0);
    expect(at(tactical.pairs, RESPAWNED).target[4]).toBeCloseTo(7 / 9, 5);
  });

  it("stacks frames that follow on, and never across the death", async () => {
    const corpus = await buildCorpus(demoDir, blind);
    const run: TrainingFrame[] = corpus.train[0];
    const { pairs } = buildCorpusPairs(corpus.train, "tactical", TACTICAL_INPUT_SIZE);
    const width = TACTICAL_INPUT_SIZE;
    const slice = (input: number[], slot: number): number[] => input.slice(slot * width, (slot + 1) * width);
    const at = (tick: number): number => KEPT.indexOf(tick);

    // The newest frame is always last, and it is this frame
    for (let index = 0; index < pairs.length; index++) {
      expect(slice(pairs[index].input, FRAME_STACK - 1)).toEqual(run[index].tacticalInput);
    }

    // The first frame of the run has nothing before it: it stands in for itself
    const first = pairs[at(6)].input;
    for (let slot = 0; slot < FRAME_STACK; slot++) expect(slice(first, slot)).toEqual(run[at(6)].tacticalInput);

    // Mid-run, the stack is the frames that led here, oldest first
    const mid = pairs[at(18)].input;
    expect(slice(mid, 0)).toEqual(run[at(6)].tacticalInput);
    expect(slice(mid, 1)).toEqual(run[at(12)].tacticalInput);

    // After respawning, nothing from before the death is in view — the stack
    // starts again from the respawn, as a bot's does
    const respawn = pairs[at(RESPAWNED)].input;
    for (let slot = 0; slot < FRAME_STACK; slot++) {
      expect(slice(respawn, slot)).toEqual(run[at(RESPAWNED)].tacticalInput);
    }
  });

  it("produces vectors the models can actually accept", async () => {
    const corpus = await buildCorpus(demoDir, blind);
    const run: TrainingFrame[] = corpus.train[0];
    expect(run[0].tacticalInput).toHaveLength(TACTICAL_INPUT_SIZE);
    expect(run[0].combatInput).toHaveLength(COMBAT_INPUT_SIZE);

    // The labels have to match the heads they are fed to, or training silently
    // teaches the wrong output the wrong thing
    expect(TACTICAL_TARGET_SIZE).toBe(TACTICAL_OUTPUT_SIZE);
    expect(COMBAT_TARGET_SIZE).toBe(COMBAT_OUTPUT_SIZE);

    const tactical = buildCorpusPairs(corpus.train, "tactical", TACTICAL_INPUT_SIZE);
    for (const pair of tactical.pairs) {
      expect(pair.input).toHaveLength(TACTICAL_MODEL_INPUT);
      expect(pair.target).toHaveLength(TACTICAL_TARGET_SIZE);
      for (const value of [...pair.input, ...pair.target]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});
