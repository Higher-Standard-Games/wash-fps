/**
 * Traversal for a bot: the sequences that run a move the route or the moment
 * asks for (teleporters, jump pads, learned routes, validated jumps, slides,
 * strafe-jump chains, the lunge), and the checks that start the route's own
 * slides and hops. StateMachineBrain asks whether one is running, ticks it and
 * interrupts it; what this needs of the brain comes through TraversalHost.
 */

import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "../../../../shared/server/simulation/physics/constants";
import { wrapAngle } from "../BotAimController";
import type { BotInput } from "../BotBrain";
import { BotState, travelYaw } from "../BotBrain";
import type { BotDifficulty } from "../BotConfig";
import { InputButtons } from "../BotConfig";
import type { BotGameState, Vec3 } from "../BotGameState";
import { vec3Normalize, vec3Subtract } from "../BotGameState";
import type { BotLife } from "../BotLife";
import { canInitiateSlide, PHYSICS } from "../BotMovementProfile";
import type { BotNavGraph, NavPath, NavStep } from "../BotNavGraph";
import {
  BotSequenceRegistry,
  BotSequenceRuntime,
  type BotSequenceRuntimeTick,
  type RouteStrafeLane,
} from "../BotSequence";
import type { BotVision, VisionResult } from "../BotVision";
import type { BotVisionTracer } from "../BotVisionTracer";
import { planLedgeSlideJump } from "../LedgeSlideJump";
import { pointAlong } from "../RouteLine";
import { ItemSlideApproachSequence } from "../sequences/ItemSlideApproachSequence";
import { LearnedRouteSequence } from "../sequences/LearnedRouteSequence";
import { LedgeSlideJumpSequence } from "../sequences/LedgeSlideJumpSequence";
import { RouteCrouchslideSequence } from "../sequences/RouteCrouchslideSequence";
import { RouteStrafeJumpSequence } from "../sequences/RouteStrafeJumpSequence";
import { SlideBladeSequence } from "../sequences/SlideBladeSequence";
import { TraverseJumppadSequence } from "../sequences/TraverseJumppadSequence";
import { TraverseTeleporterSequence } from "../sequences/TraverseTeleporterSequence";
import { ValidatedJumpSequence } from "../sequences/ValidatedJumpSequence";
import type { BotNavigator, PathFollowResult } from "./BotNavigator";

export const PICKUP_FAILURE_COOLDOWN_TICKS = 625;
const ITEM_SLIDE_MAX_DISTANCE = 760;
const ITEM_SLIDE_MIN_DISTANCE = 260;
const ITEM_SLIDE_MAX_VELOCITY_ERROR_RADIANS = Math.PI / 6;
const ITEM_SLIDE_ALLY_RADIUS = 80;
const BOT_SLIDE_COOLDOWN_TICKS = Math.ceil((PHYSICS.SLIDE_COOLDOWN / 1000) * TICK_RATE);
/** How far a route slide carries the bot on the heading it starts with, units. */
const ROUTE_SLIDE_RUN = 320;
/** The slide's run plus the room to come out of it at speed, units. */
const ROUTE_SLIDE_REACH = 520;
/** Every waypoint inside a route slide's run lies within this of its line. */
const ROUTE_SLIDE_LANE = 64;
const ROUTE_STRAFE_REACH = 640;
/** The most a hop chain's stretch of route line may turn in all. */
const ROUTE_STRAFE_MAX_TURN = (120 * Math.PI) / 180;
/** A strafe jump needs a lane of route this long and wide, plain walking out to the reach. */
const ROUTE_STRAFE_RUN = 240;
const BOT_STRAFE_RETRY_TICKS = 30;
const ROUTE_STRAFE_ITEM_MIN_REMAINING_DISTANCE = 800;
/** Without a route line: a straight lane of route this long and wide, plain walking to the reach. */
const STRAIGHT_HOP_RUN = 480;
const STRAIGHT_HOP_REACH = 640;
const STRAIGHT_HOP_LANE = 96;
/** A strafe-jump chain starts from this speed: walking pace, since a hop off it already gains. */
const ROUTE_STRAFE_ENTRY_SPEED = 320;
const ROUTE_STRAFE_MAX_VELOCITY_ERROR_RADIANS = Math.PI / 4;
const ROUTE_STRAFE_ALLY_LOOKAHEAD = 600;
const ROUTE_STRAFE_ALLY_RADIUS = 80;
/** The hop sequence ends this far before its target (RouteStrafeJumpSequence ENDPOINT_EXIT_DISTANCE). */
const STRAIGHT_HOP_EXIT_MARGIN = 260;
/** A hop steers for the route line this far ahead of the bot, units. */
const ROUTE_STRAFE_STEER_AHEAD = 160;

