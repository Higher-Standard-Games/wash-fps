/**
 * What a bot does with the network's answers.
 *
 * Every output is acted on only as far as it was learned on matches the weights
 * never saw; yes-or-no answers are drawn, not thresholded; aim is a turn from
 * where the bot is looking now. Weights from before any of that are refused, and
 * a loaded model can be trained further.
 *
 * TF-12 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BotInput } from "../BotBrain";
import { BotState } from "../BotBrain";
import { InputButtons, resolveDifficulty } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import { HybridBrain } from "../HybridBrain";
import { TACTICAL_MODEL_INPUT } from "../ModelInputs";
import { describeCurrentFeatures, writeMetadata } from "../ModelMetadata";
import { getTF, initTF, isTFAvailable } from "../TFBackend";
import { demoTempDir } from "./fixtures/scriptedDemo";

const YES = 10;
const NO = -10;

/** A brain whose draws always come out at `draw`, with the given held-out skill. */
function brainWith(skill: Record<string, number>, draw = 0.3): HybridBrain {
  const brain = new HybridBrain(resolveDifficulty("medium"), () => draw);
  // biome-ignore lint/suspicious/noExplicitAny: setting what a real load reads from metadata
  (brain as any)._skill = skill;
  return brain;
}

function baseInput(): BotInput {
  return { buttons: 0, direction: { x: 0, y: 0, z: 1 }, yaw: 1.5, pitch: 0.2, weaponSlot: 0 };
}

function state(): BotGameState {
  const value = new BotGameState();
  value.self.yaw = 1.0;
  value.self.pitch = 0;
  value.self.weapons = ["blade", "machinegun", "riotgun"];
  value.self.currentWeapon = "machinegun";
  return value;
}

const applyTactical = (brain: HybridBrain, raw: number[], input: BotInput): void =>
  // biome-ignore lint/suspicious/noExplicitAny: reaching the private application path is the point
  (brain as any)._applyTactical(Float32Array.from(raw), input, state(), BotState.HUNT);
const applyCombat = (brain: HybridBrain, raw: number[], input: BotInput): void =>
  // biome-ignore lint/suspicious/noExplicitAny: as above
  (brain as any)._applyCombat(Float32Array.from(raw), input, state());

// Tactical: sprint, slide, jump, switch, slot. Combat: fire, alt, yaw, pitch, left, right.

describe("a yes-or-no output", () => {
  it("does nothing if it was never shown to be learned, however sure it looks", () => {
    const input = baseInput();
    applyTactical(brainWith({}), [NO, NO, YES, NO, NO], input);
    expect(input.buttons & InputButtons.JUMP).toBe(0);
  });

  it("is acted on once it was learned", () => {
    const input = baseInput();
    applyTactical(brainWith({ jump: 0.4 }), [NO, NO, YES, NO, NO], input);
    expect(input.buttons & InputButtons.JUMP).not.toBe(0);
  });

  it("is not acted on when its skill is within the noise of a fixed answer", () => {
    const input = baseInput();
    applyTactical(brainWith({ jump: 0.01 }), [NO, NO, YES, NO, NO], input);
    expect(input.buttons & InputButtons.JUMP).toBe(0);
  });

  it("is drawn, not thresholded, so the same state does not always give the same answer", () => {
    // Even odds: whether the bot jumps depends on the draw
    const low = baseInput();
    applyTactical(brainWith({ jump: 0.4 }, 0.3), [NO, NO, 0, NO, NO], low);
    const high = baseInput();
    applyTactical(brainWith({ jump: 0.4 }, 0.7), [NO, NO, 0, NO, NO], high);
    expect(low.buttons & InputButtons.JUMP).not.toBe(0);
    expect(high.buttons & InputButtons.JUMP).toBe(0);
  });

  it("can hold fire the state machine wanted, once fire was learned", () => {
    const input = baseInput();
    input.buttons |= InputButtons.FIRE;
    applyCombat(brainWith({ fire: 0.3 }), [NO, NO, 0, 0, NO, NO], input);
    expect(input.buttons & InputButtons.FIRE).toBe(0);
  });

  it("leaves the state machine's fire alone when fire was not learned", () => {
    const input = baseInput();
    input.buttons |= InputButtons.FIRE;
    applyCombat(brainWith({}), [NO, NO, 0, 0, NO, NO], input);
    expect(input.buttons & InputButtons.FIRE).not.toBe(0);
  });
});

describe("aim", () => {
  it("turns from where the bot is looking, by as far as aim was learned", () => {
    // The network says a person would turn 0.2 rad from the current view (1.0);
    // the state machine wants 1.5. Learned at 0.5, the bot goes halfway.
    const input = baseInput();
    applyCombat(brainWith({ "aim yaw": 0.5 }), [NO, NO, 2, 0, NO, NO], input);
    expect(input.yaw).toBeCloseTo(1.5 + 0.5 * (1.2 - 1.5), 6);
  });

  it("follows the network entirely when aim was learned completely", () => {
    const input = baseInput();
    applyCombat(brainWith({ "aim yaw": 1 }), [NO, NO, 2, 0, NO, NO], input);
    expect(input.yaw).toBeCloseTo(1.2, 6);
  });

  it("is the state machine's alone when aim was not learned", () => {
    const input = baseInput();
    applyCombat(brainWith({ fire: 0.5 }), [NO, NO, 2, 0, NO, NO], input);
    expect(input.yaw).toBe(1.5);
  });
});

describe("weights on disk", () => {
  let dir: string;
  beforeAll(async () => {
    await initTF();
    dir = demoTempDir("outputs");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("refuses weights whose outputs went through a sigmoid", async () => {
    if (!isTFAvailable()) return;
    const tf = getTF();
    const old = tf.sequential({
      layers: [tf.layers.dense({ inputShape: [TACTICAL_MODEL_INPUT], units: 5, activation: "sigmoid" })],
    });
    const target = path.join(dir, "old");
    fs.mkdirSync(target, { recursive: true });
    await old.save(`file://${path.join(target, "tactical")}`);
    old.dispose();
    // Metadata that claims the current encoding still cannot smuggle them in
    writeMetadata(target, {
      ...describeCurrentFeatures(),
      trainedAt: "2026-09-24T00:00:00.000Z",
      matches: 2,
      trainFrames: 10,
      validationFrames: 10,
      includedBots: true,
      matchIds: [],
      outputSkill: { jump: 0.5 },
    });

    const brain = new HybridBrain(resolveDifficulty("medium"));
    expect(await brain.loadModels(target)).toBe(false);
    brain.dispose();
  });

  it("trains further after loading, which --resume could not", async () => {
    if (!isTFAvailable()) return;
    const tf = getTF();
    const target = path.join(dir, "resume");
    fs.mkdirSync(target, { recursive: true });
    const first = new HybridBrain(resolveDifficulty("medium"));
    await first.createFreshModels();
    await first.saveModels(target);
    first.dispose();

    const second = new HybridBrain(resolveDifficulty("medium"));
    expect(await second.loadModels(target)).toBe(true);
    const x = tf.zeros([4, TACTICAL_MODEL_INPUT]);
    const y = tf.zeros([4, 5]);
    await expect(second.tacticalModel!.fit(x, y, { epochs: 1, verbose: 0 })).resolves.toBeDefined();
    x.dispose();
    y.dispose();
    second.dispose();
  });
});
