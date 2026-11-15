import { calcAccelFalloff } from "../../simulation/Acceleration";
import { DEFAULT_FPS_MOVEMENT_CONFIG } from "../../simulation/MovementProfile";
import { type BotInput, travelYaw } from "../BotBrain";
import { InputButtons } from "../BotConfig";
import type { Vec3 } from "../BotGameState";
import type {
  BotSequence,
  BotSequenceContext,
  BotSequenceState,
  BotSequenceTick,
  RouteStrafeLane,
} from "../BotSequence";
import { wallAheadSide } from "../BotVisionTracer";

const SERVER_TICK_RATE = 125;
const MOVEMENT = DEFAULT_FPS_MOVEMENT_CONFIG;
const TAKEOFF_CONFIRM_TICKS = 18;
const TAKEOFF_COMMIT_TICKS = 10;
/** Walking pace: a hop off it already gains speed. */
const MIN_ENTRY_SPEED = 320;
const MIN_CONTROL_SPEED = 160;
const ENDPOINT_EXIT_DISTANCE = 260;
const MIN_ROUTE_ERROR_FOR_SIDE = 0.025;
/** Air acceleration falls off from this speed (Acceleration.ts `radicalSpeed`). */
const RADICAL_SPEED = 600;
/** Heading error past which a hop turns with a side key alone instead of gaining speed, radians. */
const STEER_ERROR = 0.35;
/**
 * The most a forward-only wish leads the velocity, radians. Forward alone
 * pulls the velocity round toward the wish, and costs speed the further it
 * leads: 10° turns 30° for 3% of the speed, 60° for a quarter of it.
 */
const MAX_FORWARD_LEAD = 0.17;
/** Strafe acceleration with a side key alone (Acceleration.ts STRAFE_BUNNY_ACCEL). */
const SIDE_ACCEL = 50;
/** A straight hop aims back at its line over this distance ahead, units. */
const LINE_RETURN_DISTANCE = 300;
/** How far off the best gain angle the least skilled strafer holds, radians. */
const UNSKILLED_ANGLE_ERROR = 0.35;
/** A bot that lands and does not take off again within this many ticks has stopped hopping. */
const LANDED_GROUND_TICKS = 3;
/** Room past a hop's landing a chain keeps before the end of its stretch, units. */
const CHAIN_MARGIN = 64;
/** Seconds in the air for a hop off flat ground: up at jump speed, down under the heavier falling gravity. */
const HOP_SECONDS =
  MOVEMENT.jumpVelocity / MOVEMENT.gravity +
  Math.sqrt(
    (MOVEMENT.jumpVelocity * MOVEMENT.jumpVelocity) /
      MOVEMENT.gravity /
      (MOVEMENT.gravity * MOVEMENT.fallingGravityMultiplier),
  );

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

/**
 * The angle between wish and velocity that gains the most speed with forward
 * and a side key held, where air acceleration adds a fixed step toward the
 * wish until the speed along it reaches the strafe speed: the wish just far
 * enough round that the whole step is added.
 */
export function strafeGainAngle(speed: number): number {
  const falloff = calcAccelFalloff(speed, MOVEMENT.runSpeed, RADICAL_SPEED, MOVEMENT.topSpeed);
  const step = (MOVEMENT.airAcceleration * MOVEMENT.maxSpeed * falloff) / SERVER_TICK_RATE;
  return Math.acos(Math.max(-1, Math.min(1, (MOVEMENT.maxSpeed - step) / Math.max(1, speed))));
}

function chooseSide(routeError: number, fallback: -1 | 1): -1 | 1 {
  if (Math.abs(routeError) >= MIN_ROUTE_ERROR_FOR_SIDE) return routeError < 0 ? -1 : 1;
  return fallback;
}

/** The heading the hop makes for: along the route line, or back onto the straight lane it started on. */
function aimYaw(context: BotSequenceContext, state: BotSequenceState): number {
  const self = context.state.self.position;
  const steer = state.data.steer as ((at: Vec3) => number) | null;
  if (steer) return steer(self);
  const routeYaw = state.data.routeYaw as number;
  const start = state.data.startPosition as Vec3;
  const right = (self.x - start.x) * Math.cos(routeYaw) - (self.z - start.z) * Math.sin(routeYaw);
  return routeYaw - Math.atan2(right, LINE_RETURN_DISTANCE);
}

/**
 * The angle between wish and velocity for a side key alone: the wish just
 * under the strafe speed along it, nearly square to the velocity, which turns
 * the velocity fast without losing speed.
 */
export function sideTurnAngle(speed: number): number {
  const falloff = calcAccelFalloff(speed, MOVEMENT.runSpeed, RADICAL_SPEED, MOVEMENT.topSpeed);
  const step = (SIDE_ACCEL * falloff) / SERVER_TICK_RATE;
  const along = MOVEMENT.maxAirSpeed * Math.max(0, 1 - step);
  return Math.acos(Math.max(-1, Math.min(1, along / Math.max(1, speed))));
}

