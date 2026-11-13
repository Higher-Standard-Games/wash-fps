import type { BotInput } from "../BotBrain";
import { InputButtons } from "../BotConfig";
import type { Vec3 } from "../BotGameState";
import type { BotSequence, BotSequenceContext, BotSequenceState, BotSequenceTick } from "../BotSequence";
import { decodeScript, type LearnedRoute, type RouteCommand } from "../LearnedRoutes";
import {
  ENTRY_BACK,
  entryPoint,
  findJoin,
  joinLands,
  predict,
  type RunUpState,
  runUpStates,
  type SimWorld,
} from "./FlyingStart";

/** Close enough to the route's start to begin, units (verification nudges starts by 8). */
const START_RADIUS = 6;
/** Slow enough to count as standing, units per second. */
const STILL_SPEED = 20;
/** Creep, rather than run, inside this distance of the start, so the bot can stop on it. */
const WALK_RADIUS = 96;
/** Creeping pushes only below this speed. */
const CREEP_SPEED = 80;
/**
 * Ground deceleration below stop speed, units/s² (stop speed 100 × friction 6):
 * a bot at speed v coasts v² / (2 × this) before it stands still.
 */
const COAST_DECELERATION = 600;
/** Once on the mark, stand still before judging it, unless pushed this far off. */
const SETTLE_RADIUS = 24;
/** Over the mark but this far above or below it: on another floor. */
const START_HEIGHT = 32;
/** Extra ticks after the script before the landing is judged. */
const LANDING_GRACE_TICKS = 40;
/** Landed when this close to the route's landing, horizontally and vertically. */
const LANDING_RADIUS = 64;
const LANDING_HEIGHT = 48;
/** Give up reaching the start after this long. */
const APPROACH_TICKS = 750;
/** Within this of the run-in's entry point, turn and run in. */
const ENTRY_RADIUS = 40;
/** Ticks the server is ahead of the snapshot a join is decided on: a snapshot every 2 ticks, and the decision. */
const JOIN_LEAD_TICKS = 3;
/** Arrival leads the join must land from. */
const JOIN_LEADS_CHECKED = [2, 3, 4, 5] as const;
/** A run-in this far past the mark without a join has missed it. */
const RUN_IN_OVERSHOOT = 48;

const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

function idle(yaw: number): BotInput {
  return { direction: { x: 0, y: 0, z: 0 }, pitch: 0, yaw, buttons: 0, weaponSlot: 0 };
}

function toward(from: Vec3, to: Vec3, buttons: number): BotInput {
  return {
    direction: { x: 0, y: 0, z: 1 },
    pitch: 0,
    yaw: Math.atan2(to.x - from.x, to.z - from.z),
    buttons,
    weaponSlot: 0,
  };
}

/**
 * Push toward the mark while already looking the way the route starts. The
 * bearing to the mark flips round whenever the bot passes it, and turning the
 * view with it spun the bot on the spot until it stopped exactly there.
 * Crouched, so each tick of push adds half the speed: a push runs on for a
 * tick or two after the decision to stop it.
 */
function creepToward(from: Vec3, to: Vec3, routeYaw: number): BotInput {
  return {
    ...toward(from, to, InputButtons.FORWARD | InputButtons.CROUCH),
    moveYaw: Math.atan2(to.x - from.x, to.z - from.z),
    yaw: routeYaw,
  };
}

/**
 * A command as the bot client sends it: the client turns a view-relative
 * direction into world space by yaw, so turn the recorded world direction back.
 */
function toBotInput(command: RouteCommand): BotInput {
  const sin = Math.sin(command.yaw);
  const cos = Math.cos(command.yaw);
  return {
    direction: {
      x: command.right * cos - command.forward * sin,
      y: 0,
      z: command.right * sin + command.forward * cos,
    },
    pitch: command.pitch,
    yaw: command.yaw,
    buttons: command.buttons,
    weaponSlot: 0,
  };
}

/**
 * Runs a learned route: hand the client the script to send one command per
 * server tick, and check the landing. On the run when it can (FlyingStart.ts):
 * where the ground behind the mark is walkable, the bot goes there, sprints in
 * along the route's line and takes over the script at the run-up state it
 * matches, once a simulation from its exact state says the rest lands. Else,
 * or when the run-in misses, it walks to the mark, stops on it and sends the
 * whole script from standing.
 */
