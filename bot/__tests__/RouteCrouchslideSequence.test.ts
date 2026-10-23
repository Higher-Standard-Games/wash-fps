import { describe, expect, it } from "vitest";
import type { BotInput } from "../BotBrain";
import type { BotDifficulty } from "../BotConfig";
import { InputButtons } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import { BotSequenceRegistry, BotSequenceRuntime } from "../BotSequence";
import { RouteCrouchslideSequence } from "../sequences/RouteCrouchslideSequence";

const hardDifficulty: BotDifficulty = {
  aimAccuracy: 1,
  reactionTimeMs: 0,
  trackingSpeed: 999,
  predictionSkill: 1,
  itemTimingSkill: 1,
  strafeJumpSkill: 1,
  dodgeSkill: 1,
  mistakeRate: 0,
  lookAroundInterval: 10,
};

const proposedInput: BotInput = {
  direction: { x: 0, y: 0, z: 1 },
  pitch: 0,
  yaw: Math.PI / 3,
  buttons: InputButtons.FORWARD | InputButtons.SPRINT,
  weaponSlot: 0,
};

function makeHarness() {
  const state = new BotGameState();
  state.tick = 100;
  state.self.isGrounded = true;
  state.self.velocity = { x: 0, y: 0, z: 420 };

  const registry = new BotSequenceRegistry();
  registry.register(new RouteCrouchslideSequence());
  const runtime = new BotSequenceRuntime(registry);
  const context = {
    state,
    proposedInput,
    difficulty: hardDifficulty,
    crouchslideReady: true,
  };
  return { state, runtime, context };
}

describe("RouteCrouchslideSequence", () => {
  it("releases a stalled slide without jump-cancelling in place", () => {
    const { state, runtime, context } = makeHarness();
    expect(runtime.startBest(context)).toBe(true);
    runtime.tick(context);
    state.tick = 105;
    state.self.isSliding = true;
    runtime.tick(context);
    state.tick = 180;
    state.self.velocity = { x: 0, y: 0, z: 0 };
    const released = runtime.tick(context)!;
    expect(released.input.buttons & InputButtons.JUMP).toBe(0);
    expect(released.input.buttons & InputButtons.SPRINT).not.toBe(0);
  });

  it("verifies slide entry, holds its trajectory, and confirms jump-cancel exit", () => {
    const { state, runtime, context } = makeHarness();
    expect(runtime.startBest(context)).toBe(true);

    const engage = runtime.tick(context);
    expect(engage).toMatchObject({ status: "running", phase: "engage" });
    expect(engage!.input.buttons & InputButtons.CROUCH).not.toBe(0);
    expect(engage!.input.yaw).toBeCloseTo(Math.PI / 3);

    state.tick = 105;
    state.self.isSliding = true;
    expect(runtime.tick(context)).toMatchObject({ status: "running", phase: "slide" });

    state.tick = 180;
    const cancel = runtime.tick(context);
    expect(cancel).toMatchObject({ status: "running", phase: "jump_cancel" });
    expect(cancel!.input.buttons & InputButtons.JUMP).not.toBe(0);
    expect(cancel!.input.buttons & InputButtons.CROUCH).toBe(0);
    expect(runtime.isCommitted(state.tick + 8)).toBe(true);

    state.tick = 185;
    state.self.isSliding = false;
    state.self.isGrounded = false;
    expect(runtime.tick(context)).toMatchObject({ status: "succeeded", phase: "exit" });
    expect(runtime.isActive).toBe(false);
  });

  it("fails deterministically when authoritative state never confirms a slide", () => {
    const { state, runtime, context } = makeHarness();
    expect(runtime.startBest(context)).toBe(true);
    runtime.tick(context);

    state.tick = 120;
    expect(runtime.tick(context)).toMatchObject({
      status: "failed",
      phase: "engage",
      reason: "slide_not_confirmed",
    });
  });

  it("rejects attacks, low speed, and precision traversal steps", () => {
    const sequence = new RouteCrouchslideSequence();
    const { state, context } = makeHarness();

    state.self.velocity = { x: 0, y: 0, z: 300 };
    expect(sequence.score(context)).toBeNull();

    state.self.velocity = { x: 0, y: 0, z: 420 };
    expect(
      sequence.score({
        ...context,
        proposedInput: { ...proposedInput, buttons: proposedInput.buttons | InputButtons.FIRE },
      }),
    ).toBeNull();

    expect(
      sequence.score({
        ...context,
        navStep: {
          from: { id: 0, type: "spawn", position: { x: 0, y: 0, z: 0 } },
          to: { id: 1, type: "teleporter", position: { x: 100, y: 0, z: 0 } },
          type: "teleporter",
          cost: 100,
          horizontalDistance: 100,
          heightDelta: 0,
          requiresPreciseApproach: true,
        },
      }),
    ).toBeNull();
  });
});
