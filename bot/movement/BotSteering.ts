/**
 * Steering for a bot: the after-steps that keep its feet clear of walls,
 * corners and ledges (BotVisionTracer, or the feelers in head-to-head tests),
 * fly a pad's throw or turn a flight off a wall, and take the climbs and wall
 * jumps the tracer finds on the way to the point the bot makes for. They turn
 * the move yaw and press keys; the view stays where the decision put it.
 * What this needs of the brain comes through SteeringHost.
 */

import type { BotInput } from "../BotBrain";
import { BotState, travelYaw } from "../BotBrain";
import { InputButtons } from "../BotConfig";
import type { BotGameState, Vec3 } from "../BotGameState";
import type { BotLife } from "../BotLife";
import type { BotVision } from "../BotVision";
import { BotVisionTracer, wallAheadSide } from "../BotVisionTracer";
import { sideTurnAngle } from "../sequences/RouteStrafeJumpSequence";

/** A move to a point this much lower than the bot means to drop off an edge, units. */
const STEER_DROP_HEIGHT = 40;
/** Rising faster than any jump, units/s: a jump pad has thrown the bot. */
const PAD_LAUNCH_SPEED = 450;
/** After a climbing jump, forward is held toward the target this long, for the ledge grab, ticks. */
const CLIMB_HOLD_TICKS = 90;
/** A target this much higher than the bot, behind something in the way, is worth a climb. */
const CLIMB_RISE = 30;
/** Climbs are looked for toward targets at most this far off, units. */
const CLIMB_REACH = 500;
/** The way ahead counts as in the way below this much clear run. */
const CLIMB_BLOCKED = 0.7;
/** A climb or wall jump is checked at most this often, ticks: each check runs the movement forward. */
const TRICK_CHECK_TICKS = 20;
/** A wall this near the hull is one to wall jump from, units. */
const WALL_JUMP_NEAR = 12;
const WALL_JUMP_CHECK_TICKS = 6;
/** A wall jump is taken when it ends at least this much nearer the target than not jumping, units. */
const WALL_JUMP_GAIN = 96;
const FEELER_FORWARD_DIST = 300; // Forward ray distance
const FEELER_SIDE_ANGLE = Math.PI / 6; // 30° offset for side rays
const FEELER_SIDE_DIST = 200; // Side ray distance
const FEELER_STEER_THRESHOLD = 0.6; // fraction below which we steer away
/** A wall ahead keeps the bot turning the side it chose for this long. */
const FEELER_SIDE_COMMIT_TICKS = 50;

/** What steering needs of the brain. */
export interface SteeringHost {
  readonly life: BotLife;
  readonly currentState: BotState;
  /** A traversal sequence is running. */
  readonly sequenceActive: boolean;
  /** This decision's movement follows the route's line. */
  readonly onRouteLine: boolean;
  /** The side the bot strafes to, 1 or -1. */
  readonly strafeDirection: number;
}

export class BotSteering {
  constructor(private readonly host: SteeringHost) {}

  /** A new decision: nothing steered yet, and no point to make for. */
  begin(): void {
    this.steered = false;
    this.target = null;
    this.clear = 1;
  }

  /** Whether the feelers turned this decision's heading. */
  steered = false;

  /** Keeps the feet clear of walls in every state (BotVisionTracer), made per collision world. */
  tracer: BotVisionTracer | null = null;

  tracerWorld: unknown = null;

  /** The point this decision's movement makes for, when it has one: the tracer looks no further. */
  target: Vec3 | null = null;

  /** How clear the way ahead ran on the last steer, 0..1. */
  clear = 1;

  /** Next tick a climb or wall jump may be checked for; a climb under way holds forward to its target. */
  trickCheckTick = 0;

  /** A wall jump wants a fresh press: jump let go this decision, pressed on the next. */
  wallJumpPress = false;

  lastJumpHeld = false;

