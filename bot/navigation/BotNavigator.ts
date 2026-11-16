/**
 * Route following for a bot: find a route to a point, follow it step by step
 * and along the line through its walking stretches, look along it, notice a
 * route that goes nowhere, and keep the memory of steps and items that failed.
 * StateMachineBrain decides where to go; this gets the bot there. What it needs
 * of the brain (its life, the map, the moves, recovery and the traversal
 * sequences) comes through NavigatorHost.
 */

import { wrapAngle } from "../BotAimController";
import { type BotInput, BotState } from "../BotBrain";
import { InputButtons } from "../BotConfig";
import type { BotGameState, Vec3 } from "../BotGameState";
import { vec3Length, vec3Subtract } from "../BotGameState";
import type { BotLife } from "../BotLife";
import {
  type BotNavGraph,
  type NavPath,
  type NavPathOptions,
  type NavStep,
  navEdgeKey,
  wallClearance,
} from "../BotNavGraph";
import type { BotVision } from "../BotVision";
import type { BotGoal } from "../goals/BotGoal";
import { buildRouteLine, lineEndStep, pointAlong, type RouteWorld } from "../RouteLine";

export const PATH_RECALC_INTERVAL = 120; // Recalculate path every ~2 seconds
export const PATH_ARRIVED_THRESHOLD = 100; // Distance to consider "arrived" at a waypoint
const NAV_EDGE_FAILURE_COOLDOWN_TICKS = 625;
/** The cooldown doubles with each failure of the same edge, up to this many times. */
const NAV_EDGE_FAILURE_MAX_SCALE = 8;
/** An order's waypoint counts as passed within this, horizontally… */
export const VIA_RADIUS = 128;
/** …and this, vertically. */
const VIA_HEIGHT = 72;
/** Further than this from its line, a bot was knocked off it and plans the line again. */
const ROUTE_LINE_OFF = 128;
/** At the line's end within this, the steps it covered are done. */
const ROUTE_LINE_ARRIVED = 48;
/** Running a route line, the bot heads for the point this far along it. */
const ROUTE_LINE_AHEAD = 64;
/** How far along its route a walking bot looks. */
const ROUTE_LOOK_AHEAD = 250;
/** Closer than this the look point says nothing about where the route goes. */
const ROUTE_LOOK_MIN_DISTANCE = 32;

export type PathFollowResult =
  | { status: "moving"; input: BotInput }
  | { status: "complete" }
  | { status: "blocked"; reason: string };
/** What route following needs of the brain. */
export interface NavigatorHost {
  /** This life's route: the path, its target, its route line, progress and recovery. */
  readonly life: BotLife;
  readonly navGraph: BotNavGraph | null;
  readonly vision: BotVision | null;
  readonly currentState: BotState;
  moveToward(state: BotGameState, target: Vec3, urgent: boolean): BotInput;
  moveTowardPrecise(state: BotGameState, target: Vec3): BotInput;
  makePrecise(input: BotInput): BotInput;
  holdPosition(state: BotGameState, target: Vec3): BotInput;
  /** Drop the route and goal and back off the spot; stuck puts the item goal on cooldown. */
  startRecovery(state: BotGameState, stuck?: boolean): BotInput;
  dropUnreachableItemGoal(state: BotGameState, target: Vec3): void;
  tryStartLedgeSlideJump(input: BotInput, state: BotGameState): BotInput | null;
  startNavSequence(state: BotGameState, step: NavStep, sequenceId: string): PathFollowResult | null;
  /** `owner` moves exactly this decision: no correction or takeover of movement after it (InputClaims). */
  holdMovementExact(owner: string): void;
}

export class BotNavigator {
  constructor(private readonly host: NavigatorHost) {}

  pathRecalcTimer: number = 0;

  readonly blockedNavEdges = new Map<string, number>();

  /** Times each nav edge has failed this bot, for the growing cooldown. */
  readonly navEdgeFailures = new Map<string, number>();

  readonly blockedPickupIds = new Map<number, number>();

  /** Progress along the current order's `via` waypoints. */
  via: { id: string; next: number } | null = null;

  activeNavStep: NavStep["type"] | null = null;

  pathBlockedReason: string | null = null;

  /** This decision ran along a route line; the feelers stand aside. */
  onRouteLine = false;