/** What traversal needs of the brain. */
export interface TraversalHost {
  readonly life: BotLife;
  readonly navGraph: BotNavGraph | null;
  readonly vision: BotVision | null;
  readonly visionResult: VisionResult | null;
  readonly difficulty: BotDifficulty;
  readonly currentState: BotState;
  readonly tracer: BotVisionTracer | null;
  readonly nav: BotNavigator;
  /** The script being sent ends with this decision. */
  cancelScript(): void;
  /** `owner` moves exactly this decision: no correction or takeover of movement after it (InputClaims). */
  holdMovementExact(owner: string): void;
  startRecovery(state: BotGameState, stuck?: boolean): BotInput;
}

export class BotTraversal {
  constructor(private readonly host: TraversalHost) {
    this.registry.register(new RouteCrouchslideSequence());
    this.registry.register(new ValidatedJumpSequence());
    this.registry.register(new ItemSlideApproachSequence());
    this.registry.register(new TraverseTeleporterSequence());
    this.registry.register(new RouteStrafeJumpSequence());
    this.registry.register(new TraverseJumppadSequence());
    this.registry.register(new LearnedRouteSequence());
    this.registry.register(new SlideBladeSequence());
    this.registry.register(new LedgeSlideJumpSequence());
  }

  readonly registry = new BotSequenceRegistry();

  readonly runtime = new BotSequenceRuntime(this.registry);

  activeStep: NavStep | null = null;

  slideCooldownUntilTick: number = 0;

  routeStrafeCooldownUntilTick: number = 0;

  routeStrafeSide: -1 | 1 = 1;

  ledgeProbeTick = 0;

  context(
    state: BotGameState,
    step: NavStep | null = this.activeStep,
    proposedInput: BotInput | null = null,
    crouchslideReady: boolean = false,
    routeStrafeReady: boolean = false,
    routeStrafeSide: -1 | 1 = this.routeStrafeSide,
  ) {
    const opportunity =
      step?.opportunityId && this.host.navGraph ? this.host.navGraph.getMovementOpportunity(step.opportunityId) : null;
    return {
      state,
      vision: this.host.vision,
      visionResult: this.host.visionResult,
      navGraph: this.host.navGraph,
      navStep: step,
      movementOpportunity: opportunity,
      learnedRoute: this.host.navGraph?.getLearnedRoute(step?.opportunityId) ?? null,
      proposedInput,
      difficulty: this.host.difficulty,
      crouchslideReady,
      routeStrafeReady,
      routeStrafeSide,
      itemSlideTarget: this.host.life.activeItemSlideTarget,
      itemSlideReady: this.host.life.activeItemSlideTarget !== null,
    };
  }

  interrupt(state: BotGameState, reason: string, force: boolean = false): boolean {
    const interrupted = this.runtime.interrupt(this.context(state), reason, force);
    if (interrupted) {
      this.host.cancelScript();
      this.activeStep = null;
      this.host.life.activeItemSlideTarget = null;
    }
    return interrupted;
  }

  tick(state: BotGameState): BotInput | null {
    const result: BotSequenceRuntimeTick | null = this.runtime.tick(this.context(state));
    if (!result) return null;

    this.host.holdMovementExact(this.runtime.activeSequenceId ?? "sequence");
    this.host.nav.pathRecalcTimer = 0;
    if (result.status === "running") return result.input;
    this.host.cancelScript();

    const terminalItemTarget = this.host.life.activeItemSlideTarget;
    this.host.life.activeItemSlideTarget = null;
    if (result.sequenceId === "item_slide_approach" && terminalItemTarget) {
      if (result.status === "succeeded") {
        this.host.life.currentPath = null;
      } else if (result.reason === "pickup_missed" || result.reason === "timeout") {
        this.host.nav.blockedPickupIds.set(terminalItemTarget.pickupId, state.tick + PICKUP_FAILURE_COOLDOWN_TICKS);
        this.host.life.currentPath = null;
      }
      return null;
    }

    const terminalStep = this.activeStep;
    this.activeStep = null;
    this.host.nav.activeNavStep = null;
    if (result.status === "failed") {
      if (terminalStep) {
        this.host.nav.pathBlockedReason = `sequence:${result.sequenceId}:${result.reason ?? "failed"}`;
        this.host.nav.cooldownStep(terminalStep, state.tick);
        this.host.life.currentPath = null;
        return this.host.startRecovery(state);
      }
      return null;
    }
    return null;
  }

