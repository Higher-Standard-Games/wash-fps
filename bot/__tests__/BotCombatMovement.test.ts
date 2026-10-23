/**
 * How a bot moves in a fight: strafe runs of varied length, a dodge after a
 * hit, a sidestep off a rocket's path once it has been noticed, and hops to
 * keep speed at range.
 */

import { describe, expect, it } from "vitest";
import { awaySide, BotCombatMovement, findHighGround } from "../BotCombatMovement";
import { BotGameState, type VisibleProjectile } from "../BotGameState";

const HARD = { dodgeSkill: 0.7, strafeJumpSkill: 0.7, reactionTimeMs: 150 };
const EASY = { dodgeSkill: 0.15, strafeJumpSkill: 0.1, reactionTimeMs: 450 };

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function grounded(): BotGameState {
  const state = new BotGameState();
  state.tick = 0;
  state.self.position = { x: 0, y: 0, z: 0 };
  state.self.velocity = { x: 0, y: 0, z: 0 };
  state.self.isGrounded = true;
  state.self.yaw = 0;
  return state;
}

/** Lengths of each strafe run, in ticks, over `seconds` of fighting. */
function runs(skills: typeof HARD, seed: number, seconds = 60): number[] {
  const movement = new BotCombatMovement(seeded(seed));
  const state = grounded();
  const lengths: number[] = [];
  let side = 0;
  let start = 0;
  for (let tick = 0; tick < seconds * 125; tick += 4) {
    state.tick = tick;
    const { strafe } = movement.step(state, skills, 300);
    if (strafe !== 0 && strafe !== side) {
      if (side !== 0) lengths.push(tick - start);
      side = strafe;
      start = tick;
    }
  }
  return lengths;
}

function spread(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

describe("strafing", () => {
  it("varies the rhythm more the better the bot dodges", () => {
    const hard = runs(HARD, 7);
    const easy = runs(EASY, 7);
    expect(Math.min(...hard)).toBeLessThan(0.3 * 125); // quick double-backs
    expect(Math.max(...hard)).toBeGreaterThan(0.8 * 125);
    expect(spread(hard)).toBeGreaterThan(1.4 * spread(easy));
  });
});

describe("dodging a hit", () => {
  it("jumps sideways right after taking damage", () => {
    const movement = new BotCombatMovement(() => 0.1);
    const state = grounded();
    movement.step(state, HARD, 300);
    state.tick = 10;
    state.recentDamage.push({
      attackerId: "e",
      damage: 20,
      weaponId: "machinegun",
      position: { x: 0, y: 0, z: 0 },
      tick: 10,
    });
    const moves = movement.step(state, HARD, 300);
    expect(moves.jump).toBe(true);
    expect(moves.strafe).not.toBe(0);
    state.tick = 12;
    expect(movement.step(state, HARD, 300).jump).toBe(false);
    expect(movement.step(state, HARD, 300).strafe).not.toBe(0);
  });

  it("does not on Easy, mostly", () => {
    const movement = new BotCombatMovement(() => 0.5);
    const state = grounded();
    state.recentDamage.push({
      attackerId: "e",
      damage: 20,
      weaponId: "machinegun",
      position: { x: 0, y: 0, z: 0 },
      tick: 0,
    });
    expect(movement.step(state, EASY, 300).jump).toBe(false);
  });
});

describe("dodging a rocket", () => {
  function rocket(x: number): VisibleProjectile {
    return {
      entityId: "proj_1",
      position: { x, y: 0, z: 800 },
      velocity: { x: 0, y: 0, z: -900 },
      isThreat: true,
    } as VisibleProjectile;
  }

  it("steps off the path once it has noticed the rocket, away from it", () => {
    const movement = new BotCombatMovement(() => 0.1);
    const state = grounded();
    state.projectiles = [rocket(-30)]; // a little to the bot's left (x < 0 is left at yaw 0)
    movement.step(state, HARD, 300); // seen now; not noticed yet
    state.tick = 30; // 240 ms later, past the 150 ms reaction
    const moves = movement.step(state, HARD, 300);
    expect(moves.strafe).toBe(1);
    expect(moves.jump).toBe(true);
  });

  it("ignores its own rockets", () => {
    const movement = new BotCombatMovement(() => 0.1);
    const state = grounded();
    state.projectiles = [{ ...rocket(0), position: { x: 0, y: 40, z: 60 } }];
    movement.step(state, HARD, 300);
    state.tick = 30;
    expect(movement.step(state, HARD, 300).jump).toBe(false);
  });

  it("picks the side away from the path", () => {
    expect(awaySide({ x: 0, y: 0, z: 0 }, 0, rocket(-30))).toBe(1);
    expect(awaySide({ x: 0, y: 0, z: 0 }, 0, rocket(30))).toBe(-1);
    // Facing the other way, right and left swap
    expect(awaySide({ x: 0, y: 0, z: 0 }, Math.PI, rocket(-30))).toBe(-1);
  });
});

describe("at range", () => {
  it("does not jump simply because the opponent is far away", () => {
    const state = grounded();
    expect(new BotCombatMovement(() => 0.5).step(state, HARD, 800).jump).toBe(false);
    expect(new BotCombatMovement(() => 0.5).step(state, EASY, 800).jump).toBe(false);
    expect(new BotCombatMovement(() => 0.5).step(state, HARD, 300).jump).toBe(false);
  });
});

describe("high ground", () => {
  it("takes the highest nearby ledge that still sees the enemy", () => {
    const nodes = [
      { position: { x: 100, y: 128, z: 0 } },
      { position: { x: 200, y: 256, z: 0 } }, // higher but blind
      { position: { x: 900, y: 512, z: 0 } }, // too far
      { position: { x: 50, y: 16, z: 0 } }, // not high
    ];
    const blind = (from: { y: number }) => from.y < 256;
    expect(findHighGround(nodes, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 500 }, blind)).toEqual({
      x: 100,
      y: 128,
      z: 0,
    });
    expect(findHighGround(nodes, { x: 0, y: 0, z: 0 }, { x: 0, y: 100, z: 500 }, () => true)).toEqual({
      x: 200,
      y: 256,
      z: 0,
    });
  });
});
