import type { BotInput } from "../BotBrain";
import { InputButtons } from "../BotConfig";
import type { Vec3 } from "../BotGameState";
import type { MovementOpportunity } from "../BotMovementAnalyzer";
import type { BotSequence, BotSequenceContext, BotSequenceState, BotSequenceTick } from "../BotSequence";

const TAKEOFF_CONFIRM_TICKS = 12;
const MIN_SPEED_FACTOR = 0.9;
const VERTICAL_LANDING_TOLERANCE = 72;

function horizontalDistance(left: Vec3, right: Vec3): number {
  return Math.hypot(right.x - left.x, right.z - left.z);
}

function yawToward(from: Vec3, to: Vec3, fallback: number): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return Math.hypot(dx, dz) < 1 ? fallback : Math.atan2(dx, dz);
}

function movementInput(yaw: number, buttons: number): BotInput {
  return {
    direction: { x: 0, y: 0, z: 1 },
    pitch: 0,
    yaw,
    buttons,
    weaponSlot: 0,
  };
}

function opportunityFrom(state: BotSequenceState): MovementOpportunity {
  return state.data.opportunity as MovementOpportunity;
}

/** Executes an ordinary jump that was proven by BotMovementAnalyzer. */
export class ValidatedJumpSequence implements BotSequence {
  readonly id = "nav_validated_jump";
  readonly tags = ["navigation", "movement", "jump"] as const;
  readonly maxTicks = 220;

  score(context: BotSequenceContext): number | null {
    const step = context.navStep;
    const opportunity = context.movementOpportunity;
    if (
      step?.type !== "jump" ||
      !step.validated ||
      !step.opportunityId ||
      !opportunity ||
      opportunity.id !== step.opportunityId ||
      opportunity.kind !== "jump"
    ) {
      return null;
    }
    return 1000 + opportunity.successMargin;
  }

  start(context: BotSequenceContext): BotSequenceState {
    if (!context.movementOpportunity) {
      throw new Error("ValidatedJumpSequence requires a movement opportunity");
    }
    return {
      phase: "approach",
      startedTick: context.state.tick,
      phaseStartedTick: context.state.tick,
      commitUntilTick: context.state.tick,
      data: {
        opportunity: context.movementOpportunity,
        wasAirborne: false,
        launchTick: null,
      },
    };
  }

  tick(context: BotSequenceContext, state: BotSequenceState): BotSequenceTick {
    const opportunity = opportunityFrom(state);
    const self = context.state.self;
    const launchTick = state.data.launchTick as number | null;
    const wasAirborne = state.data.wasAirborne === true;
    const travelYaw = (opportunity.takeoff.yawRange[0] + opportunity.takeoff.yawRange[1]) * 0.5;
    const forwardButtons = InputButtons.FORWARD | InputButtons.SPRINT;

    if (launchTick !== null && context.state.tick - launchTick >= opportunity.inputPlan.maxTicks) {
      return {
        input: movementInput(travelYaw, forwardButtons),
        status: "failed",
        phase: state.phase,
        reason: "landing_timeout",
      };
    }

    if (wasAirborne && self.isGrounded) {
      const landingHorizontal = horizontalDistance(self.position, opportunity.landing.position);
      const landingVertical = Math.abs(self.position.y - opportunity.landing.position.y);
      const landed = landingHorizontal <= opportunity.landing.radius && landingVertical <= VERTICAL_LANDING_TOLERANCE;
      return {
        input: movementInput(travelYaw, forwardButtons),
        status: landed ? "succeeded" : "failed",
        phase: "landing",
        reason: landed ? undefined : "missed_landing",
      };
    }

    if (!self.isGrounded) {
      state.data.wasAirborne = true;
      return {
        input: movementInput(travelYaw, forwardButtons),
        status: "running",
        phase: "airborne",
      };
    }

    if (launchTick !== null) {
      if (context.state.tick - launchTick >= TAKEOFF_CONFIRM_TICKS) {
        return {
          input: movementInput(travelYaw, forwardButtons),
          status: "failed",
          phase: "takeoff",
          reason: "takeoff_not_confirmed",
        };
      }
      return {
        input: movementInput(travelYaw, opportunity.inputPlan.buttons),
        status: "running",
        phase: "takeoff",
        commitForTicks: TAKEOFF_CONFIRM_TICKS,
      };
    }

    const distanceToTakeoff = horizontalDistance(self.position, opportunity.takeoff.position);
    if (distanceToTakeoff > opportunity.takeoff.radius) {
      return {
        input: movementInput(yawToward(self.position, opportunity.takeoff.position, travelYaw), forwardButtons),
        status: "running",
        phase: "approach",
      };
    }

    const speed = Math.hypot(self.velocity.x, self.velocity.z);
    if (speed < opportunity.takeoff.minSpeed * MIN_SPEED_FACTOR) {
      return {
        input: movementInput(travelYaw, forwardButtons),
        status: "running",
        phase: "build_speed",
      };
    }

    state.data.launchTick = context.state.tick;
    return {
      input: movementInput(travelYaw, opportunity.inputPlan.buttons),
      status: "running",
      phase: "takeoff",
      commitForTicks: TAKEOFF_CONFIRM_TICKS,
    };
  }
}