/**
 * One tick of air control. Forward and a side key accelerate, the wish at the
 * gain angle on the hop's side. A side key alone turns the velocity when the
 * heading is off; forward alone, its wish a little ahead of the velocity,
 * holds the speed once it is at the target and lines the hop up at the end of
 * its stretch. Jump stays held so a landing hops again.
 */
function strafeInput(context: BotSequenceContext, state: BotSequenceState, steerOnly = false): BotInput {
  const self = context.state.self;
  const speed = Math.max(MIN_CONTROL_SPEED, horizontalSpeed(self.velocity));
  const routeYaw = state.data.routeYaw as number;
  const velocityYaw = heading(self.velocity, routeYaw);
  // A wall coming up outranks the route: turn off it with the side key alone
  const world = context.vision?.collisionWorld;
  const wall = world ? wallAheadSide(world, self.position, self.velocity) : 0;
  const aim = aimYaw(context, state);
  const error = wall !== 0 ? wall * (Math.PI / 2) : normalizeAngle(aim - velocityYaw);
  const skill = context.difficulty?.strafeJumpSkill ?? 0;

  let moveYaw: number;
  let input: Pick<BotInput, "direction" | "buttons">;
  if (Math.abs(error) > STEER_ERROR) {
    const side = error < 0 ? -1 : 1;
    // The key is a quarter turn off the move yaw
    moveYaw = velocityYaw + side * sideTurnAngle(speed) - side * (Math.PI / 2);
    input = {
      direction: { x: side, y: 0, z: 0 },
      buttons: InputButtons.JUMP | (side < 0 ? InputButtons.LEFT : InputButtons.RIGHT),
    };
  } else if (steerOnly || speed >= (state.data.targetSpeed as number)) {
    moveYaw = velocityYaw + Math.sign(error) * Math.min(Math.abs(error), MAX_FORWARD_LEAD);
    input = { direction: { x: 0, y: 0, z: 1 }, buttons: InputButtons.JUMP | InputButtons.FORWARD };
  } else {
    const side = state.data.side as -1 | 1;
    const angle = strafeGainAngle(speed) + (1 - skill) * UNSKILLED_ANGLE_ERROR;
    // Keys are forward and one side, so the wish is an eighth turn off the move yaw
    moveYaw = velocityYaw + side * angle - side * (Math.PI / 4);
    input = {
      direction: { x: side * Math.SQRT1_2, y: 0, z: Math.SQRT1_2 },
      buttons: InputButtons.JUMP | InputButtons.FORWARD | (side < 0 ? InputButtons.LEFT : InputButtons.RIGHT),
    };
  }

  // The view follows the route at the skill's turn rate; the keys, not the
  // view, set the wish, so it need not swing with every change of side.
  const lastTick = state.data.lastTick as number;
  const elapsedTicks = Math.max(1, context.state.tick - lastTick);
  const maxTurnRate = 2.5 + skill * 4.5;
  const fromYaw = (state.data.lastYaw as number | undefined) ?? routeYaw;
  const yaw = clampTurn(fromYaw, aim, (maxTurnRate * elapsedTicks) / SERVER_TICK_RATE);
  state.data.lastTick = context.state.tick;
  state.data.lastYaw = yaw;

  return { ...input, pitch: 0, yaw, moveYaw, weaponSlot: 0 };
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

  return horizontalSpeed(self.velocity) >= MIN_ENTRY_SPEED;
}

/** Take a new stretch of route for the next hop of the chain. */
function takeLane(context: BotSequenceContext, state: BotSequenceState, lane: RouteStrafeLane): void {
  const self = context.state.self;
  state.data.routeYaw = lane.routeStrafeYaw;
  state.data.routeEnd = { ...lane.routeStrafeEnd };
  state.data.steer = lane.routeStrafeSteer;
  state.data.offLine = lane.routeStrafeOffLine;
  state.data.startPosition = { ...self.position };
  state.data.startSpeed = horizontalSpeed(self.velocity);
  const velocityYaw = heading(self.velocity, lane.routeStrafeYaw);
  const fallback = state.data.side === 1 ? -1 : 1;
  state.data.side = chooseSide(normalizeAngle(aimYaw(context, state) - velocityYaw), fallback);
}

/**
 * Optional route speed sequence: a chain of strafe jumps along an open
 * stretch of route. On each landing it asks the brain for the stretch ahead
 * (`routeStrafeNext`) and hops again with jump still held, so no tick is
 * lost to ground friction; without one, it lands and hands back.
 */
