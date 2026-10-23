import { describe, expect, it } from "vitest";
import type { BotInput } from "../BotBrain";
import { InputButtons } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import { BotSequenceRegistry, BotSequenceRuntime } from "../BotSequence";
import { ItemSlideApproachSequence } from "../sequences/ItemSlideApproachSequence";

const proposedInput: BotInput = {
  direction: { x: 0, y: 0, z: 1 },
  pitch: 0,
  yaw: 0,
  buttons: InputButtons.FORWARD | InputButtons.SPRINT,
  weaponSlot: 0,
};

function makeHarness() {
  const state = new BotGameState();
  state.tick = 100;
  state.self.position = { x: 0, y: 0, z: 0 };
  state.self.velocity = { x: 0, y: 0, z: 420 };
  state.self.isGrounded = true;
  state.pickupActiveMask = [false, false, false, true];

  const registry = new BotSequenceRegistry();
  registry.register(new ItemSlideApproachSequence());
  const runtime = new BotSequenceRuntime(registry);
  const context = {
    state,
    proposedInput,
    itemSlideReady: true,
    itemSlideTarget: { pickupId: 3, position: { x: 0, y: 0, z: 400 } },
  };
  return { state, runtime, context };
}

describe("ItemSlideApproachSequence", () => {
  it("releases into precise movement and confirms collection from the pickup mask", () => {
    const { state, runtime, context } = makeHarness();
    expect(runtime.startBest(context)).toBe(true);

    const engage = runtime.tick(context);
    expect(engage).toMatchObject({ status: "running", phase: "engage" });
    expect(engage!.input.buttons & InputButtons.CROUCH).not.toBe(0);

    state.tick = 105;
    state.self.position.z = 100;
    state.self.isSliding = true;
    expect(runtime.tick(context)).toMatchObject({ status: "running", phase: "slide" });

    state.tick = 120;
    state.self.position.z = 230;
    const collect = runtime.tick(context);
    expect(collect).toMatchObject({ status: "running", phase: "collect" });
    expect(collect!.input.buttons & InputButtons.CROUCH).toBe(0);
    expect(collect!.input.buttons & InputButtons.SPRINT).not.toBe(0);

    state.tick = 125;
    state.self.position.z = 285;
    state.self.isSliding = false;
    state.pickupActiveMask = [false, false, false, false];
    expect(runtime.tick(context)).toMatchObject({ status: "succeeded", phase: "collected" });
  });

  it("distinguishes a pickup taken elsewhere from a nearby collection", () => {
    const { state, runtime, context } = makeHarness();
    expect(runtime.startBest(context)).toBe(true);
    runtime.tick(context);

    state.tick = 105;
    state.self.position.z = 20;
    state.pickupActiveMask = [false, false, false, false];
    expect(runtime.tick(context)).toMatchObject({
      status: "failed",
      phase: "unavailable",
      reason: "pickup_unavailable",
    });
  });

  it("fails after passing through an active pickup without collecting it", () => {
    const { state, runtime, context } = makeHarness();
    expect(runtime.startBest(context)).toBe(true);
    runtime.tick(context);

    state.tick = 105;
    state.self.isSliding = true;
    state.self.position.z = 250;
    runtime.tick(context);

    state.tick = 125;
    state.self.position.z = 700;
    expect(runtime.tick(context)).toMatchObject({
      status: "failed",
      phase: "missed",
      reason: "pickup_missed",
    });
  });

  it("rejects stale targets and attack inputs", () => {
    const sequence = new ItemSlideApproachSequence();
    const { state, context } = makeHarness();
    state.pickupActiveMask = [false, false, false, false];
    expect(sequence.score(context)).toBeNull();

    state.pickupActiveMask = [false, false, false, true];
    expect(
      sequence.score({
        ...context,
        proposedInput: { ...proposedInput, buttons: proposedInput.buttons | InputButtons.FIRE },
      }),
    ).toBeNull();
  });
});
