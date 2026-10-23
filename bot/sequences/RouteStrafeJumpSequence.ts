import { calcAccelFalloff, STRAFE_BUNNY_ACCEL } from "../../simulation/Acceleration";
import { type BotInput, travelYaw } from "../BotBrain";
import { InputButtons } from "../BotConfig";
import type { Vec3 } from "../BotGameState";
import { PHYSICS } from "../BotMovementProfile";
import type { BotSequence, BotSequenceContext, BotSequenceState, BotSequenceTick } from "../BotSequence";

const SERVER_TICK_RATE = 125;
const TAKEOFF_CONFIRM_TICKS = 18;
const TAKEOFF_COMMIT_TICKS = 10;
const MIN_ENTRY_SPEED = PHYSICS.SPRINT_SPEED;
const MIN_CONTROL_SPEED = 160;
const ENDPOINT_EXIT_DISTANCE = 260;
const MIN_ROUTE_ERROR_FOR_SIDE = 0.025;

function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function horizontalSpeed(velocity: Vec3): number {
  return Math.hypot(velocity.x, velocity.z);
}

function heading(velocity: Vec3, fallback: number): number {
  return horizontalSpeed(velocity) > 0.001 ? Math.atan2(velocity.x, velocity.z) : fallback;
}

function clampTurn(current: number, target: number, maxDelta: number): number {
  return normalizeAngle(current + Math.max(-maxDelta, Math.min(maxDelta, normalizeAngle(target - current))));
}

function routeForwardInput(state: BotSequenceState, jump: boolean): BotInput {
  return {
    direction: { x: 0, y: 0, z: 1 },
    pitch: 0,
    yaw: state.data.routeYaw as number,
    buttons: InputButtons.FORWARD | InputButtons.SPRINT | (jump ? InputButtons.JUMP : 0),
    weaponSlot: 0,
  };
}

function chooseSide(routeYaw: number, velocityYaw: number, fallback: -1 | 1): -1 | 1 {
  const routeError = normalizeAngle(routeYaw - velocityYaw);
  if (Math.abs(routeError) >= MIN_ROUTE_ERROR_FOR_SIDE) return routeError < 0 ? -1 : 1;
  return fallback;
}

function sideInput(context: BotSequenceContext, state: BotSequenceState): BotInput {
  const self = context.state.self;
  const speed = Math.max(MIN_CONTROL_SPEED, horizontalSpeed(self.velocity));
  const velocityYaw = heading(self.velocity, state.data.routeYaw as number);
  const side = chooseSide(state.data.routeYaw as number, velocityYaw, state.data.side as -1 | 1);
  state.data.side = side;

  // Leave exactly one authoritative acceleration step below the air-speed cap.
  // A projection at the cap would produce zero gain. BotInput is view-relative,
  // so derive the yaw that makes LEFT/RIGHT produce the desired world wish.
  const accelFalloff = calcAccelFalloff(speed, PHYSICS.SPRINT_SPEED, 600, PHYSICS.TOP_SPEED);
  const accelFractionPerTick = (STRAFE_BUNNY_ACCEL * accelFalloff) / SERVER_TICK_RATE;
  const targetProjection = PHYSICS.MAX_AIR_SPEED * Math.max(0, 1 - accelFractionPerTick);
  const ratio = Math.max(-1, Math.min(1, targetProjection / speed));
  const optimalYaw = velocityYaw - side * Math.asin(ratio);
  const lastTick = state.data.lastTick as number;
  const elapsedTicks = Math.max(1, context.state.tick - lastTick);
  const skill = context.difficulty?.strafeJumpSkill ?? 0;
  const maxTurnRate = 2.5 + skill * 4.5;
  // Turn from this hop's own last heading: the view the server reports lags
  // behind it while the client eases the turn.
  const fromYaw = (state.data.lastYaw as number | undefined) ?? (state.data.routeYaw as number);
  const yaw = clampTurn(fromYaw, optimalYaw, (maxTurnRate * elapsedTicks) / SERVER_TICK_RATE);
  state.data.lastTick = context.state.tick;
  state.data.lastYaw = yaw;

  return {
    direction: { x: side, y: 0, z: 0 },
    pitch: 0,
    yaw,
    buttons: InputButtons.JUMP | (side < 0 ? InputButtons.LEFT : InputButtons.RIGHT),
    weaponSlot: 0,
  };
}