  /**
   * Turn the feet, not the view, onto the heading BotVisionTracer finds
   * clear. The keys stay as the decision chose them: the move yaw turns so
   * they carry the bot along the clear heading.
   */
  steer(input: BotInput, state: BotGameState, vision: BotVision): BotInput {
    const keys = input.direction;
    if (Math.hypot(keys.x, keys.z) < 0.01) return input;
    if (!this.tracer || this.tracerWorld !== vision.collisionWorld) {
      this.tracer = new BotVisionTracer(
        vision.collisionWorld,
        (vision.mapKnowledge?.triggerVolumes ?? []).filter((t) => t.type === "push" || t.type === "teleport"),
      );
      this.tracerWorld = vision.collisionWorld;
    }
    const keyTurn = Math.atan2(keys.x, keys.z);
    const moveYaw = travelYaw(input);
    const self = state.self;
    const target = this.target;
    const result = this.tracer.steer({
      tick: state.tick,
      position: self.position,
      velocity: self.velocity,
      grounded: self.isGrounded,
      yaw: moveYaw + keyTurn,
      onLine: this.host.onRouteLine,
      throughTriggers: this.routeUsesTrigger(),
      ...(target
        ? {
            targetDistance: Math.hypot(target.x - self.position.x, target.z - self.position.z),
            dropping: target.y < self.position.y - STEER_DROP_HEIGHT,
          }
        : {}),
    });
    if (!result) {
      if (self.isGrounded) {
        this.host.life.padRide = null;
        return input;
      }
      // Thrown by a pad with no sequence flying it (one the route did not mean to
      // use, or one whose traversal gave up): fly on to where it throws, until
      // down again. Its throw ends at the ledge it serves, and a bot that steers
      // back toward its own way falls onto the pad and is thrown again.
      if (!this.host.life.padRide && self.velocity.y > PAD_LAUNCH_SPEED && !this.host.sequenceActive) {
        const pad = this.padUnder(self.position, vision);
        if (pad) this.host.life.padRide = { dest: pad.dest };
      }
      if (this.host.life.padRide) {
        const dest = this.host.life.padRide.dest;
        const keep = InputButtons.FIRE | InputButtons.ALT_FIRE | InputButtons.CROUCH;
        return {
          ...input,
          direction: { x: 0, y: 0, z: 1 },
          moveYaw: Math.atan2(dest.x - self.position.x, dest.z - self.position.z),
          buttons: (input.buttons & keep) | InputButtons.FORWARD,
        };
      }
      return this.steerAir(input, state, vision);
    }
    this.clear = result.clear;
    if (result.turned) this.steered = true;
    return { ...input, moveYaw: result.yaw - keyTurn };
  }