export class RouteStrafeJumpSequence implements BotSequence {
  readonly id = "route_strafe_jump";
  readonly tags = ["navigation", "movement", "strafejump"] as const;
  readonly maxTicks = 10 * SERVER_TICK_RATE;

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
      context.routeStrafeYaw ??
      (Math.hypot(routeDelta.x, routeDelta.z) > 0.001
        ? Math.atan2(routeDelta.x, routeDelta.z)
        : context.proposedInput
          ? travelYaw(context.proposedInput)
          : context.state.self.yaw);
    const skill = context.difficulty?.strafeJumpSkill ?? 0;

    const state: BotSequenceState = {
      phase: "takeoff",
      startedTick: context.state.tick,
      phaseStartedTick: context.state.tick,
      commitUntilTick: context.state.tick,
      data: {
        routeYaw,
        // The end of the open lane when the brain checked one, else the waypoint.
        routeEnd: { ...(context.routeStrafeEnd ?? step.to.position) },
        startPosition: { ...context.state.self.position },
        startSpeed: horizontalSpeed(context.state.self.velocity),
        targetSpeed: 360 + skill * 600,
        maxCrossTrack: 96 + skill * 64,
        side: context.routeStrafeSide ?? 1,
        steer: context.routeStrafeSteer ?? null,
        offLine: context.routeStrafeOffLine ?? null,
        next: context.routeStrafeNext ?? null,
        lastTick: context.state.tick,
        wasAirborne: false,
        landedTick: null,
        hops: 0,
      },
    };
    const velocityYaw = heading(context.state.self.velocity, routeYaw);
    const error = normalizeAngle(aimYaw(context, state) - velocityYaw);
    state.data.side = chooseSide(error, state.data.side as -1 | 1);
    return state;
  }

  tick(context: BotSequenceContext, state: BotSequenceState): BotSequenceTick {
    const self = context.state.self;
    const elapsed = context.state.tick - state.startedTick;

    if (state.phase === "takeoff") {
      if (!self.isGrounded) {
        state.data.wasAirborne = true;
        state.data.hops = 1;
        return { input: strafeInput(context, state), status: "running", phase: "airborne" };
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

    if (self.isGrounded) {
      const landedTick = (state.data.landedTick as number | null) ?? context.state.tick;
      state.data.landedTick = landedTick;
      // Jump held through the landing hops straight off it; still down after a
      // few ticks, the ground there would not let it (a slope, a ceiling).
      if (context.state.tick - landedTick >= LANDED_GROUND_TICKS) {
        return { input: routeForwardInput(state, false), status: "succeeded", phase: "landed" };
      }
      if (context.state.tick === landedTick) {
        const next = state.data.next as BotSequenceContext["routeStrafeNext"];
        const lane = next?.(context.state) ?? null;
        const room = horizontalSpeed(self.velocity) * HOP_SECONDS + CHAIN_MARGIN;
        const reach = lane
          ? Math.hypot(lane.routeStrafeEnd.x - self.position.x, lane.routeStrafeEnd.z - self.position.z)
          : 0;
        if (!lane || reach < room) {
          return { input: routeForwardInput(state, false), status: "succeeded", phase: "landed" };
        }
        takeLane(context, state, lane);
        state.data.hops = (state.data.hops as number) + 1;
      }
      return { input: strafeInput(context, state), status: "running", phase: "airborne" };
    }
    state.data.landedTick = null;

    const speed = horizontalSpeed(self.velocity);
    if (speed < MIN_CONTROL_SPEED || speed < (state.data.startSpeed as number) * 0.65) {
      return {
        input: routeForwardInput(state, false),
        status: "failed",
        phase: "airborne",
        reason: "lost_momentum",
      };
    }

    // Along a route line, measure the drift from the line; else from the
    // straight line the stretch started on.
    const offLine = state.data.offLine as ((at: Vec3) => number) | null;
    const start = state.data.startPosition as Vec3;
    const routeYaw = state.data.routeYaw as number;
    const crossTrack = offLine
      ? offLine(self.position)
      : Math.abs((self.position.x - start.x) * Math.cos(routeYaw) - (self.position.z - start.z) * Math.sin(routeYaw));
    if (crossTrack > (state.data.maxCrossTrack as number)) {
      return {
        input: routeForwardInput(state, false),
        status: "failed",
        phase: "airborne",
        reason: "route_deviation",
      };
    }

    // Near the end of its stretch the hop only steers, and the landing decides
    // whether there is route for another.
    const routeEnd = state.data.routeEnd as Vec3;
    const distanceToEnd = Math.hypot(routeEnd.x - self.position.x, routeEnd.z - self.position.z);
    const ending = distanceToEnd <= ENDPOINT_EXIT_DISTANCE;
    return { input: strafeInput(context, state, ending), status: "running", phase: ending ? "ending" : "airborne" };
  }
}
