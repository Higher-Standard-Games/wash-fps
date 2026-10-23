import type { BotInput } from "../BotBrain";
import { InputButtons } from "../BotConfig";
import { PHYSICS } from "../BotMovementProfile";
import type { BotSequence, BotSequenceContext, BotSequenceState, BotSequenceTick } from "../BotSequence";

const SERVER_TICK_RATE = 125;
const SLIDE_CONFIRM_TICKS = 20;
const SLIDE_HOLD_TICKS = Math.ceil((PHYSICS.SLIDE_DURATION / 1000) * SERVER_TICK_RATE * 0.75);
const JUMP_CANCEL_CONFIRM_TICKS = 16;

function cloneInput(input: BotInput): BotInput {
  return {
    ...input,
    direction: { ...input.direction },
  };
}

function sequenceInput(state: BotSequenceState, buttons: number): BotInput {
  const input = cloneInput(state.data.input as BotInput);
  input.direction.x = 0;
  input.direction.z = 1;
  input.buttons = buttons;
  return input;
}

function canOwnInput(context: BotSequenceContext): boolean {
  const input = context.proposedInput;
  if (!input || !context.crouchslideReady || !context.state.self.isGrounded) return false;
  const disallowed = InputButtons.BACK | InputButtons.FIRE | InputButtons.ALT_FIRE;
  const required = InputButtons.FORWARD | InputButtons.SPRINT;
  if ((input.buttons & required) !== required || (input.buttons & disallowed) !== 0) return false;

  const step = context.navStep;
  if (!step) return true;
  return step.type === "walk" && !step.requiresPreciseApproach;
}

/**
 * Optional route-speed sequence. Unlike jump traversal, failure must not
 * invalidate the underlying walk edge: the bot can continue walking.
 */
export class RouteCrouchslideSequence implements BotSequence {
  readonly id = "route_crouchslide";
  readonly tags = ["navigation", "movement", "crouchslide"] as const;
  readonly maxTicks = 140;

  score(context: BotSequenceContext): number | null {
    if (!canOwnInput(context)) return null;
    const speed = Math.hypot(context.state.self.velocity.x, context.state.self.velocity.z);
    if (speed < PHYSICS.SLIDE_MIN_SPEED) return null;
    return 500 + Math.min(100, speed - PHYSICS.SLIDE_MIN_SPEED);
  }

  start(context: BotSequenceContext): BotSequenceState {
    if (!context.proposedInput) {
      throw new Error("RouteCrouchslideSequence requires proposed input");
    }
    return {
      phase: "engage",
      startedTick: context.state.tick,
      phaseStartedTick: context.state.tick,
      commitUntilTick: context.state.tick,
      data: {
        input: cloneInput(context.proposedInput),
        slideConfirmedTick: null,
        wasSliding: context.state.self.isSliding,
        jumpCancel: (context.difficulty?.strafeJumpSkill ?? 0) >= 0.55,
      },
    };
  }

  tick(context: BotSequenceContext, state: BotSequenceState): BotSequenceTick {
    const self = context.state.self;
    const elapsed = context.state.tick - state.startedTick;
    const forward = InputButtons.FORWARD | InputButtons.SPRINT;
    const sliding = forward | InputButtons.CROUCH;
    if (Math.hypot(self.velocity.x, self.velocity.z) < PHYSICS.SPRINT_SPEED) state.data.jumpCancel = false;
    const slideConfirmedTick = state.data.slideConfirmedTick as number | null;

    if (self.isSliding) {
      state.data.wasSliding = true;
      if (slideConfirmedTick === null) state.data.slideConfirmedTick = context.state.tick;
    }

    if (state.phase === "engage" && !self.isSliding) {
      if (elapsed >= SLIDE_CONFIRM_TICKS) {
        return {
          input: sequenceInput(state, forward),
          status: "failed",
          phase: "engage",
          reason: "slide_not_confirmed",
        };
      }
      return {
        input: sequenceInput(state, sliding),
        status: "running",
        phase: "engage",
      };
    }

    if (state.phase === "jump_cancel") {
      if (state.data.jumpCancel !== true)
        return { input: sequenceInput(state, forward), status: "succeeded", phase: "exit" };
      if (!self.isGrounded || !self.isSliding) {
        return {
          input: sequenceInput(state, forward | InputButtons.JUMP),
          status: "succeeded",
          phase: "exit",
        };
      }
      if (context.state.tick - state.phaseStartedTick >= JUMP_CANCEL_CONFIRM_TICKS) {
        return {
          input: sequenceInput(state, forward),
          status: "failed",
          phase: "jump_cancel",
          reason: "jump_cancel_not_confirmed",
        };
      }
      return {
        input: sequenceInput(state, forward | InputButtons.JUMP),
        status: "running",
        phase: "jump_cancel",
        commitForTicks: JUMP_CANCEL_CONFIRM_TICKS,
      };
    }

    if (state.data.wasSliding === true && !self.isSliding) {
      return {
        input: sequenceInput(state, forward),
        status: "succeeded",
        phase: "exit",
      };
    }

    const confirmedAt = (state.data.slideConfirmedTick as number | null) ?? context.state.tick;
    if (context.state.tick - confirmedAt >= SLIDE_HOLD_TICKS) {
      if (state.data.jumpCancel === true) {
        return {
          input: sequenceInput(state, forward | InputButtons.JUMP),
          status: "running",
          phase: "jump_cancel",
          commitForTicks: JUMP_CANCEL_CONFIRM_TICKS,
        };
      }
      return {
        input: sequenceInput(state, forward),
        status: "running",
        phase: "natural_exit",
      };
    }

    return {
      input: sequenceInput(state, sliding),
      status: "running",
      phase: "slide",
    };
  }
}
