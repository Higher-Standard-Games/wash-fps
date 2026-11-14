import { describe, expect, it } from "vitest";
import { BLOCKED_TICKS, BotBlockedMove } from "../BotBlockedMove";
import { type BotInput, BotState, travelYaw } from "../BotBrain";
import { type BotDifficulty, InputButtons } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import { StateMachineBrain } from "../StateMachineBrain";

const at = (x: number, y = 0, z = 0) => ({ x, y, z });

describe("BotBlockedMove", () => {
  it("finds a bot blocked once it has asked to move in one spot for the whole window", () => {
    const blocked = new BotBlockedMove();
    for (let tick = 0; tick < BLOCKED_TICKS; tick++) expect(blocked.update(tick, at(0), true)).toBe(false);
    expect(blocked.update(BLOCKED_TICKS, at(10), true)).toBe(true);
    // The watch starts over from there
    expect(blocked.update(BLOCKED_TICKS + 1, at(10), true)).toBe(false);
  });

  it("never finds a bot blocked that stands still on purpose or is getting somewhere", () => {
    const standing = new BotBlockedMove();
    const walking = new BotBlockedMove();
    const lifted = new BotBlockedMove();
    for (let tick = 0; tick <= 3 * BLOCKED_TICKS; tick++) {
      expect(standing.update(tick, at(0), false)).toBe(false);
      expect(walking.update(tick, at(tick * 2.6), true)).toBe(false);
      expect(lifted.update(tick, at(0, tick * 0.5), true)).toBe(false);
    }
  });
});

const difficulty: BotDifficulty = {
  aimAccuracy: 1,
  reactionTimeMs: 0,
  trackingSpeed: 999,
  predictionSkill: 1,
  itemTimingSkill: 1,
  strafeJumpSkill: 1,
  dodgeSkill: 0,
  mistakeRate: 0,
  lookAroundInterval: 10,
};

/** World heading of an input's movement. */
const heading = (input: BotInput) => travelYaw(input) + Math.atan2(input.direction.x, input.direction.z);

describe("a bot held by a wall in a fight", () => {
  it("turns away from it while its aim stays on the enemy, then fights on", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = new BotGameState();
    state.selfEntityId = "player_1";
    state.selfPlayerId = "bot";
    Object.assign(state.self, {
      position: at(0),
      health: 100,
      isGrounded: true,
      currentWeapon: "blade",
      weapons: ["blade"],
      ammo: { blade: 1 },
    });
    // An enemy straight ahead (+z) that the blade charges at, with a wall between
    state.players = [
      {
        entityId: "player_2",
        playerId: "enemy",
        position: at(0, 0, 700),
        velocity: at(0),
        isDead: false,
        team: "",
        relation: "enemy",
        distance: 700,
      },
    ];
    let input = brain.decide(state);
    expect(brain.getState()).toBe(BotState.FIGHT);
    expect(Math.cos(heading(input))).toBeGreaterThan(0);
    for (state.tick = 1; state.tick < BLOCKED_TICKS; state.tick++) brain.decide(state);
    input = brain.decide(state);
    // Runs the way it came, away from the wall it was pressing into
    expect(Math.cos(heading(input))).toBeLessThan(0);
    expect(input.buttons & InputButtons.FORWARD).not.toBe(0);
    expect(Math.cos(input.yaw)).toBeGreaterThan(0.9);
    // The fight's own movement steers again after the short run
    state.tick += 70;
    input = brain.decide(state);
    expect(Math.cos(heading(input))).toBeGreaterThan(0);
  });
});
