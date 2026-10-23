import type { BotInput } from "../BotBrain";
import { InputButtons } from "../BotConfig";
import type { Vec3 } from "../BotGameState";
import type { BotSequence, BotSequenceContext, BotSequenceState, BotSequenceTick } from "../BotSequence";
import { decodeScript, type LearnedRoute, type RouteCommand } from "../LearnedRoutes";

/** Close enough to the route's start to begin, units (verification nudges starts by 8). */
const START_RADIUS = 6;
/** Slow enough to count as standing, units per second. */
const STILL_SPEED = 20;
/** Creep, rather than run, inside this distance of the start, so the bot can stop on it. */
const WALK_RADIUS = 96;
/** Creeping pushes only below this speed. */
const CREEP_SPEED = 80;
/** Extra ticks after the script before the landing is judged. */
const LANDING_GRACE_TICKS = 40;
/** Landed when this close to the route's landing, horizontally and vertically. */
const LANDING_RADIUS = 64;
const LANDING_HEIGHT = 48;
/** Give up reaching the start after this long. */
const APPROACH_TICKS = 750;

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
 * Runs a learned route: walk to its start, stop there, then hand the client
 * the whole script to send one command per server tick, and check the landing.
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
    return {
      phase: "approach",
      startedTick: context.state.tick,
      phaseStartedTick: context.state.tick,
      commitUntilTick: context.state.tick,
      data: { route, script: decodeScript(route.script).map(toBotInput), sentTick: null },
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
      if (landed && elapsed >= route.ticks / 2) {
        return { input: idle(self.yaw), status: "succeeded", phase: "landed" };
      }
      if (elapsed > route.ticks + LANDING_GRACE_TICKS) {
        return { input: idle(self.yaw), status: "failed", phase: "execute", reason: "learned_route_missed_landing" };
      }
      return { input: idle(self.yaw), status: "running", phase: "execute", commitForTicks: LANDING_GRACE_TICKS };
    }

    if (context.state.tick - state.startedTick > APPROACH_TICKS) {
      return { input: idle(self.yaw), status: "failed", phase: "approach", reason: "learned_route_start_unreached" };
    }

    const distance = horizontal(self.position, route.start);
    const speed = Math.hypot(self.velocity.x, self.velocity.z);
    if (distance <= START_RADIUS && self.isGrounded) {
      if (speed > STILL_SPEED) return { input: idle(route.yaw), status: "running", phase: "settle" };
      state.data.sentTick = context.state.tick;
      const script = state.data.script as BotInput[];
      return {
        input: { ...script[0], script },
        status: "running",
        phase: "execute",
        commitForTicks: route.ticks + LANDING_GRACE_TICKS,
      };
    }
    // Near the mark, creep: push only while slow and let friction take the
    // rest, because running onto it overshoots.
    if (distance <= WALK_RADIUS) {
      if (speed > CREEP_SPEED) return { input: idle(route.yaw), status: "running", phase: "creep" };
      return { input: toward(self.position, route.start, InputButtons.FORWARD), status: "running", phase: "creep" };
    }
    return {
      input: toward(self.position, route.start, InputButtons.FORWARD | InputButtons.SPRINT),
      status: "running",
      phase: "approach",
    };
  }
}