export class LearnedRouteSequence implements BotSequence {
  readonly id = "nav_learned_route";
  readonly tags = ["navigation", "movement", "jump"] as const;
  readonly maxTicks = APPROACH_TICKS + 1200;

  score(context: BotSequenceContext): number | null {
    return context.navStep?.type === "jump" && context.learnedRoute ? 1100 : null;
  }

  start(context: BotSequenceContext): BotSequenceState {
    const route = context.learnedRoute;
    if (!route) throw new Error("LearnedRouteSequence requires a learned route");
    const commands = decodeScript(route.script);
    const vision = context.vision;
    const world: SimWorld | null = vision
      ? { collision: vision.collisionWorld, triggers: vision.mapKnowledge.triggerVolumes }
      : null;
    const runUp = world ? runUpStates(route, commands, world) : [];
    const entry = entryPoint(route);
    // A run-in needs walkable ground from behind the mark to it, and from here to there.
    const runIn =
      world !== null &&
      runUp.length > 0 &&
      vision?.isWalkable(entry, route.start) === true &&
      vision.isWalkable(context.state.self.position, entry);
    return {
      phase: "approach",
      startedTick: context.state.tick,
      phaseStartedTick: context.state.tick,
      commitUntilTick: context.state.tick,
      data: {
        route,
        commands,
        script: commands.map(toBotInput),
        sentTick: null,
        sentLength: route.ticks,
        settling: false,
        world,
        runUp,
        runIn: runIn ? "to_entry" : "off",
        joinedAt: null,
      },
    };
  }

  tick(context: BotSequenceContext, state: BotSequenceState): BotSequenceTick {
    const route = state.data.route as LearnedRoute;
    const self = context.state.self;
    const sentTick = state.data.sentTick as number | null;

    if (sentTick !== null) {
      const elapsed = context.state.tick - sentTick;
      const landed =
        self.isGrounded &&
        horizontal(self.position, route.landing) <= LANDING_RADIUS &&
        Math.abs(self.position.y - route.landing.y) <= LANDING_HEIGHT;
      const sentLength = (state.data.sentLength as number | undefined) ?? route.ticks;
      if (landed && elapsed >= sentLength / 2) {
        return { input: idle(self.yaw), status: "succeeded", phase: "landed" };
      }
      if (elapsed > sentLength + LANDING_GRACE_TICKS) {
        return { input: idle(self.yaw), status: "failed", phase: "execute", reason: "learned_route_missed_landing" };
      }
      return { input: idle(self.yaw), status: "running", phase: "execute", commitForTicks: LANDING_GRACE_TICKS };
    }

    if (context.state.tick - state.startedTick > APPROACH_TICKS) {
      return { input: idle(self.yaw), status: "failed", phase: "approach", reason: "learned_route_start_unreached" };
    }

    const flying = this._flyingStart(context, state, route);
    if (flying) return flying;

    const distance = horizontal(self.position, route.start);
    const speed = Math.hypot(self.velocity.x, self.velocity.z);
    if (distance <= SETTLE_RADIUS && self.isGrounded && Math.abs(self.position.y - route.start.y) > START_HEIGHT) {
      return { input: idle(self.yaw), status: "failed", phase: "approach", reason: "learned_route_start_other_floor" };
    }
    // Coming to rest takes a few units; judging the mark while still moving
    // sent the bot back and forth across it.
    if (
      state.data.settling === true &&
      distance <= SETTLE_RADIUS &&
      (speed > STILL_SPEED || self.isCrouching) &&
      self.isGrounded
    ) {
      return { input: idle(route.yaw), status: "running", phase: "settle" };
    }
    state.data.settling = false;
    if (distance <= START_RADIUS && self.isGrounded) {
      // The script was verified from standing, so stand up from the creep first.
      if (speed > STILL_SPEED || self.isCrouching) {
        state.data.settling = true;
        return { input: idle(route.yaw), status: "running", phase: "settle" };
      }
      state.data.sentTick = context.state.tick;
      const script = state.data.script as BotInput[];
      return {
        input: { ...script[0], script },
        status: "running",
        phase: "execute",
        commitForTicks: route.ticks + LANDING_GRACE_TICKS,
      };
    }
    // Near the mark, creep: push only while the coast from this speed stops
    // short of it, and let friction take the rest, because running onto it
    // overshoots. The coast stays crouched: standing up between pushes
    // bobbed the bot up and down several times a second.
    if (distance <= WALK_RADIUS) {
      const coastSpeed = Math.min(CREEP_SPEED, Math.sqrt(2 * COAST_DECELERATION * distance));
      if (speed > coastSpeed) {
        return { input: { ...idle(route.yaw), buttons: InputButtons.CROUCH }, status: "running", phase: "creep" };
      }
      return { input: creepToward(self.position, route.start, route.yaw), status: "running", phase: "creep" };
    }
    return {
      input: toward(self.position, route.start, InputButtons.FORWARD | InputButtons.SPRINT),
      status: "running",
      phase: "approach",
    };
  }