  navigateTo(state: BotGameState, target: Vec3, urgent: boolean, holdRadius?: number): BotInput {
    // Arrived, and the goal is a PLACE TO BE rather than a thing to touch.
    //
    // Everything else in this brain deliberately never sends a zero direction
    // (see `_moveToward`), which means a bot is always running. That is right
    // for fetching items and wrong for objectives: Search & Destroy plants only
    // below 400 ups and arms only while you stay within 100 units of the bomb,
    // so a bot that cannot stop cannot plant, cannot arm, and cannot defuse.
    // Holding is the behaviour that makes objective modes playable at all.
    if (holdRadius !== undefined && vec3Length(vec3Subtract(target, state.self.position)) <= holdRadius) {
      return this.host.holdPosition(state, target);
    }

    if (!this.host.navGraph) {
      return this.host.moveToward(state, target, urgent);
    }

    // Recalculate path periodically or if target changed significantly
    const targetChanged =
      !this.host.life.pathTarget || vec3Length(vec3Subtract(target, this.host.life.pathTarget)) > 200;

    if (targetChanged || !this.host.life.currentPath || this.pathRecalcTimer > PATH_RECALC_INTERVAL) {
      this.host.life.currentPath = this.host.navGraph.findPath(
        state.self.position,
        target,
        this.pathOptions(state.tick),
      );
      this.host.life.pathTarget = target;
      this.pathRecalcTimer = 0;
    }

    // If path found, follow waypoints
    if (this.host.life.currentPath) {
      const result = this.followCurrentPath(state, urgent);
      if (result.status === "moving") return result.input;
      if (result.status === "blocked") {
        if (holdRadius === undefined) return this.host.startRecovery(state);
        this.host.life.currentPath = null;
        return this.host.moveToward(state, target, urgent);
      }
      // Path complete — clear it
      this.host.life.currentPath = null;
      this.host.dropUnreachableItemGoal(state, target);
    }

    // No path found — fall back to direct movement
    return this.host.moveToward(state, target, urgent);
  }

  /**
   * The next of an order's `via` waypoints not yet passed, or null once all
   * are (or it has none). Passed means within VIA_RADIUS on the same floor;
   * progress is kept per order, so a new order starts its lane over.
   */
  nextWaypoint(state: BotGameState, goal: BotGoal): Vec3 | null {
    const via = goal.directive?.via;
    if (!via || via.length === 0) {
      this.via = null;
      return null;
    }
    const id = goal.directive?.id ?? "";
    let progress = this.via;
    if (!progress || progress.id !== id) {
      progress = { id, next: 0 };
      this.via = progress;
    }
    const self = state.self.position;
    while (progress.next < via.length) {
      const point = via[progress.next];
      const near =
        Math.hypot(point.x - self.x, point.z - self.z) <= VIA_RADIUS && Math.abs(point.y - self.y) <= VIA_HEIGHT;
      if (!near) return point;
      progress.next++;
    }
    return null;
  }

  /** Recover from a route that issues commands without actually going anywhere. */
  recoverStalledNavigation(state: BotGameState, input: BotInput): BotInput {
    // A bot standing still on purpose (holding a site, planting, waiting at
    // staging) is not stuck; one with an order that is trying to move is,
    // and an order is no reason to stay wedged against a wall all round.
    const standing =
      input.direction.x === 0 &&
      input.direction.z === 0 &&
      (input.buttons & (InputButtons.FORWARD | InputButtons.BACK | InputButtons.LEFT | InputButtons.RIGHT)) === 0;
    if (standing || this.host.currentState === BotState.FIGHT || this.host.currentState === BotState.DODGE) {
      this.host.life.navigationProgress = null;
      return input;
    }
    const progress = this.host.life.navigationProgress;
    const position = state.self.position;
    if (
      !progress ||
      state.tick < progress.tick ||
      Math.hypot(position.x - progress.position.x, position.z - progress.position.z) > 32 ||
      (state.self.isGrounded && Math.abs(position.y - progress.position.y) > 48)
    ) {
      this.host.life.navigationProgress = { position: { ...position }, tick: state.tick };
    } else if (state.tick - progress.tick >= 250 && (state.self.isGrounded || Math.abs(state.self.velocity.y) < 50)) {
      return this.host.startRecovery(state, true);
    }
    return input;
  }

  pathOptions(tick: number): NavPathOptions {
    for (const [key, retryTick] of this.blockedNavEdges) {
      if (tick >= retryTick) this.blockedNavEdges.delete(key);
    }
    for (const [pickupId, retryTick] of this.blockedPickupIds) {
      if (tick >= retryTick) this.blockedPickupIds.delete(pickupId);
    }
    return {
      blockedEdgeKeys: new Set(this.blockedNavEdges.keys()),
      blockedPickupIds: new Set(this.blockedPickupIds.keys()),
      canWalkTo: this.host.vision ? (from, to) => this.host.vision?.isWalkable(from, to) ?? true : undefined,
    };
  }