  /**
   * Tricks the tracer says work from here (BotVisionTracer.climbByJump,
   * wallJumpGain), on the way to the point the bot makes for: a jump onto
   * what stands in the way when the point is above it, and a wall jump when
   * one ends nearer the point than falling on. Navigation only; a fight
   * moves for the fight.
   */
  tryTricks(state: BotGameState, input: BotInput): BotInput {
    const tracer = this.tracer;
    const self = state.self;
    const navigating =
      this.host.currentState === BotState.HUNT ||
      this.host.currentState === BotState.ITEM_RUN ||
      this.host.currentState === BotState.RETREAT ||
      this.host.currentState === BotState.CHASE;
    if (!tracer || !navigating || self.isDead) {
      this.host.life.climb = null;
      this.wallJumpPress = false;
      return input;
    }
    const toward = (target: Vec3) => Math.atan2(target.x - self.position.x, target.z - self.position.z);
    const forwardTo = (target: Vec3, jump: boolean): BotInput => ({
      ...input,
      direction: { x: 0, y: 0, z: 1 },
      moveYaw: toward(target),
      buttons:
        (input.buttons & ~(InputButtons.BACK | InputButtons.LEFT | InputButtons.RIGHT | InputButtons.CROUCH)) |
        InputButtons.FORWARD |
        (jump ? InputButtons.JUMP : 0),
    });

    // A climb under way: forward to its target until down again, for the ledge grab
    const climb = this.host.life.climb;
    if (climb) {
      if (state.tick > climb.untilTick || (self.isGrounded && state.tick > climb.untilTick - CLIMB_HOLD_TICKS + 10)) {
        this.host.life.climb = null;
      } else if (!self.isGrounded) {
        return forwardTo(climb.target, false);
      }
    }
    const target = this.target;
    if (!target) return input;

    if (self.isGrounded) {
      this.wallJumpPress = false;
      const rise = target.y - self.position.y;
      const far = Math.hypot(target.x - self.position.x, target.z - self.position.z);
      if (rise < CLIMB_RISE || far > CLIMB_REACH || this.clear >= CLIMB_BLOCKED) return input;
      if (state.tick < this.trickCheckTick) return input;
      this.trickCheckTick = state.tick + TRICK_CHECK_TICKS;
      const top = tracer.climbByJump(self.position, self.velocity, toward(target));
      if (!top || top.y < self.position.y + CLIMB_RISE) return input;
      this.host.life.climb = { target: { ...target }, untilTick: state.tick + CLIMB_HOLD_TICKS };
      return forwardTo(target, true);
    }

    // In the air beside a wall: press for a wall jump that ends nearer the target
    if (this.wallJumpPress) {
      this.wallJumpPress = false;
      return forwardTo(target, true);
    }
    if (state.tick < this.trickCheckTick || !tracer.wallWithin(self.position, WALL_JUMP_NEAR)) return input;
    this.trickCheckTick = state.tick + WALL_JUMP_CHECK_TICKS;
    const gain = tracer.wallJumpGain(self.position, self.velocity, toward(target), target);
    if (gain === null || gain < WALL_JUMP_GAIN) return input;
    // Jump held from the take-off would make this no fresh press: let go first
    if (this.lastJumpHeld) {
      this.wallJumpPress = true;
      return forwardTo(target, false);
    }
    return forwardTo(target, true);
  }

  /**
   * In the air, about to fly into a wall: a side key alone toward the open
   * side, at the angle that turns the flight without losing speed
   * (sideTurnAngle), instead of the keys the decision held. Jump, fire and
   * crouch stay as they were.
   */
  steerAir(input: BotInput, state: BotGameState, vision: BotVision): BotInput {
    const self = state.self;
    const side = wallAheadSide(vision.collisionWorld, self.position, self.velocity);
    if (side === 0) return input;
    this.steered = true;
    const speed = Math.hypot(self.velocity.x, self.velocity.z);
    const wish = Math.atan2(self.velocity.x, self.velocity.z) + side * sideTurnAngle(speed);
    const keep = InputButtons.JUMP | InputButtons.FIRE | InputButtons.ALT_FIRE | InputButtons.CROUCH;
    return {
      ...input,
      direction: { x: side, y: 0, z: 0 },
      // The key is a quarter turn off the move yaw
      moveYaw: wish - side * (Math.PI / 2),
      buttons: (input.buttons & keep) | (side < 0 ? InputButtons.LEFT : InputButtons.RIGHT),
    };
  }

  /** The jump pad at or just below `position` (the bot leaves it within a tick of the throw), or null. */
  padUnder(position: Vec3, vision: BotVision): { dest: Vec3 } | null {
    const pads = (vision.mapKnowledge?.triggerVolumes ?? []).filter((t) => t.type === "push");
    for (const pad of pads) {
      const inside =
        position.x >= pad.min.x - 32 &&
        position.x <= pad.max.x + 32 &&
        position.z >= pad.min.z - 32 &&
        position.z <= pad.max.z + 32 &&
        position.y >= pad.min.y - 32 &&
        position.y <= pad.max.y + 96;
      if (inside) return { dest: pad.dest };
    }
    return null;
  }

  /** Whether the route's current step goes to or through a jump pad or teleporter. */
  routeUsesTrigger(): boolean {
    const path = this.host.life.currentPath;
    const step = path?.steps[path.cursor];
    if (!step) return false;
    return (
      step.type === "jumppad" ||
      step.type === "teleporter" ||
      step.to.type === "jumppad" ||
      step.to.type === "teleporter"
    );
  }

