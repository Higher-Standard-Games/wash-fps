/**
 * Turns a training demo into learned routes (see LearnedRoutes.ts).
 *
 * 1. Rebuild the player's per-tick state and the commands they sent.
 * 2. Find the tricks: flights with a wall jump, or that climb higher than a
 *    plain jump. Teleports (the origin jumps in one tick) are not tricks.
 * 3. Line the commands up with the ticks: they are recorded as they arrive,
 *    not as the server applies them, so the offset that replays the flight
 *    closest to what happened is used.
 * 4. Give the trick a run-up from a standstill: a straight sprint into the
 *    recorded state, then the recorded commands. Keep it only if it lands on
 *    the recorded landing, also from starts nudged a few units, since a bot
 *    never stops on exactly the same spot.
 */

import type { TriggerVolume } from "../../../shared/bsp/TriggerTable";
import type { CollisionWorld } from "../../../shared/collision/CollisionWorld";
import { settle } from "../../../shared/collision/WalkFlood";
import type { DemoFrame } from "../../../shared/demo/DemoReader";
import type { Vec3 } from "../shared/bsp/BspDataLoader";
import { MovementProfile } from "../simulation/MovementProfile";
import {
  encodeScript,
  type LearnedRoute,
  type ReplayResult,
  type RouteCommand,
  replayCommands,
  runCommand,
  toMovementInput,
} from "./LearnedRoutes";

export interface TimelineTick {
  tick: number;
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  wallJumpState: string;
  /** Commands received up to and including this frame. */
  commandCount: number;
}

export interface Timeline {
  ticks: TimelineTick[];
  commands: RouteCommand[];
}

export interface TrickSegment {
  /** Index of the last grounded tick before the flight. */
  takeoff: number;
  /** Index of the first grounded tick after it. */
  landing: number;
  wallJumps: number;
  rise: number;
}

/** A plain standing jump rises about 51 units; higher means a trick. */
const PLAIN_JUMP_RISE = 56;
/** One tick of movement never covers this much; a teleport does. */
const TELEPORT_STEP = 150;
/** A flight with no floor this far below its takeoff, under its middle, crossed a gap. */
const GAP_DEPTH = 64;
/** A flight landing this far from where a teleporter put the player out is a trick. */
const TELEPORT_CARRY = 160;
/** Recorded ticks kept before takeoff at least, so the player's last steering stays. */
const LEAD_TICKS = 20;
/** Furthest back the recording may start (3 s). */
const MAX_LEAD_TICKS = 375;
/** Fastest ground speed a sprint from a standstill reaches, near enough. */
const SPRINT_SPEED = 420;
/** Command offsets tried when lining commands up with ticks. */
const MAX_DELAY = 6;
/** A replay lands when this close to the recorded landing. */
const LANDING_RADIUS = 40;
const LANDING_HEIGHT = 32;
/** Final ticks of a replay checked for the landing. */
const LANDING_TICKS = 8;
/** Run-up lengths tried, units. */
const RUN_UP_MIN = 32;
const RUN_UP_MAX = 512;
const RUN_UP_STEP = 16;
/** Longest run-up, ticks. */
const RUN_UP_TICKS = 250;
/** Start nudges for the robustness check, units. */
const NUDGE = 8;
/** Nudged starts that must also land, of the five tried (centre plus four). */
const ROBUST_LANDINGS = 4;

const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

function component<T>(components: unknown, name: string): T | undefined {
  if (components instanceof Map) return components.get(name) as T | undefined;
  return (components as Record<string, T> | undefined)?.[name];
}

/** Rebuild one player's per-tick state and command stream from demo frames. */
export function buildTimeline(frames: readonly DemoFrame[], playerId: string): Timeline {
  const ticks: TimelineTick[] = [];
  const commands: RouteCommand[] = [];
  const entityKey = `player_${playerId}`;
  for (const frame of frames) {
    for (const input of frame.inputs ?? []) {
      if (input.playerId !== playerId) continue;
      for (let i = 0; i < input.commands; i++) {
        commands.push({
          forward: input.forward,
          right: input.right,
          yaw: input.yaw,
          pitch: input.pitch,
          buttons: input.buttons,
        });
      }
    }
    const entity = (frame.state as unknown as { entities: Map<string, { components: unknown }> }).entities.get(
      entityKey,
    );
    if (!entity) continue;
    const transform = component<{ position: Vec3 }>(entity.components, "transform");
    const velocity = component<{ linear?: Vec3; x: number; y: number; z: number; grounded: boolean }>(
      entity.components,
      "velocity",
    );
    const movement = component<{ wallJumpState?: string }>(entity.components, "movementState");
    if (!transform || !velocity) continue;
    ticks.push({
      tick: frame.tick,
      position: { ...transform.position },
      velocity: { ...(velocity.linear ?? velocity) },
      grounded: velocity.grounded,
      wallJumpState: movement?.wallJumpState ?? "none",
      commandCount: commands.length,
    });
  }
  return { ticks, commands };
}

