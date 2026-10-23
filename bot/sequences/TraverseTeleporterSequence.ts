import type { BotInput } from "../BotBrain";
import { InputButtons } from "../BotConfig";
import type { Vec3 } from "../BotGameState";
import type { NavTriggerMetadata } from "../BotNavGraph";
import {
  type BotSequence,
  type BotSequenceContext,
  type BotSequenceState,
  type BotSequenceTick,
  steerToward,
} from "../BotSequence";

const TELEPORT_EXIT_LIFT = 25;
const EXIT_HORIZONTAL_TOLERANCE = 72;
const EXIT_VERTICAL_TOLERANCE = 72;
const ACTIVATION_CONFIRM_TICKS = 40;

/** Closer than this to where it is walking, keep the view: the bearing swings as the bot arrives. */
const HOLD_VIEW_WITHIN = 48;

function preciseForward(context: BotSequenceContext, target: Vec3, fallbackYaw?: number): BotInput {
  const self = context.state.self;
  return {
    direction: { x: 0, y: 0, z: 1 },
    pitch: self.pitch,
    ...steerToward({ position: self.position, yaw: fallbackYaw ?? self.yaw }, target, HOLD_VIEW_WITHIN),
    buttons: InputButtons.FORWARD | InputButtons.SPRINT,
    weaponSlot: 0,
  };
}

function triggerFrom(state: BotSequenceState): NavTriggerMetadata {
  return state.data.trigger as NavTriggerMetadata;
}
function triggerCenter(trigger: NavTriggerMetadata): Vec3 {
  return {
    x: (trigger.min.x + trigger.max.x) * 0.5,
    y: (trigger.min.y + trigger.max.y) * 0.5,
    z: (trigger.min.z + trigger.max.z) * 0.5,
  };
}

function overlapsTrigger(context: BotSequenceContext, trigger: NavTriggerMetadata): boolean {
  const position = context.state.self.position;
  const maxY = context.state.self.isCrouching ? 8 : 32;
  return (
    position.x - 16 <= trigger.max.x &&
    position.x + 16 >= trigger.min.x &&
    position.y - 24 <= trigger.max.y &&
    position.y + maxY >= trigger.min.y &&
    position.z - 16 <= trigger.max.z &&
    position.z + 16 >= trigger.min.z
  );
}

function reachedExit(position: Vec3, trigger: NavTriggerMetadata): boolean {
  return (
    Math.hypot(position.x - trigger.dest.x, position.z - trigger.dest.z) <= EXIT_HORIZONTAL_TOLERANCE &&
    Math.abs(position.y - (trigger.dest.y + TELEPORT_EXIT_LIFT)) <= EXIT_VERTICAL_TOLERANCE
  );
}

/** Approaches an authored teleporter and verifies the non-local exit snapshot. */
export class TraverseTeleporterSequence implements BotSequence {
  readonly id = "nav_traverse_teleporter";
  readonly tags = ["navigation", "movement", "teleporter"] as const;
  readonly maxTicks = 220;

  score(context: BotSequenceContext): number | null {
    return context.navStep?.type === "teleporter" && context.navStep.trigger ? 1200 : null;
  }

  start(context: BotSequenceContext): BotSequenceState {
    const trigger = context.navStep?.trigger;
    if (!trigger) throw new Error("TraverseTeleporterSequence requires trigger metadata");
    return {
      phase: "approach",
      startedTick: context.state.tick,
      phaseStartedTick: context.state.tick,
      commitUntilTick: context.state.tick,
      data: {
        trigger,
        enteredTick: null,
      },
    };
  }

  tick(context: BotSequenceContext, state: BotSequenceState): BotSequenceTick {
    const trigger = triggerFrom(state);
    const self = context.state.self;
    const exitYaw = trigger.destYaw ?? self.yaw;
    const source = triggerCenter(trigger);
    const exitInput = preciseForward(
      context,
      {
        x: trigger.dest.x + Math.sin(exitYaw) * 64,
        y: trigger.dest.y + TELEPORT_EXIT_LIFT,
        z: trigger.dest.z + Math.cos(exitYaw) * 64,
      },
      exitYaw,
    );

    if (reachedExit(self.position, trigger)) {
      return { input: exitInput, status: "succeeded", phase: "exit_verified" };
    }

    const enteredTick = state.data.enteredTick as number | null;
    if (enteredTick !== null) {
      if (context.state.tick - enteredTick >= ACTIVATION_CONFIRM_TICKS) {
        return {
          input: preciseForward(context, source),
          status: "failed",
          phase: "activate",
          reason: "teleport_not_confirmed",
        };
      }
      return {
        input: preciseForward(context, source),
        status: "running",
        phase: "activate",
        commitForTicks: ACTIVATION_CONFIRM_TICKS,
      };
    }

    if (overlapsTrigger(context, trigger)) {
      state.data.enteredTick = context.state.tick;
      return {
        input: preciseForward(context, source),
        status: "running",
        phase: "activate",
        commitForTicks: ACTIVATION_CONFIRM_TICKS,
      };
    }

    return {
      input: preciseForward(context, source),
      status: "running",
      phase: "approach",
    };
  }
}