  startNav(state: BotGameState, step: NavStep, sequenceId: string): PathFollowResult | null {
    const context = this.context(state, step);
    if (!this.runtime.start(sequenceId, context)) return null;

    this.activeStep = step;
    const input = this.tick(state);
    if (this.host.nav.pathBlockedReason) return { status: "blocked", reason: this.host.nav.pathBlockedReason };
    return input ? { status: "moving", input } : { status: "complete" };
  }

  /** Slide only when a stable, active pickup closes a straight final walk lane. */
  tryStartItemSlideApproach(input: BotInput, state: BotGameState): BotInput | null {
    if (
      state.self.isDead ||
      this.runtime.isActive ||
      (this.host.currentState !== BotState.ITEM_RUN && this.host.currentState !== BotState.RETREAT) ||
      !state.self.isGrounded ||
      state.self.isSliding
    )
      return null;

    const required = InputButtons.FORWARD | InputButtons.SPRINT;
    const disallowed =
      InputButtons.BACK | InputButtons.CROUCH | InputButtons.JUMP | InputButtons.FIRE | InputButtons.ALT_FIRE;
    if ((input.buttons & required) !== required || (input.buttons & disallowed) !== 0) return null;

    const horizontalSpeed = Math.hypot(state.self.velocity.x, state.self.velocity.z);
    if (!canInitiateSlide(horizontalSpeed, state.tick >= this.slideCooldownUntilTick)) return null;

    const path = this.host.life.currentPath;
    const step = path?.steps[path.cursor] ?? null;
    const target = path?.nodes[path.nodes.length - 1] ?? null;
    if (!path || !step || !target || target.type !== "item" || target.pickupId === undefined) return null;
    if (step.type !== "walk" || path.cursor !== path.steps.length - 1) return null;
    if (state.pickupActiveMask[target.pickupId] !== true || this.host.nav.blockedPickupIds.has(target.pickupId))
      return null;

    const targetDelta = vec3Subtract(target.position, state.self.position);
    const targetDistance = Math.hypot(targetDelta.x, targetDelta.z);
    const maximumDistance = Math.min(
      ITEM_SLIDE_MAX_DISTANCE,
      horizontalSpeed * PHYSICS.SLIDE_SPEED_MULT * (PHYSICS.SLIDE_DURATION / 1000) + 120,
    );
    if (targetDistance < ITEM_SLIDE_MIN_DISTANCE || targetDistance > maximumDistance || Math.abs(targetDelta.y) > 96)
      return null;

    const targetDirection = vec3Normalize({ x: targetDelta.x, y: 0, z: targetDelta.z });
    if (horizontalSpeed > 0.001) {
      const velocityDot =
        (state.self.velocity.x * targetDirection.x + state.self.velocity.z * targetDirection.z) / horizontalSpeed;
      if (Math.acos(Math.max(-1, Math.min(1, velocityDot))) > ITEM_SLIDE_MAX_VELOCITY_ERROR_RADIANS) return null;
    }

    const allyBlocksLane = state.players.some((player) => {
      if (player.relation !== "ally" || player.isDead) return false;
      const relative = vec3Subtract(player.position, state.self.position);
      const along = relative.x * targetDirection.x + relative.z * targetDirection.z;
      const lateral = Math.abs(relative.x * targetDirection.z - relative.z * targetDirection.x);
      return Math.abs(relative.y) <= 96 && along > 0 && along < targetDistance && lateral < ITEM_SLIDE_ALLY_RADIUS;
    });
    if (allyBlocksLane) return null;

    this.host.life.activeItemSlideTarget = { pickupId: target.pickupId, position: { ...target.position } };
    const context = this.context(state, step, input);
    if (!this.runtime.start("item_slide_approach", context)) {
      this.host.life.activeItemSlideTarget = null;
      return null;
    }
    this.slideCooldownUntilTick = state.tick + BOT_SLIDE_COOLDOWN_TICKS;
    return this.tick(state);
  }

