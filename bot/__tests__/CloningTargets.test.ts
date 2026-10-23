/**
 * Behaviour cloning labels: what the person did, not how well it went.
 *
 * The scheme these replace built every target from the frame's reward, so on a
 * neutral frame — most frames — every target was 0.5 whatever the human had
 * done. TF-4 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import { describe, expect, it } from "vitest";
import { InputButtons } from "../BotConfig";
import type { TrainingFrame } from "../BotEpisodeRecorder";
import {
  AIM_TURN_SCALE,
  angleDelta,
  buildCombatTarget,
  buildTacticalTarget,
  decodeAimTurn,
  decodeWeaponSlot,
  encodeAimTurn,
  encodeWeaponSlot,
  MAX_AIM_TURN,
  MAX_WEAPON_SLOT,
  resampleByWeight,
  rewardWeights,
  TACTICAL_TARGET_SIZE,
} from "../CloningTargets";

const frame = (over: {
  buttons?: number;
  yaw?: number;
  pitch?: number;
  directionX?: number;
  directionZ?: number;
  weaponSlot?: number;
  damageTaken?: number;
  reward?: number;
}): TrainingFrame =>
  ({
    tick: 0,
    tacticalInput: [],
    combatInput: null,
    reward: over.reward ?? 0,
    action: {
      buttons: over.buttons ?? 0,
      weaponSlot: over.weaponSlot ?? 0,
      yaw: over.yaw ?? 0,
      pitch: over.pitch ?? 0,
      directionX: over.directionX ?? 0,
      directionZ: over.directionZ ?? 0,
    },
    events: {
      damageDealt: 0,
      damageTaken: over.damageTaken ?? 0,
      kill: false,
      death: false,
      itemPickedUp: false,
      healthBefore: 100,
      healthAfter: 100,
      armorBefore: 0,
      armorAfter: 0,
    },
  }) as unknown as TrainingFrame;

describe("tactical targets", () => {
  it("labels the buttons the person held, whatever the reward", () => {
    const pressed = frame({ buttons: InputButtons.SPRINT | InputButtons.JUMP, reward: 0 });
    const target = buildTacticalTarget(pressed);
    // A neutral reward used to erase this: both would have been 0.5
    expect(target[0]).toBe(1); // sprint
    expect(target[2]).toBe(1); // jump
  });

  it("labels a button not held as zero, not as an inverse of the reward", () => {
    const target = buildTacticalTarget(frame({ buttons: 0, reward: 0.9 }));
    expect(target[0]).toBe(0);
    expect(target[2]).toBe(0);
  });

  it("notices a weapon switch and which slot was chosen", () => {
    const before = frame({ weaponSlot: 2 });
    const after = frame({ weaponSlot: 5 });
    expect(buildTacticalTarget(after, before)[3]).toBe(1);
    expect(buildTacticalTarget(after, before)[4]).toBeCloseTo(5 / 9, 5);
    expect(buildTacticalTarget(after, after)[3]).toBe(0);
  });

  it("has no output a demo cannot label", () => {
    // The head used to open with FIGHT, RETREAT and HUNT confidences, which no
    // recording can supply and which were derived from behaviour instead.
    expect(buildTacticalTarget(frame({}))).toHaveLength(TACTICAL_TARGET_SIZE);
    expect(TACTICAL_TARGET_SIZE).toBe(5);
  });

  it("names the same weapon on both sides of the network", () => {
    // The label and the decoding have to be inverses, or an output means one
    // slot in training and another at inference
    for (let slot = 0; slot <= MAX_WEAPON_SLOT; slot++) {
      expect(decodeWeaponSlot(encodeWeaponSlot(slot))).toBe(slot);
    }
    // Out of range in either direction saturates rather than wrapping
    expect(decodeWeaponSlot(encodeWeaponSlot(20))).toBe(MAX_WEAPON_SLOT);
    expect(decodeWeaponSlot(Number.NaN)).toBe(0);
  });
});

describe("reward as a weight", () => {
  it("counts the typical frame normally, better more, worse less", () => {
    const [typical, better, worse] = rewardWeights([0, 1, -1, 0, 0]);
    expect(typical).toBeCloseTo(0.5, 5);
    expect(better).toBe(1);
    expect(worse).toBe(0);
  });

  it("keeps ordinary frames ordinary when an episode has only a kill", () => {
    // Min-max normalisation puts the one kill at +1 and every other frame at -1.
    // Weighted from the raw value, the round would have been one frame long.
    const rewards = [-1, -1, -1, -1, -1, -1, -1, -1, -1, 1];
    const weights = rewardWeights(rewards);
    expect(weights.slice(0, 9).every((weight) => weight === 0.5)).toBe(true);
    expect(weights[9]).toBe(1);
  });

  it("weighs every frame the same when nothing stood out", () => {
    expect(rewardWeights([0, 0, 0])).toEqual([0.5, 0.5, 0.5]);
  });

  it("refuses to weigh a value that is not a number", () => {
    const weights = rewardWeights([0, Number.NaN, 1, Number.POSITIVE_INFINITY]);
    expect(weights[1]).toBe(0);
    expect(weights[3]).toBe(0);
  });
});

describe("resampleByWeight", () => {
  it("draws each item about as often as its weight says", () => {
    const drawn = resampleByWeight(["light", "heavy"], [1, 3], 400, 0.5);
    const heavy = drawn.filter((item) => item === "heavy").length;
    expect(drawn).toHaveLength(400);
    expect(heavy).toBe(300);
  });

  it("never draws what weighs nothing", () => {
    const drawn = resampleByWeight(["a", "b", "c"], [1, 0, 1], 100, 0.3);
    expect(drawn).not.toContain("b");
  });

  it("draws nothing when nothing has weight", () => {
    expect(resampleByWeight(["a"], [0], 10, 0.5)).toEqual([]);
    expect(resampleByWeight([], [], 10, 0.5)).toEqual([]);
  });
});

describe("combat targets", () => {
  it("labels fire and alt-fire from the buttons", () => {
    const target = buildCombatTarget(frame({ buttons: InputButtons.FIRE | InputButtons.ALT_FIRE }));
    expect(target[0]).toBe(1);
    expect(target[1]).toBe(1);
  });

  it("uses the turn the person made, which the old scheme discarded", () => {
    const before = frame({ yaw: 0 });
    const right = buildCombatTarget(frame({ yaw: 0.5 }), before);
    const left = buildCombatTarget(frame({ yaw: -0.5 }), before);
    // Signed, in turn units: half a radian is five
    expect(right[2]).toBeCloseTo(5, 5);
    expect(left[2]).toBeCloseTo(-5, 5);
    // No previous frame means no measurable turn
    expect(buildCombatTarget(frame({ yaw: 0.5 }))[2]).toBe(0);
  });

  it("strafes from the wish direction, not from velocity", () => {
    expect(buildCombatTarget(frame({ directionX: -1 }))[4]).toBe(1);
    expect(buildCombatTarget(frame({ directionX: 1 }))[5]).toBe(1);
    expect(buildCombatTarget(frame({ directionX: 0 }))[4]).toBe(0);
  });
});

describe("angle handling", () => {
  it("takes the short way round the circle", () => {
    expect(angleDelta(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6.0, 5);
    expect(angleDelta(0, 1)).toBeCloseTo(1, 5);
  });

  it("caps a flick at a radian, and reads a turn back exactly", () => {
    expect(encodeAimTurn(0)).toBe(0);
    expect(encodeAimTurn(99)).toBeCloseTo(MAX_AIM_TURN / AIM_TURN_SCALE, 5);
    expect(encodeAimTurn(-99)).toBeCloseTo(-MAX_AIM_TURN / AIM_TURN_SCALE, 5);
    // The brain reads a turn with the inverse of the label, so the two cannot drift
    for (const radians of [-0.8, -0.05, 0, 0.013, 0.3]) {
      expect(decodeAimTurn(encodeAimTurn(radians))).toBeCloseTo(radians, 10);
    }
  });
});
