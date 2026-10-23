import type { BotSequence, BotSequenceContext, BotSequenceState, BotSequenceTick } from "../BotSequence";
import type { LedgeSlideJumpPlan } from "../LedgeSlideJump";

/** Runs a proven per-tick slide/edge/boost script, then verifies the live landing. */
export class LedgeSlideJumpSequence implements BotSequence {
  readonly id = "ledge_slide_jump";
  readonly tags = ["navigation", "movement", "slide_jump"] as const;
  readonly maxTicks = 190;

  score(context: BotSequenceContext): number | null {
    return context.ledgeSlidePlan ? 800 : null;
  }

  start(context: BotSequenceContext): BotSequenceState {
    if (!context.ledgeSlidePlan) throw new Error("Slide/ledge jump requires a validated plan");
    return {
      phase: "execute",
      startedTick: context.state.tick,
      phaseStartedTick: context.state.tick,
      commitUntilTick: context.state.tick + context.ledgeSlidePlan.inputs.length,
      data: { plan: context.ledgeSlidePlan, sent: false },
    };
  }

  tick(context: BotSequenceContext, state: BotSequenceState): BotSequenceTick {
    const plan = state.data.plan as LedgeSlideJumpPlan;
    const elapsed = context.state.tick - state.startedTick;
    const input = { ...plan.inputs.at(-1)!, direction: { x: 0, y: 0, z: 1 } };
    if (!state.data.sent) {
      state.data.sent = true;
      return { input: { ...plan.inputs[0], script: plan.inputs }, status: "running", phase: "execute" };
    }
    const self = context.state.self;
    if (
      elapsed >= plan.inputs.length / 2 &&
      self.isGrounded &&
      Math.hypot(self.position.x - plan.landing.x, self.position.z - plan.landing.z) <= 96 &&
      Math.abs(self.position.y - plan.landing.y) <= 64
    )
      return { input, status: "succeeded", phase: "landed" };
    if (elapsed > plan.inputs.length + 24)
      return { input, status: "failed", phase: "execute", reason: "missed_boost_landing" };
    return { input, status: "running", phase: "execute" };
  }
}