  /**
   * Leave a failed step out of routes for a while, longer each time the same
   * one fails: a jump missed again and again is one this bot cannot make
   * from where its routes take it, and retrying it every few seconds kept it
   * from the item beyond.
   */
  cooldownStep(step: NavStep, tick: number): void {
    const key = navEdgeKey(step.edge?.from ?? step.from.id, step.edge?.to ?? step.to.id, step.type);
    const failures = (this.navEdgeFailures.get(key) ?? 0) + 1;
    this.navEdgeFailures.set(key, failures);
    const scale = Math.min(NAV_EDGE_FAILURE_MAX_SCALE, 2 ** (failures - 1));
    this.blockedNavEdges.set(key, tick + NAV_EDGE_FAILURE_COOLDOWN_TICKS * scale);
  }

  /** Execute one traversal-aware step from the current A* path. */
  followCurrentPath(state: BotGameState, urgent: boolean): PathFollowResult {
    if (!this.host.navGraph || !this.host.life.currentPath) return { status: "complete" };

    const lined = this.followRouteLine(state, urgent);
    if (lined) return { status: "moving", input: lined };

    const step = this.host.navGraph.getNextStep(
      state.self.position,
      this.host.life.currentPath,
      PATH_ARRIVED_THRESHOLD,
    );
    if (!step) {
      this.activeNavStep = null;
      this.pathBlockedReason = null;
      return { status: "complete" };
    }

    this.activeNavStep = step.type;
    this.pathBlockedReason = null;
    const distanceToStart = vec3Length(vec3Subtract(step.from.position, state.self.position));

    if (step.type === "teleporter") {
      const sequenceResult = this.host.startNavSequence(state, step, "nav_traverse_teleporter");
      if (sequenceResult) return sequenceResult;
      return { status: "blocked", reason: "teleporter:missing_trigger_metadata" };
    }

    if (step.type === "jumppad") {
      const sequenceResult = this.host.startNavSequence(state, step, "nav_traverse_jumppad");
      if (sequenceResult) return sequenceResult;
      return { status: "blocked", reason: "jumppad:missing_trigger_metadata" };
    }

    if (step.type === "fall") {
      const probe = this.host.vision?.probeDrop(step.from.position, step.to.position);
      if (probe && !probe.safe) {
        this.cooldownStep(step, state.tick);
        // A bad landing is bad from every ledge above it. Blocking only this
        // edge sent the next route down the neighbouring one: the bot turned
        // away, came back and turned away again.
        if (probe.reason === "landing_obstructed" || probe.reason === "no_landing") {
          for (const edge of this.host.navGraph.edges) {
            if (edge.type === "fall" && edge.to === step.to.id) {
              this.blockedNavEdges.set(
                navEdgeKey(edge.from, edge.to, edge.type),
                state.tick + NAV_EDGE_FAILURE_COOLDOWN_TICKS,
              );
            }
          }
        }
        this.pathBlockedReason = `fall:${probe.reason}`;
        this.activeNavStep = null;
        this.host.life.currentPath = null;
        return { status: "blocked", reason: this.pathBlockedReason };
      }

      const boost = this.host.tryStartLedgeSlideJump(this.host.moveToward(state, step.to.position, urgent), state);
      if (boost) return { status: "moving", input: boost };

      this.host.holdMovementExact("fall approach");
      const target = distanceToStart > 56 ? step.from.position : (probe?.landing ?? step.to.position);
      return { status: "moving", input: this.host.moveTowardPrecise(state, target) };
    }

    if (step.type === "jump") {
      const boost = this.host.tryStartLedgeSlideJump(this.host.moveToward(state, step.to.position, urgent), state);
      if (boost) return { status: "moving", input: boost };
    }

    // A learned route is a script, not a jump: run it or not at all. Falling
    // through to the blind jump below drops the bot off the ledge it was
    // meant to wall-jump from.
    if (step.type === "jump" && this.host.navGraph?.getLearnedRoute(step.opportunityId)) {
      const sequenceResult = this.host.startNavSequence(state, step, "nav_learned_route");
      if (sequenceResult) return sequenceResult;
      return { status: "blocked", reason: "learned_route:not_started" };
    }

    if (step.type === "jump" && step.validated && step.opportunityId) {
      const sequenceResult = this.host.startNavSequence(state, step, "nav_validated_jump");
      if (sequenceResult) return sequenceResult;
    }

    const input = this.host.moveToward(state, step.to.position, urgent);
    if (step.type === "jump" && state.self.isGrounded && distanceToStart < 180) {
      input.buttons |= InputButtons.JUMP;
    }

    const distanceToEnd = vec3Length(vec3Subtract(step.to.position, state.self.position));
    if (step.requiresPreciseApproach && distanceToEnd < 256) {
      this.host.holdMovementExact("precise approach");
      return { status: "moving", input: this.host.makePrecise(input) };
    }

    this.lookAlongRoute(input, state, this.host.life.currentPath);
    return { status: "moving", input };
  }