  feelers(input: BotInput, state: BotGameState, vision: BotVision): BotInput {
    /**
     * Cast 3 rays from bot position to detect nearby walls.
     * If a wall is detected, steer the bot away from it.
     * Runs after brain decision and adjusts heading without overriding state.
     */

    const pos = state.self.position;
    const yaw = travelYaw(input);
    const cw = vision.collisionWorld;

    // Eye height offset
    const eyePos = { x: pos.x, y: pos.y + 36, z: pos.z };

    // Forward ray
    const fwdEnd = {
      x: eyePos.x + Math.sin(yaw) * FEELER_FORWARD_DIST,
      y: eyePos.y,
      z: eyePos.z + Math.cos(yaw) * FEELER_FORWARD_DIST,
    };
    const fwdResult = cw.trace(eyePos, fwdEnd);

    // Forward-left ray (yaw - 30°)
    const leftYaw = yaw - FEELER_SIDE_ANGLE;
    const leftEnd = {
      x: eyePos.x + Math.sin(leftYaw) * FEELER_SIDE_DIST,
      y: eyePos.y,
      z: eyePos.z + Math.cos(leftYaw) * FEELER_SIDE_DIST,
    };
    const leftResult = cw.trace(eyePos, leftEnd);

    // Forward-right ray (yaw + 30°)
    const rightYaw = yaw + FEELER_SIDE_ANGLE;
    const rightEnd = {
      x: eyePos.x + Math.sin(rightYaw) * FEELER_SIDE_DIST,
      y: eyePos.y,
      z: eyePos.z + Math.cos(rightYaw) * FEELER_SIDE_DIST,
    };
    const rightResult = cw.trace(eyePos, rightEnd);

    // Determine steering adjustment
    let yawAdjust = 0;
    const fwdBlocked = fwdResult.hit && fwdResult.fraction < FEELER_STEER_THRESHOLD;
    const leftBlocked = leftResult.hit && leftResult.fraction < FEELER_STEER_THRESHOLD;
    const rightBlocked = rightResult.hit && rightResult.fraction < FEELER_STEER_THRESHOLD;

    if (fwdBlocked) {
      // Wall directly ahead — steer toward open side
      if (leftBlocked && !rightBlocked) {
        yawAdjust = 0.5; // Turn right
      } else if (rightBlocked && !leftBlocked) {
        yawAdjust = -0.5; // Turn left
      } else if (leftBlocked && rightBlocked) {
        // Walled in on all sides — turn hard (pick random side)
        yawAdjust = this.host.strafeDirection > 0 ? 1.2 : -1.2;
      } else {
        // Forward blocked but sides open — steer toward more open side
        const leftDist = leftResult.fraction;
        const rightDist = rightResult.fraction;
        yawAdjust = leftDist > rightDist ? -0.4 : 0.4;
      }
      // Turning away changes what the rays see, and choosing again from the
      // new heading swung the bot left, right and left at the same wall.
      const side = this.host.life.feelerSide;
      const sideClosed = side && (side.sign > 0 ? rightBlocked && !leftBlocked : leftBlocked && !rightBlocked);
      if (side && state.tick < side.untilTick && !sideClosed) {
        yawAdjust = side.sign * Math.abs(yawAdjust);
      } else {
        this.host.life.feelerSide = { sign: Math.sign(yawAdjust), untilTick: state.tick + FEELER_SIDE_COMMIT_TICKS };
      }
    } else if (leftBlocked && !rightBlocked) {
      yawAdjust = 0.2; // Gentle right
    } else if (rightBlocked && !leftBlocked) {
      yawAdjust = -0.2; // Gentle left
    }

    if (yawAdjust !== 0) {
      this.steered = true;
      // Steer the heading; a bot looking ahead along its route keeps looking there.
      if (input.moveYaw !== undefined) input.moveYaw += yawAdjust;
      else input.yaw += yawAdjust;
    }

    return input;
  }
}
