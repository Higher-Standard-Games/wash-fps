import type { BotInput } from "../BotBrain";
import { InputButtons } from "../BotConfig";
import type { Vec3 } from "../BotGameState";
import { PHYSICS } from "../BotMovementProfile";
import type { BotSequence, BotSequenceContext, BotSequenceState, BotSequenceTick } from "../BotSequence";

const SLIDE_CONFIRM_TICKS = 20;
const RELEASE_DISTANCE = 190;
const PICKUP_CONFIRM_DISTANCE = 176;
const MISSED_DISTANCE_GROWTH = 96;

function distanceXZ(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
}

function pickupIsActive(context: BotSequenceContext, pickupId: number): boolean {
  return context.state.pickupActiveMask[pickupId] === true;
}

function targetInput(context: BotSequenceContext, state: BotSequenceState, sliding: boolean): BotInput {
  const target = state.data.target as Vec3;
  const deltaX = target.x - context.state.self.position.x;
  const deltaZ = target.z - context.state.self.position.z;
  const yaw = Math.hypot(deltaX, deltaZ) > 0.001 ? Math.atan2(deltaX, deltaZ) : context.state.self.yaw;
  return {
    direction: { x: 0, y: 0, z: 1 },
    pitch: 0,
    yaw,
    buttons: InputButtons.FORWARD | InputButtons.SPRINT | (sliding ? InputButtons.CROUCH : 0),
    weaponSlot: 0,
  };
}

function canOwnInput(context: BotSequenceContext): boolean {
  const input = context.proposedInput;
  const target = context.itemSlideTarget;
  const self = context.state.self;
  if (!input || !target || !context.itemSlideReady || !self.isGrounded || self.isSliding) return false;
  if (!pickupIsActive(context, target.pickupId)) return false;

  const required = InputButtons.FORWARD | InputButtons.SPRINT;
  const disallowed =
    InputButtons.BACK | InputButtons.CROUCH | InputButtons.JUMP | InputButtons.FIRE | InputButtons.ALT_FIRE;
  if ((input.buttons & required) !== required || (input.buttons & disallowed) !== 0) return false;

  return Math.hypot(self.velocity.x, self.velocity.z) >= PHYSICS.SLIDE_MIN_SPEED;
}

/**
 * Straight final-lane pickup approach. Collection is confirmed only by the
 * authoritative pickup mask; distance is used solely to classify the result.
 */
export class ItemSlideApproachSequence implements BotSequence {
  readonly id = "item_slide_approach";
  readonly tags = ["navigation", "movement", "crouchslide", "pickup"] as const;
  readonly maxTicks = 180;

  score(context: BotSequenceContext): number | null {
    if (!canOwnInput(context)) return null;
    return 650;
  }

  start(context: BotSequenceContext): BotSequenceState {
    const target = context.itemSlideTarget;
    if (!target) throw new Error("ItemSlideApproachSequence requires a pickup target");
    const distance = distanceXZ(context.state.self.position, target.position);
    return {
      phase: "engage",
      startedTick: context.state.tick,
      phaseStartedTick: context.state.tick,
      commitUntilTick: context.state.tick,
      data: {
        pickupId: target.pickupId,
        target: { ...target.position },
        minimumDistance: distance,
        slideConfirmed: context.state.self.isSliding,
        released: false,
      },
    };
  }

  tick(context: BotSequenceContext, state: BotSequenceState): BotSequenceTick {
    const pickupId = state.data.pickupId as number;
    const target = state.data.target as Vec3;
    const distance = distanceXZ(context.state.self.position, target);
    const minimumDistance = Math.min(state.data.minimumDistance as number, distance);
    state.data.minimumDistance = minimumDistance;

    if (!pickupIsActive(context, pickupId)) {
      const collected = minimumDistance <= PICKUP_CONFIRM_DISTANCE;
      return {
        input: targetInput(context, state, false),
        status: collected ? "succeeded" : "failed",
        phase: collected ? "collected" : "unavailable",
        reason: collected ? undefined : "pickup_unavailable",
      };
    }

    if (minimumDistance <= PICKUP_CONFIRM_DISTANCE && distance > minimumDistance + MISSED_DISTANCE_GROWTH) {
      return {
        input: targetInput(context, state, false),
        status: "failed",
        phase: "missed",
        reason: "pickup_missed",
      };
    }

    if (context.state.self.isSliding) {
      state.data.slideConfirmed = true;
    }

    if (state.phase === "engage" && !context.state.self.isSliding) {
      if (context.state.tick - state.startedTick >= SLIDE_CONFIRM_TICKS) {
        return {
          input: targetInput(context, state, false),
          status: "failed",
          phase: "engage",
          reason: "slide_not_confirmed",
        };
      }
      return {
        input: targetInput(context, state, true),
        status: "running",
        phase: "engage",
      };
    }

    if (distance <= RELEASE_DISTANCE) state.data.released = true;
    if (state.data.released === true) {
      return {
        input: targetInput(context, state, false),
        status: "running",
        phase: "collect",
      };
    }

    if (state.data.slideConfirmed === true && !context.state.self.isSliding) {
      return {
        input: targetInput(context, state, false),
        status: "failed",
        phase: "slide",
        reason: "slide_ended_early",
      };
    }

    return {
      input: targetInput(context, state, true),
      status: "running",
      phase: "slide",
    };
  }
}