  /**
   * Optional route-speed sequence that rejects unsafe geometry and preserves
   * the state-machine fallback when authoritative slide entry is not confirmed.
   * Runs after brain decision — adjusts heading, doesn't override state.
   */
  tryStartLedgeSlideJump(input: BotInput, state: BotGameState): BotInput | null {
    if (
      !this.host.vision ||
      !state.self.isGrounded ||
      this.runtime.isActive ||
      this.host.difficulty.strafeJumpSkill < 0.55 ||
      state.tick < this.ledgeProbeTick ||
      state.tick < this.slideCooldownUntilTick ||
      (input.buttons & (InputButtons.FIRE | InputButtons.ALT_FIRE)) !== 0 ||
      (input.buttons & (InputButtons.FORWARD | InputButtons.SPRINT)) !== (InputButtons.FORWARD | InputButtons.SPRINT)
    )
      return null;
    const path = this.host.life.currentPath;
    const step = path?.steps[path.cursor];
    if (!path || !step) return null;
    const next = step.type === "walk" ? path.steps[path.cursor + 1] : step;
    if (!next || (next.type !== "fall" && next.type !== "jump")) return null;
    this.ledgeProbeTick = state.tick + 31;
    const plan = planLedgeSlideJump(state.self, input, next.to.position, this.host.vision.collisionWorld);
    if (!plan) return null;
    const context = { ...this.context(state, step, input), ledgeSlidePlan: plan };
    if (!this.runtime.start("ledge_slide_jump", context)) return null;
    this.activeStep = next;
    this.slideCooldownUntilTick = state.tick + BOT_SLIDE_COOLDOWN_TICKS;
    return this.tick(state);
  }

  /**
   * Is there room for a slide along the route? A slide holds its heading for
   * ROUTE_SLIDE_RUN units and comes out fast: waypoints within the run must lie
   * close to that line, those beyond it up to ROUTE_SLIDE_REACH within 45° of
   * where it ends, and the run must be walkable. Waypoints may be close
   * together: the bot slides past them (BotNavGraph.getNextStep leaves a
   * passed one behind).
   */
  slideLaneOpen(state: BotGameState, path: NavPath, step: NavStep): boolean {
    return this.laneOpen(state, path, step, ROUTE_SLIDE_RUN, ROUTE_SLIDE_REACH, ROUTE_SLIDE_LANE);
  }

  /**
   * Is the route ahead a lane `run` long, `lane` wide, walkable, with only plain
   * walking up to `reach` and no turn over 45° just after the run? Waypoints may
   * be close together: the bot passes them (BotNavGraph.getNextStep).
   */
  laneOpen(state: BotGameState, path: NavPath, step: NavStep, run: number, reach: number, laneWidth: number): boolean {
    if (step.type !== "walk" || step.requiresPreciseApproach) return false;
    const self = state.self.position;
    const heading = { x: step.to.position.x - self.x, z: step.to.position.z - self.z };
    const first = Math.hypot(heading.x, heading.z);
    if (first < 1) return false;
    const dx = heading.x / first;
    const dz = heading.z / first;
    let along = 0;
    for (let i = path.cursor; i < path.steps.length; i++) {
      const next = path.steps[i];
      const point = next.to.position;
      along = (point.x - self.x) * dx + (point.z - self.z) * dz;
      if (along >= reach) break;
      const lateral = Math.abs((point.x - self.x) * dz - (point.z - self.z) * dx);
      // A jump, drop or precise approach inside the reach is no place for it,
      // nor a turn inside the run. After the run the bot can turn up to 45°.
      const lane = laneWidth + Math.max(0, along - run);
      if (lateral > lane || next.type !== "walk" || next.requiresPreciseApproach) return false;
    }
    // A route ending inside the reach must still leave room for the run.
    if (along < run) return false;
    const vision = this.host.vision;
    if (!vision) return true;
    const end = { x: self.x + dx * run, y: self.y, z: self.z + dz * run };
    return vision.isWalkable(self, end);
  }