  /**
   * Run the walking stretch of the route along its line (RouteLine), built
   * once for the stretch: down the middle of rooms and round corners on the
   * outside, through the corners of walks that bend, instead of node to node.
   * Null where the route goes on with a jump, pad, drop or exact approach,
   * which the step executor handles, or without map knowledge.
   */
  followRouteLine(state: BotGameState, urgent: boolean): BotInput | null {
    const path = this.host.life.currentPath;
    const vision = this.host.vision;
    if (!path || !vision) {
      this.host.life.routeLine = null;
      return null;
    }
    const self = state.self.position;
    let held = this.host.life.routeLine;
    if (held && (held.path !== path || path.cursor < held.fromStep || path.cursor >= held.line.endStep)) held = null;
    if (held) {
      const nearest = pointAlong(held.line.points, self, 0, held.stretch).point;
      if (Math.hypot(nearest.x - self.x, nearest.z - self.z) > ROUTE_LINE_OFF) held = null;
    }
    if (!held) {
      if (lineEndStep(path, path.cursor) === path.cursor) {
        this.host.life.routeLine = null;
        return null;
      }
      const world: RouteWorld = {
        walkable: (from, to) => vision.isWalkable(from, to),
        clearance: (at, want) => wallClearance(vision.collisionWorld, at, want, 16),
      };
      held = { path, fromStep: path.cursor, line: buildRouteLine(self, path, path.cursor, world), stretch: 0 };
    }
    this.host.life.routeLine = held;
    const points = held.line.points;
    const end = points[points.length - 1];
    // Arrived on the same floor: standing over the end, a storey up, is not there yet.
    if (
      Math.hypot(end.x - self.x, end.z - self.z) < ROUTE_LINE_ARRIVED &&
      Math.abs(end.y - self.y) < ROUTE_LINE_ARRIVED
    ) {
      // The stretch is run: on to the step after it.
      path.cursor = held.line.endStep;
      this.host.life.routeLine = null;
      return null;
    }
    const along = pointAlong(points, self, ROUTE_LINE_AHEAD, held.stretch);
    held.stretch = along.stretch;
    const input = this.host.moveToward(state, along.point, urgent);
    // Look further along the same line, as a player looks round the corner.
    const look = pointAlong(points, self, ROUTE_LOOK_AHEAD, held.stretch).point;
    if (Math.hypot(look.x - self.x, look.z - self.z) >= ROUTE_LOOK_MIN_DISTANCE) {
      const lookYaw = Math.atan2(look.x - self.x, look.z - self.z);
      if (Math.abs(wrapAngle(lookYaw - input.yaw)) <= Math.PI / 2) {
        input.moveYaw = input.yaw;
        input.yaw = lookYaw;
      }
    }
    this.activeNavStep = "walk";
    this.pathBlockedReason = null;
    this.onRouteLine = true;
    return input;
  }

  /**
   * Look a little way along the route rather than at the next waypoint, as a
   * player does: the view eases round corners before reaching them instead of
   * swinging at each node. Movement still heads for the waypoint.
   */
  lookAlongRoute(input: BotInput, state: BotGameState, path: NavPath): void {
    const self = state.self.position;
    let from = { x: self.x, z: self.z };
    let left = ROUTE_LOOK_AHEAD;
    for (let i = path.cursor; i < path.steps.length && left > 0; i++) {
      const step = path.steps[i];
      if (i > path.cursor && step.type !== "walk") break; // a jump or pad is looked at when reached
      const to = step.to.position;
      const length = Math.hypot(to.x - from.x, to.z - from.z);
      if (length >= left) {
        from = { x: from.x + ((to.x - from.x) * left) / length, z: from.z + ((to.z - from.z) * left) / length };
        break;
      }
      left -= length;
      from = { x: to.x, z: to.z };
    }
    const dx = from.x - self.x;
    const dz = from.z - self.z;
    if (Math.hypot(dx, dz) < ROUTE_LOOK_MIN_DISTANCE) return;
    const lookYaw = Math.atan2(dx, dz);
    const heading = input.yaw;
    if (Math.abs(Math.atan2(Math.sin(lookYaw - heading), Math.cos(lookYaw - heading))) > Math.PI / 2) return;
    input.moveYaw = heading;
    input.yaw = lookYaw;
  }

  /**
   * Bring the path up to where the bot is, as following it would: a sequence
   * in the air passes waypoints the brain has not looked at.
   */
  advancePath(state: BotGameState): void {
    if (!this.host.navGraph || !this.host.life.currentPath) return;
    this.followRouteLine(state, false);
    this.host.navGraph.getNextStep(state.self.position, this.host.life.currentPath, PATH_ARRIVED_THRESHOLD);
  }
}