/**
 * Did a flight cross a gap: no floor under its middle within `GAP_DEPTH` of
 * where it took off? A jump over a pit lands no higher than it left, so it is
 * found by what is under it, not by its height.
 */
function crossesGap(collision: CollisionWorld, takeoff: Vec3, flight: readonly TimelineTick[]): boolean {
  const middle = flight[Math.floor(flight.length / 2)]?.position;
  if (!middle) return false;
  const floor = collision.trace(middle, { x: middle.x, y: takeoff.y - GAP_DEPTH, z: middle.z });
  return !floor.hit || floor.fraction >= 1;
}

/**
 * Flights worth learning: a wall jump, a climb above a plain jump, a jump over
 * a gap (with `collision` to look under it), or a teleport flown out of.
 */
export function findTrickSegments(timeline: Timeline, collision?: CollisionWorld): TrickSegment[] {
  const { ticks } = timeline;
  const segments: TrickSegment[] = [];
  for (let i = 1; i < ticks.length; i++) {
    if (!ticks[i - 1].grounded || ticks[i].grounded) continue;
    let j = i;
    let wallJumps = 0;
    let exit: Vec3 | null = null;
    while (j < ticks.length && !ticks[j].grounded) {
      if (ticks[j].wallJumpState === "charging" && ticks[j - 1].wallJumpState !== "charging") wallJumps++;
      const step = ticks[j - 1].position;
      const here = ticks[j].position;
      if (Math.hypot(here.x - step.x, here.y - step.y, here.z - step.z) > TELEPORT_STEP) exit = here;
      j++;
    }
    if (j >= ticks.length) break;
    const rise = ticks[j].position.y - ticks[i - 1].position.y;
    // A teleport the player only rode is the graph's business; one they flew
    // out of to land somewhere else (a fast entry carried across a gap, a
    // ledge grabbed) is a trick.
    const trick = exit
      ? horizontal(ticks[j].position, exit) > TELEPORT_CARRY
      : wallJumps > 0 ||
        rise > PLAIN_JUMP_RISE ||
        (collision !== undefined && crossesGap(collision, ticks[i - 1].position, ticks.slice(i, j)));
    if (trick) {
      segments.push({ takeoff: i - 1, landing: j, wallJumps, rise });
    }
    i = j;
  }
  return segments;
}

export interface LearnContext {
  collision: CollisionWorld;
  triggers: readonly TriggerVolume[];
  demo: string;
}

export type LearnOutcome = { route: LearnedRoute } | { rejected: string };