function canOwnInput(context: BotSequenceContext): boolean {
  const input = context.proposedInput;
  const self = context.state.self;
  const skill = context.difficulty?.strafeJumpSkill ?? 0;
  if (!input || !context.routeStrafeReady || !self.isGrounded || self.isSliding || skill < 0.35) return false;

  const required = InputButtons.FORWARD | InputButtons.SPRINT;
  const disallowed =
    InputButtons.BACK |
    InputButtons.LEFT |
    InputButtons.RIGHT |
    InputButtons.CROUCH |
    InputButtons.FIRE |
    InputButtons.ALT_FIRE;
  if ((input.buttons & required) !== required || (input.buttons & disallowed) !== 0) return false;

  const step = context.navStep;
  if (step?.type !== "walk" || step.requiresPreciseApproach) return false;

  const speed = horizontalSpeed(self.velocity);
  const targetSpeed = 360 + skill * 600;
  return speed >= MIN_ENTRY_SPEED && speed < targetSpeed;
}

/**
 * Optional, one-hop route speed sequence. Safe repeated selection creates a
 * strafe-jump chain while route planning gets a chance to veto every hop.
 */
export class RouteStrafeJumpSequence implements BotSequence {
  readonly id = "route_strafe_jump";
  readonly tags = ["navigation", "movement", "strafejump"] as const;
  readonly maxTicks = 110;

  score(context: BotSequenceContext): number | null {
    if (!canOwnInput(context)) return null;
    const skill = context.difficulty?.strafeJumpSkill ?? 0;
    return 400 + skill * 80;
  }

  start(context: BotSequenceContext): BotSequenceState {
    const step = context.navStep;
    if (!step) throw new Error("RouteStrafeJumpSequence requires a route step");
    const routeDelta = {
      x: step.to.position.x - context.state.self.position.x,
      z: step.to.position.z - context.state.self.position.z,
    };
    const routeYaw =
      Math.hypot(routeDelta.x, routeDelta.z) > 0.001
        ? Math.atan2(routeDelta.x, routeDelta.z)
        : context.proposedInput
          ? travelYaw(context.proposedInput)
          : context.state.self.yaw;
    const skill = context.difficulty?.strafeJumpSkill ?? 0;

    return {
      phase: "takeoff",
      startedTick: context.state.tick,
      phaseStartedTick: context.state.tick,
      commitUntilTick: context.state.tick,
      data: {
        routeYaw,
        routeEnd: { ...step.to.position },
        startPosition: { ...context.state.self.position },
        startSpeed: horizontalSpeed(context.state.self.velocity),
        targetSpeed: 360 + skill * 600,
        maxCrossTrack: 96 + skill * 64,
        side: context.routeStrafeSide ?? 1,
        lastTick: context.state.tick,
        wasAirborne: false,
      },
    };
  }

  tick(context: BotSequenceContext, state: BotSequenceState): BotSequenceTick {
    const self = context.state.self;
    const elapsed = context.state.tick - state.startedTick;

    if (state.phase === "takeoff") {
      if (!self.isGrounded) {
        state.data.wasAirborne = true;
        return {
          input: sideInput(context, state),
          status: "running",
          phase: "airborne",
        };
      }
      if (elapsed >= TAKEOFF_CONFIRM_TICKS) {
        return {
          input: routeForwardInput(state, false),
          status: "failed",
          phase: "takeoff",
          reason: "jump_not_confirmed",
        };
      }
      return {
        input: routeForwardInput(state, true),
        status: "running",
        phase: "takeoff",
        commitForTicks: TAKEOFF_COMMIT_TICKS,
      };
    }

    if (state.data.wasAirborne === true && self.isGrounded) {
      return {
        input: routeForwardInput(state, false),
        status: "succeeded",
        phase: "landed",
      };
    }

    const speed = horizontalSpeed(self.velocity);
    if (speed < MIN_CONTROL_SPEED || speed < (state.data.startSpeed as number) * 0.65) {
      return {
        input: routeForwardInput(state, false),
        status: "failed",
        phase: "airborne",
        reason: "lost_momentum",
      };
    }

    const start = state.data.startPosition as Vec3;
    const displacement = {
      x: self.position.x - start.x,
      z: self.position.z - start.z,
    };
    const routeYaw = state.data.routeYaw as number;
    const crossTrack = Math.abs(displacement.x * Math.cos(routeYaw) - displacement.z * Math.sin(routeYaw));
    if (crossTrack > (state.data.maxCrossTrack as number)) {
      return {
        input: routeForwardInput(state, false),
        status: "failed",
        phase: "airborne",
        reason: "route_deviation",
      };
    }

    const routeEnd = state.data.routeEnd as Vec3;
    const distanceToEnd = Math.hypot(routeEnd.x - self.position.x, routeEnd.z - self.position.z);
    if (distanceToEnd <= ENDPOINT_EXIT_DISTANCE || speed >= (state.data.targetSpeed as number)) {
      return {
        input: routeForwardInput(state, true),
        status: "succeeded",
        phase: "exit",
      };
    }

    return {
      input: sideInput(context, state),
      status: "running",
      phase: "airborne",
    };
  }
}