  /**
   * Where a hop chain can run: the route line being followed, when the next
   * ROUTE_STRAFE_REACH of it is plain walking that turns at most
   * ROUTE_STRAFE_MAX_TURN in all, and at least ROUTE_STRAFE_RUN of it is left.
   * A chain steers along the line, so it may bend; a jump, drop or exact
   * approach inside the reach is no place for one.
   */
  hopLine(state: BotGameState, path: NavPath): { points: readonly Vec3[]; end: Vec3 } | null {
    const held = this.host.life.routeLine;
    if (!held || held.path !== path) return null;
    for (let i = path.cursor; i < Math.min(path.steps.length, held.line.endStep); i++) {
      if (path.steps[i].type !== "walk" || path.steps[i].requiresPreciseApproach) return null;
    }
    const points = held.line.points;
    const self = state.self.position;
    const start = pointAlong(points, self, 0, held.stretch);
    // Walk the line ahead: its length to the reach, and how much it turns.
    let length = 0;
    let turned = 0;
    let previous = start.point;
    let heading: number | null = null;
    let end = start.point;
    for (let i = start.stretch + 1; i < points.length && length < ROUTE_STRAFE_REACH; i++) {
      const point = points[i];
      const piece = Math.hypot(point.x - previous.x, point.z - previous.z);
      if (piece < 1) continue;
      const yaw = Math.atan2(point.x - previous.x, point.z - previous.z);
      if (heading !== null) turned += Math.abs(wrapAngle(yaw - heading));
      if (turned > ROUTE_STRAFE_MAX_TURN) break;
      heading = yaw;
      length += piece;
      end = point;
      previous = point;
    }
    if (length < ROUTE_STRAFE_RUN) return null;
    return { points, end };
  }

  tryStartRouteCrouchslide(input: BotInput, state: BotGameState): BotInput | null {
    if (state.self.isDead || this.runtime.isActive) return null;
    const movingForward = (input.buttons & InputButtons.FORWARD) !== 0 && (input.buttons & InputButtons.BACK) === 0;
    const sprinting = (input.buttons & InputButtons.SPRINT) !== 0;
    const horizontalSpeed = Math.sqrt(state.self.velocity.x ** 2 + state.self.velocity.z ** 2);
    const cooldownExpired = state.tick >= this.slideCooldownUntilTick;

    if (
      !state.self.isGrounded ||
      !movingForward ||
      !sprinting ||
      (input.buttons & (InputButtons.FIRE | InputButtons.ALT_FIRE)) !== 0 ||
      !canInitiateSlide(horizontalSpeed, cooldownExpired)
    ) {
      return null;
    }

    const navigationSlide =
      this.host.currentState === BotState.HUNT ||
      this.host.currentState === BotState.ITEM_RUN ||
      this.host.currentState === BotState.RETREAT ||
      this.host.currentState === BotState.CHASE;
    const dodgeSlide = this.host.currentState === BotState.DODGE && this.host.difficulty.dodgeSkill >= 0.35;

    if (!navigationSlide && !dodgeSlide) return null;

    const step = this.host.life.currentPath?.steps[this.host.life.currentPath.cursor] ?? null;
    if (this.host.life.currentPath && !step) return null;
    if (step && this.host.life.currentPath && !this.slideLaneOpen(state, this.host.life.currentPath, step)) return null;
    // A slide barely steers once begun: its whole run must clear the walls with room to spare
    if (this.host.tracer && !this.host.tracer.runClear(state.self.position, travelYaw(input), ROUTE_SLIDE_RUN))
      return null;

    const context = this.context(state, step, input, true);
    if (!this.runtime.start("route_crouchslide", context)) return null;
    this.slideCooldownUntilTick = state.tick + BOT_SLIDE_COOLDOWN_TICKS;
    return this.tick(state);
  }

  /**
   * Starts a strafe-jump chain only after the route planner has established
   * enough straight, unoccupied walk space. The chain asks again on every
   * landing (`routeStrafeNext`), so a route change still ends it there.
   */
  tryStartRouteStrafeJump(input: BotInput, state: BotGameState): BotInput | null {
    if (
      state.self.isDead ||
      this.runtime.isActive ||
      state.tick < this.routeStrafeCooldownUntilTick ||
      this.host.difficulty.strafeJumpSkill < 0.35
    ) {
      return null;
    }
    if (!state.self.isGrounded || state.self.isSliding) return null;

    const required = InputButtons.FORWARD | InputButtons.SPRINT;
    const disallowed =
      InputButtons.BACK |
      InputButtons.LEFT |
      InputButtons.RIGHT |
      InputButtons.CROUCH |
      InputButtons.FIRE |
      InputButtons.ALT_FIRE;
    if ((input.buttons & required) !== required || (input.buttons & disallowed) !== 0) return null;

    const lane = this.routeStrafeLane(state);
    if (!lane) return null;
    const step = this.host.life.currentPath?.steps[this.host.life.currentPath.cursor] ?? null;
    const context = {
      ...this.context(state, step, input, false, true, this.routeStrafeSide),
      ...lane,
      routeStrafeNext: (at: BotGameState) => {
        this.host.nav.advancePath(at);
        return this.routeStrafeLane(at);
      },
    };
    if (!this.runtime.start("route_strafe_jump", context)) return null;
    this.routeStrafeSide = this.routeStrafeSide === 1 ? -1 : 1;
    this.routeStrafeCooldownUntilTick = state.tick + BOT_STRAFE_RETRY_TICKS;
    return this.tick(state);
  }

