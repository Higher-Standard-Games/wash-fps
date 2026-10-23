/**
 * Two bugs this pipeline had, and the shapes that let them in.
 *
 * Both are data-flow bugs: every part was correct on its own, and the defect
 * lived in what one part assumed about another. Neither would show up in a
 * playtest — a bot trained on subtly wrong labels just plays subtly badly.
 */

import { describe, expect, it } from "vitest";
import { InputButtons } from "../BotConfig";
import type { TrainingFrame } from "../BotEpisodeRecorder";
import { buildCorpusPairs, buildRunPairs, encodeAimTurn } from "../CloningTargets";
import { chooseAction } from "../DemoTrainingExtractor";
import { splitByMatch } from "../TrainingCorpus";

const frame = (yaw: number, tag = "", tick = 0): TrainingFrame =>
  ({
    tick,
    tacticalInput: new Array(25).fill(0),
    combatInput: new Array(18).fill(0),
    reward: 0,
    action: { buttons: 0, weaponSlot: 0, yaw, pitch: 0, directionX: 0, directionZ: 0, tag },
    events: {
      damageDealt: 0,
      damageTaken: 0,
      kill: false,
      death: false,
      itemPickedUp: false,
      healthBefore: 100,
      healthAfter: 100,
      armorBefore: 0,
      armorAfter: 0,
    },
  }) as unknown as TrainingFrame;

describe("a turn is measured within one run, never across two", () => {
  it("gives the first frame of every run a neutral turn", () => {
    // Two players, each ending and starting at wildly different view angles
    const alice = [frame(0, "", 10), frame(0.1, "", 12)];
    const bob = [frame(3.0, "", 10), frame(3.1, "", 12)];

    const { pairs } = buildCorpusPairs([alice, bob], "combat", 18);

    // Frame 0 of each run has no predecessor, so no turn is claimed
    expect(pairs[0].target[2]).toBe(0);
    expect(pairs[2].target[2]).toBe(0);
    // Within a run, the small turn is measured
    expect(pairs[1].target[2]).toBeCloseTo(encodeAimTurn(0.1), 5);
    expect(pairs[3].target[2]).toBeCloseTo(encodeAimTurn(0.1), 5);
  });

  it("would have invented a turn if the runs were concatenated", () => {
    // What the old flat-array code did: alice's last frame became bob's previous
    const concatenated = buildRunPairs(
      [frame(0, "", 10), frame(0.1, "", 12), frame(3.0, "", 14), frame(3.1, "", 16)],
      "combat",
      18,
    );
    // A 2.9-radian flick nobody made, at the seam
    expect(concatenated[2].target[2]).not.toBe(0);
    expect(Math.abs(concatenated[2].target[2])).toBeGreaterThan(5);
  });

  it("keeps runs separate through the validation split", () => {
    const matchA = [[frame(0)], [frame(1)]]; // two players
    const matchB = [[frame(2)]];
    const { train, validation } = splitByMatch([matchA, matchB], 0.3);
    // Runs stay whole: no run is split across the boundary
    for (const run of [...train, ...validation]) {
      expect(run.length).toBeGreaterThan(0);
    }
    expect(train.length + validation.length).toBe(3);
  });
});

describe("a gap in a run is not a turn", () => {
  it("claims no turn across a death, where the array jumps but time does not", () => {
    // The extractor skips every frame a player is dead, so the array goes
    // straight from the moment of death to the respawn — hundreds of ticks
    const beforeDeath = frame(0, "", 100);
    const afterRespawn = frame(3.0, "", 400);

    const pairs = buildRunPairs([beforeDeath, afterRespawn], "combat", 18);
    expect(pairs[1].target[2]).toBe(0);
  });

  it("still measures a turn between genuinely consecutive frames", () => {
    const pairs = buildRunPairs([frame(0, "", 100), frame(0.3, "", 102)], "combat", 18);
    expect(pairs[1].target[2]).toBeCloseTo(encodeAimTurn(0.3), 5);
  });

  it("claims no weapon switch across a gap either", () => {
    const before = frame(0, "", 100);
    const after = frame(0, "", 500);
    (after as { action: { weaponSlot: number } }).action.weaponSlot = 4;
    // A different weapon after respawning is a loadout, not a switch the
    // player performed between two frames
    expect(buildRunPairs([before, after], "tactical", 25)[1].target[3]).toBe(0);
  });
});

describe("a frame with no recorded command", () => {
  const inferred = {
    buttons: InputButtons.SPRINT | InputButtons.FORWARD,
    weaponSlot: 3,
    yaw: 1,
    pitch: 0.2,
    directionX: 1,
    directionZ: 1,
  };

  it("means the player pressed nothing, on a demo that records commands", () => {
    const action = chooseAction(undefined, inferred, true);
    // Falling or sliding is not the same as holding forward
    expect(action.buttons).toBe(0);
    expect(action.directionX).toBe(0);
    expect(action.directionZ).toBe(0);
    // The view still comes from state, which is authoritative
    expect(action.yaw).toBe(1);
    expect(action.pitch).toBe(0.2);
  });

  it("falls back to the guess only for a demo too old to know better", () => {
    expect(chooseAction(undefined, inferred, false)).toEqual(inferred);
  });

  it("prefers the recorded command whenever there is one", () => {
    const recorded = {
      playerId: "p1",
      buttons: InputButtons.JUMP,
      yaw: -1,
      pitch: 0,
      forward: 1,
      right: -1,
      weaponSlot: 7,
      commands: 2,
    };
    expect(chooseAction(recorded, inferred, true)).toEqual({
      buttons: InputButtons.JUMP,
      weaponSlot: 7,
      yaw: -1,
      pitch: 0,
      directionX: -1,
      directionZ: 1,
    });
  });
});

describe("a frame that is not a number", () => {
  it("never reaches fit, because one NaN destroys the weights", () => {
    const good = frame(0, "", 10);
    const bad = frame(0.1, "", 12);
    (bad as { tacticalInput: number[] }).tacticalInput[3] = Number.NaN;

    const { pairs, dropped } = buildCorpusPairs([[good, bad]], "tactical", 25);
    expect(pairs).toHaveLength(1);
    expect(dropped).toBe(1);
  });

  it("counts a frame dropped for the wrong feature width too", () => {
    const wrongWidth = frame(0, "", 10);
    (wrongWidth as { tacticalInput: number[] }).tacticalInput = new Array(9).fill(0);
    const { pairs, dropped } = buildCorpusPairs([[wrongWidth]], "tactical", 25);
    expect(pairs).toEqual([]);
    expect(dropped).toBe(1);
  });
});