/** Learn one trick as a route from a standstill, or say why not. */
export function learnSegment(timeline: Timeline, segment: TrickSegment, context: LearnContext): LearnOutcome {
  const { ticks, commands } = timeline;
  // Start the recording where a sprint from a standstill can take over: the
  // latest grounded tick no faster than a sprint, at least LEAD_TICKS before
  // takeoff. Hops and strafe jumps that built the speed stay in the script.
  let first = -1;
  for (let i = segment.takeoff - LEAD_TICKS; i >= Math.max(1, segment.takeoff - MAX_LEAD_TICKS); i--) {
    const t = ticks[i];
    if (t.grounded && Math.hypot(t.velocity.x, t.velocity.z) <= SPRINT_SPEED) {
      first = i;
      break;
    }
  }
  if (first < 0) return { rejected: "never slow enough on the ground before it to start from a standstill" };
  const end = Math.min(ticks.length - 1, segment.landing + 4);
  const recordedLanding = ticks[end].position;
  const recordedStart = ticks[first];

  // Commands for ticks first+1..end, at the offset that replays best.
  const slice = (delay: number) =>
    ticks.slice(first + 1, end + 1).map((t) => {
      const index = Math.max(0, Math.min(commands.length - 1, t.commandCount - 1 + delay));
      return commands[index];
    });
  let best: { delay: number; error: number } | null = null;
  for (let delay = -MAX_DELAY; delay <= MAX_DELAY; delay++) {
    const replay = replayCommands(
      context.collision,
      context.triggers,
      { position: recordedStart.position, velocity: recordedStart.velocity, grounded: true },
      slice(delay),
    );
    const error = Math.hypot(
      replay.position.x - recordedLanding.x,
      replay.position.y - recordedLanding.y,
      replay.position.z - recordedLanding.z,
    );
    if (!best || error < best.error) best = { delay, error };
  }
  if (!best || best.error > LANDING_RADIUS) return { rejected: `replay misses by ${best?.error.toFixed(0)} units` };
  const recorded = slice(best.delay);

  // A run-up from a standstill into the recorded state.
  const speed = Math.hypot(recordedStart.velocity.x, recordedStart.velocity.z);
  const heading =
    speed > 1
      ? { x: recordedStart.velocity.x / speed, z: recordedStart.velocity.z / speed }
      : { x: Math.sin(recorded[0].yaw), z: Math.cos(recorded[0].yaw) };
  // Landed: on the ground near the recorded landing in any of the last ticks
  // (the player may already be hopping on, or stepping up a stair).
  const lands = (replay: ReplayResult) => {
    for (let k = Math.max(0, replay.path.length - LANDING_TICKS); k < replay.path.length; k++) {
      const p = replay.path[k];
      if (
        replay.groundedPath[k] &&
        horizontal(p, recordedLanding) <= LANDING_RADIUS &&
        Math.abs(p.y - recordedLanding.y) <= LANDING_HEIGHT
      ) {
        return true;
      }
    }
    return false;
  };
  const still = { x: 0, y: 0, z: 0 };

  const tally = { noFloor: 0, runBlocked: 0, missed: 0, fragile: 0, closest: Number.POSITIVE_INFINITY };
  // Distance 0: no run-up, the recorded commands from a standstill where they
  // start. Enough when the player was nearly still there.
  const distances = [0];
  for (let d = RUN_UP_MIN; d <= RUN_UP_MAX; d += RUN_UP_STEP) distances.push(d);
  for (const distance of distances) {
    const start = settle(
      context.collision,
      {
        x: recordedStart.position.x - heading.x * distance,
        y: recordedStart.position.y + 8,
        z: recordedStart.position.z - heading.z * distance,
      },
      64,
    );
    if (!start) {
      tally.noFloor++;
      continue;
    }
    const runUp = distance === 0 ? [] : runUpTo(context, start, recordedStart.position, heading);
    if (!runUp) {
      tally.runBlocked++;
      continue;
    }
    const script = [...runUp, ...recorded];
    const centre = replayCommands(
      context.collision,
      context.triggers,
      {
        position: start,
        velocity: still,
        grounded: true,
      },
      script,
    );
    if (!lands(centre)) {
      tally.missed++;
      tally.closest = Math.min(tally.closest, horizontal(centre.position, recordedLanding));
      continue;
    }
    let landed = 1;
    for (const [dx, dz] of [
      [NUDGE, 0],
      [-NUDGE, 0],
      [0, NUDGE],
      [0, -NUDGE],
    ]) {
      const nudged = settle(context.collision, { x: start.x + dx, y: start.y + 8, z: start.z + dz }, 64);
      if (!nudged) continue;
      const replay = replayCommands(
        context.collision,
        context.triggers,
        {
          position: nudged,
          velocity: still,
          grounded: true,
        },
        script,
      );
      if (lands(replay)) landed++;
    }
    if (landed < ROBUST_LANDINGS) {
      tally.fragile++;
      continue;
    }
    const takeoffTick = ticks[segment.takeoff].tick;
    return {
      route: {
        id: `${context.demo}@${takeoffTick}`,
        kind: segment.wallJumps > 0 ? "wall_jump" : "jump",
        start,
        yaw: Math.atan2(heading.x, heading.z),
        landing: centre.position,
        ticks: script.length,
        script: encodeScript(script),
        wallJumps: segment.wallJumps,
        replayError: Math.round(best.error * 10) / 10,
        robustness: { landed, tried: 5 },
        source: { demo: context.demo, tick: takeoffTick },
      },
    };
  }
  const parts = [
    tally.noFloor && `${tally.noFloor} run-ups start off the floor`,
    tally.runBlocked && `${tally.runBlocked} are blocked or arrive off line`,
    tally.missed && `${tally.missed} miss the landing (closest ${tally.closest.toFixed(0)} units)`,
    tally.fragile && `${tally.fragile} land only from the exact start`,
  ].filter(Boolean);
  return { rejected: `no run-up from a standstill lands it reliably: ${parts.join(", ")}` };
}

/**
 * Sprint from `start` along `heading` until level with `target`, and return the
 * commands, or null if the run never gets there (a wall, a drop).
 */
function runUpTo(
  context: LearnContext,
  start: Vec3,
  target: Vec3,
  heading: { x: number; z: number },
): RouteCommand[] | null {
  const run = runCommand(heading);
  const profile = new MovementProfile();
  profile.resetPhysicsState(true);
  profile.setTriggerVolumes(context.triggers as TriggerVolume[]);
  let position = { ...start };
  let velocity = { x: 0, y: 0, z: 0 };
  const commands: RouteCommand[] = [];
  for (let n = 1; n <= RUN_UP_TICKS; n++) {
    commands.push(run);
    const result = profile.simulate(position, velocity, toMovementInput(run, n), 1 / 125, context.collision);
    position = result.position;
    velocity = result.velocity;
    if (!result.grounded) return null;
    const along = (position.x - target.x) * heading.x + (position.z - target.z) * heading.z;
    if (along >= 0) return horizontal(position, target) <= 24 ? commands : null;
  }
  return null;
}