  /**
   * The open stretch of route a strafe jump may take from here, or null: a
   * walk step with room ahead, at running speed and heading along it, and no
   * ally in the way.
   */
  routeStrafeLane(state: BotGameState): RouteStrafeLane | null {
    const navigationState =
      this.host.currentState === BotState.HUNT ||
      this.host.currentState === BotState.ITEM_RUN ||
      this.host.currentState === BotState.RETREAT ||
      this.host.currentState === BotState.CHASE;
    if (!navigationState || state.self.isDead) return null;

    const path = this.host.life.currentPath;
    const step = path?.steps[path.cursor] ?? null;
    if (!path || !step || step.type !== "walk" || step.requiresPreciseApproach) return null;

    const routeDelta = vec3Subtract(step.to.position, state.self.position);
    const remaining = Math.hypot(routeDelta.x, routeDelta.z);
    // An open lane of route ahead, however many waypoints it passes, and room
    // to stop before an item at its end.
    const lastItemStep = this.host.currentState === BotState.ITEM_RUN && path.cursor === path.steps.length - 1;
    if (lastItemStep && remaining < ROUTE_STRAFE_ITEM_MIN_REMAINING_DISTANCE) return null;
    // Along the route line when one is held, else a straight lane of route.
    const line =
      this.hopLine(state, path) ??
      (this.laneOpen(state, path, step, STRAIGHT_HOP_RUN, STRAIGHT_HOP_REACH, STRAIGHT_HOP_LANE)
        ? { points: null, end: null }
        : null);
    if (!line) return null;

    const routeDirection = vec3Normalize({ x: routeDelta.x, y: 0, z: routeDelta.z });
    const horizontalSpeed = Math.hypot(state.self.velocity.x, state.self.velocity.z);
    if (horizontalSpeed < ROUTE_STRAFE_ENTRY_SPEED) return null;
    if (horizontalSpeed > 0.001) {
      const velocityDotRoute =
        (state.self.velocity.x * routeDirection.x + state.self.velocity.z * routeDirection.z) / horizontalSpeed;
      const velocityError = Math.acos(Math.max(-1, Math.min(1, velocityDotRoute)));
      if (velocityError > ROUTE_STRAFE_MAX_VELOCITY_ERROR_RADIANS) return null;
    }

    const allyBlocksRoute = state.players.some((player) => {
      if (player.relation !== "ally" || player.isDead) return false;
      const relative = vec3Subtract(player.position, state.self.position);
      if (Math.abs(relative.y) > 96) return false;
      const along = relative.x * routeDirection.x + relative.z * routeDirection.z;
      if (along <= 0 || along >= Math.min(remaining, ROUTE_STRAFE_ALLY_LOOKAHEAD)) return false;
      const lateral = Math.abs(relative.x * routeDirection.z - relative.z * routeDirection.x);
      return lateral < ROUTE_STRAFE_ALLY_RADIUS;
    });
    if (allyBlocksRoute) return null;

    const points = line.points;
    const self = state.self.position;
    return {
      routeStrafeYaw: Math.atan2(routeDirection.x, routeDirection.z),
      // Along a route line: steer with it to the end of the open stretch. On a
      // straight lane: hold the heading to its end, past waypoints inside it.
      routeStrafeEnd: line.end ?? {
        x: self.x + routeDirection.x * (STRAIGHT_HOP_RUN + STRAIGHT_HOP_EXIT_MARGIN),
        y: self.y,
        z: self.z + routeDirection.z * (STRAIGHT_HOP_RUN + STRAIGHT_HOP_EXIT_MARGIN),
      },
      routeStrafeSteer: points
        ? (at: Vec3) => {
            const ahead = pointAlong(points, at, ROUTE_STRAFE_STEER_AHEAD).point;
            return Math.atan2(ahead.x - at.x, ahead.z - at.z);
          }
        : null,
      routeStrafeOffLine: points
        ? (at: Vec3) => {
            const near = pointAlong(points, at, 0).point;
            return Math.hypot(near.x - at.x, near.z - at.z);
          }
        : null,
    };
  }
}