  /**
   * The run-in: to the entry point behind the mark, then a sprint along the
   * route's line, joining the script at a matching run-up state that a
   * simulation says lands. Null when there is no run-in, or it has missed, and
   * the bot should stop on the mark instead.
   */
  private _flyingStart(
    context: BotSequenceContext,
    state: BotSequenceState,
    route: LearnedRoute,
  ): BotSequenceTick | null {
    const self = context.state.self;
    const runIn = state.data.runIn as "to_entry" | "running" | "off" | undefined;
    if (runIn !== "to_entry" && runIn !== "running") return null;
    const world = state.data.world as SimWorld;
    const runUp = state.data.runUp as RunUpState[];
    const commands = state.data.commands as RouteCommand[];

    if (self.isGrounded) {
      // The snapshot is a few ticks old and the bot is still sprinting: join
      // where the server will be when the script arrives.
      const ahead = predict(self, commands[0], JOIN_LEAD_TICKS, world);
      const k = ahead.grounded ? findJoin(runUp, ahead.position, ahead.velocity) : null;
      // The lead is a guess: the script has to land if it arrives a tick or two sooner or later.
      const lands =
        k !== null &&
        JOIN_LEADS_CHECKED.every((lead) =>
          joinLands(route, commands, k, predict(self, commands[0], lead, world), world),
        );
      if (k !== null && lands) {
        const script = (state.data.script as BotInput[]).slice(k + 1);
        state.data.sentTick = context.state.tick;
        state.data.sentLength = script.length;
        state.data.joinedAt = k;
        return {
          input: { ...script[0], script },
          status: "running",
          phase: "execute",
          commitForTicks: script.length + LANDING_GRACE_TICKS,
        };
      }
    }

    const heading = { x: Math.sin(route.yaw), z: Math.cos(route.yaw) };
    const along = (self.position.x - route.start.x) * heading.x + (self.position.z - route.start.z) * heading.z;
    const last = runUp[runUp.length - 1].position;
    const runUpLength = (last.x - route.start.x) * heading.x + (last.z - route.start.z) * heading.z;
    if (runIn === "to_entry") {
      const entry = entryPoint(route);
      if (horizontal(self.position, entry) > ENTRY_RADIUS && along < -ENTRY_BACK / 2) {
        // Behind the mark already, short of the entry: run in from here.
        state.data.runIn = "running";
      } else if (horizontal(self.position, entry) > ENTRY_RADIUS) {
        return {
          input: toward(self.position, entry, InputButtons.FORWARD | InputButtons.SPRINT),
          status: "running",
          phase: "run_in",
        };
      } else state.data.runIn = "running";
    }
    if (along > runUpLength + RUN_IN_OVERSHOOT) {
      // Past every run-up state without a join: stop on the mark the old way.
      state.data.runIn = "off";
      return null;
    }
    // Sprint along the line, steering onto it: aim a little ahead on the line.
    const ahead = Math.max(along + 96, 96);
    const onLine = { x: route.start.x + heading.x * ahead, y: route.start.y, z: route.start.z + heading.z * ahead };
    return {
      input: toward(self.position, onLine, InputButtons.FORWARD | InputButtons.SPRINT),
      status: "running",
      phase: "run_in",
    };
  }
}
