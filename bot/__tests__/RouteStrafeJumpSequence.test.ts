import { describe, expect, it } from "vitest";
import type { MovementInput } from "../../../../engine/network/systems/movement/MovementProfile";
import { MovementProfile } from "../../simulation/MovementProfile";
import type { BotInput } from "../BotBrain";
import type { BotDifficulty } from "../BotConfig";
import { InputButtons } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import type { NavStep } from "../BotNavGraph";
import { BotSequenceRegistry, BotSequenceRuntime } from "../BotSequence";
import { RouteStrafeJumpSequence } from "../sequences/RouteStrafeJumpSequence";

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
  yaw: 0,
  buttons: InputButtons.FORWARD | InputButtons.SPRINT,
  weaponSlot: 0,
};

const routeStep: NavStep = {
  from: { id: 0, type: "spawn", position: { x: 0, y: 0, z: 0 } },
  to: { id: 1, type: "floor", position: { x: 0, y: 0, z: 1000 } },
  type: "walk",
  cost: 1000,
  horizontalDistance: 1000,
  heightDelta: 0,
  requiresPreciseApproach: false,
};

function makeHarness(velocity = { x: 0, y: 0, z: 400 }) {
  const state = new BotGameState();
  state.tick = 100;
  state.self.isGrounded = true;
  state.self.velocity = velocity;
  state.self.yaw = 0;

  const registry = new BotSequenceRegistry();
  registry.register(new RouteStrafeJumpSequence());
  const runtime = new BotSequenceRuntime(registry);
  const context = {
    state,
    proposedInput,
    difficulty: hardDifficulty,
    navStep: routeStep,
    routeStrafeReady: true,
    routeStrafeSide: 1 as const,
  };
  return { state, runtime, context };
}
function toMovementInput(input: BotInput): MovementInput {
  const cosYaw = Math.cos(input.yaw);
  const sinYaw = Math.sin(input.yaw);
  const worldX = input.direction.z * sinYaw + input.direction.x * cosYaw;
  const worldZ = input.direction.z * cosYaw - input.direction.x * sinYaw;
  return {
    direction: { x: worldX, y: 0, z: worldZ },
    viewAngles: { pitch: input.pitch, yaw: input.yaw },
    buttons: input.buttons,
    isPressed: (button: number) => (input.buttons & button) !== 0,
  };
}

describe("RouteStrafeJumpSequence", () => {
  it("takes off, uses pure side acceleration, and verifies the landing", () => {
    const { state, runtime, context } = makeHarness();
    expect(runtime.startBest(context)).toBe(true);

    const takeoff = runtime.tick(context);
    expect(takeoff).toMatchObject({ status: "running", phase: "takeoff" });
    expect(takeoff!.input.buttons & InputButtons.JUMP).not.toBe(0);
    expect(takeoff!.input.buttons & InputButtons.FORWARD).not.toBe(0);
    expect(runtime.isCommitted(state.tick + 5)).toBe(true);

    state.tick = 104;
    state.self.isGrounded = false;
    state.self.velocity = { x: 0, y: 300, z: 330 };
    const airborne = runtime.tick(context);
    expect(airborne).toMatchObject({ status: "running", phase: "airborne" });
    expect(airborne!.input.direction).toEqual({ x: 1, y: 0, z: 0 });
    expect(airborne!.input.buttons & InputButtons.RIGHT).not.toBe(0);
    expect(airborne!.input.buttons & InputButtons.FORWARD).toBe(0);
    expect(airborne!.input.yaw).toBeLessThan(0);

    state.tick = 170;

    const movement = new MovementProfile();
    const simulated = movement.simulate(
      { x: 0, y: 5000, z: 0 },
      { x: 0, y: 300, z: 330 },
      toMovementInput(airborne!.input),
      1 / 125,
      null,
    );
    expect(Math.hypot(simulated.velocity.x, simulated.velocity.z)).toBeGreaterThan(330);
    state.self.isGrounded = true;
    state.self.position = { x: 8, y: 0, z: 260 };
    state.self.velocity = { x: 12, y: 0, z: 350 };
    expect(runtime.tick(context)).toMatchObject({ status: "succeeded", phase: "landed" });
    expect(runtime.isActive).toBe(false);
  });

  it("chooses the strafe side that corrects velocity toward the route", () => {
    const { state, runtime, context } = makeHarness({ x: 100, y: 0, z: 400 });
    expect(runtime.startBest(context)).toBe(true);
    runtime.tick(context);

    state.tick = 104;
    state.self.isGrounded = false;
    state.self.velocity = { x: 100, y: 300, z: 300 };
    const airborne = runtime.tick(context);
    expect(airborne!.input.direction.x).toBe(-1);
    expect(airborne!.input.buttons & InputButtons.LEFT).not.toBe(0);
    expect(airborne!.input.buttons & InputButtons.RIGHT).toBe(0);
  });

  it("stops the optional hop when cross-track error shows lost control", () => {
    const { state, runtime, context } = makeHarness();
    expect(runtime.startBest(context)).toBe(true);
    runtime.tick(context);

    state.tick = 104;
    state.self.isGrounded = false;
    state.self.velocity = { x: 0, y: 300, z: 320 };
    runtime.tick(context);

    state.tick = 120;
    state.self.position = { x: 200, y: 40, z: 100 };
    expect(runtime.tick(context)).toMatchObject({
      status: "failed",
      phase: "airborne",
      reason: "route_deviation",
    });
  });

  it("rejects attacks, low skill, low speed, and precision steps", () => {
    const sequence = new RouteStrafeJumpSequence();
    const { state, context } = makeHarness();

    expect(
      sequence.score({
        ...context,
        proposedInput: { ...proposedInput, buttons: proposedInput.buttons | InputButtons.FIRE },
      }),
    ).toBeNull();

    expect(
      sequence.score({
        ...context,
        difficulty: { ...hardDifficulty, strafeJumpSkill: 0.1 },
      }),
    ).toBeNull();

    state.self.velocity = { x: 0, y: 0, z: 180 };
    expect(sequence.score(context)).toBeNull();

    state.self.velocity = { x: 0, y: 0, z: 320 };
    expect(
      sequence.score({
        ...context,
        navStep: { ...routeStep, requiresPreciseApproach: true },
      }),
    ).toBeNull();
  });
});
