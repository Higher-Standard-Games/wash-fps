import { describe, expect, it } from "vitest";
import { InputButtons } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import type { MovementOpportunity } from "../BotMovementAnalyzer";
import type { NavStep } from "../BotNavGraph";
import { BotSequenceRegistry, BotSequenceRuntime } from "../BotSequence";
import { ValidatedJumpSequence } from "../sequences/ValidatedJumpSequence";

const opportunity: MovementOpportunity = {
  id: "jump:0->1",
  kind: "jump",
  fromNodeId: 0,
  toNodeId: 1,
  takeoff: {
    position: { x: 0, y: 25, z: 0 },
    radius: 32,
    minSpeed: 160,
    maxSpeed: 160,
    yawRange: [Math.PI / 2 - 0.1, Math.PI / 2 + 0.1],
  },
  landing: {
    position: { x: 100, y: 25, z: 0 },
    radius: 48,
    surfaceNormal: { x: 0, y: 1, z: 0 },
  },
  inputPlan: {
    direction: { x: 1, y: 0, z: 0 },
    initialSpeed: 160,
    buttons: InputButtons.FORWARD | InputButtons.SPRINT | InputButtons.JUMP,
    jumpTicks: 1,
    maxTicks: 150,
  },
  expectedTicks: 40,
  successMargin: 24,
  risk: {
    fallDamage: false,
    requiresLedgeGrab: false,
  },
};

const step: NavStep = {
  from: { id: 0, type: "spawn", position: { x: 0, y: 0, z: 0 } },
  to: { id: 1, type: "floor", position: { x: 100, y: 0, z: 0 } },
  type: "jump",
  cost: 100,
  horizontalDistance: 100,
  heightDelta: 0,
  requiresPreciseApproach: false,
  opportunityId: opportunity.id,
  requiredSpeed: 160,
  expectedTicks: 40,
  successMargin: 24,
  validated: true,
};

function makeHarness() {
  const state = new BotGameState();
  state.tick = 10;
  state.self.position = { x: 0, y: 25, z: 0 };
  state.self.velocity = { x: 160, y: 0, z: 0 };
  state.self.isGrounded = true;

  const registry = new BotSequenceRegistry();
  registry.register(new ValidatedJumpSequence());
  const runtime = new BotSequenceRuntime(registry);
  const context = { state, navStep: step, movementOpportunity: opportunity };
  expect(runtime.startBest(context)).toBe(true);
  return { state, runtime, context };
}

describe("ValidatedJumpSequence", () => {
  it("launches at the analyzed yaw and verifies the real landing", () => {
    const { state, runtime, context } = makeHarness();

    const takeoff = runtime.tick(context);
    expect(takeoff).toMatchObject({ status: "running", phase: "takeoff" });
    expect(takeoff!.input.buttons & InputButtons.JUMP).not.toBe(0);
    expect(takeoff!.input.yaw).toBeCloseTo(Math.PI / 2, 6);
    expect(runtime.isCommitted(state.tick + 4)).toBe(true);

    state.tick = 15;
    state.self.isGrounded = false;
    state.self.position = { x: 45, y: 70, z: 0 };
    const airborne = runtime.tick(context);
    expect(airborne).toMatchObject({ status: "running", phase: "airborne" });
    expect(airborne!.input.buttons & InputButtons.JUMP).toBe(0);

    state.tick = 45;
    state.self.isGrounded = true;
    state.self.position = { x: 105, y: 25, z: 0 };
    expect(runtime.tick(context)).toMatchObject({ status: "succeeded", phase: "landing" });
    expect(runtime.isActive).toBe(false);
  });

  it("reports a deterministic failure when landing outside the envelope", () => {
    const { state, runtime, context } = makeHarness();
    runtime.tick(context);

    state.tick = 15;
    state.self.isGrounded = false;
    runtime.tick(context);

    state.tick = 40;
    state.self.isGrounded = true;
    state.self.position = { x: 240, y: 25, z: 0 };
    expect(runtime.tick(context)).toMatchObject({
      status: "failed",
      phase: "landing",
      reason: "missed_landing",
    });
  });
});
