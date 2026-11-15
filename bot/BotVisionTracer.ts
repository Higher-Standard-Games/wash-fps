/**
 * BotVisionTracer — keeps a bot's feet clear of walls, corners and ledges.
 *
 * Every state decides where it wants to move: along a route, round a site, in
 * a fight's strafe, after an enemy. None of them sees the room. The tracer
 * takes the move a decision asks for and returns the nearest heading that
 * fits through the world, so every state gets the same sense of walls:
 *
 * 1. Sweep the standing hull along the wanted heading, as far as the bot
 *    covers in LOOKAHEAD_SECONDS at its speed (never past the point it is
 *    making for, so a wall behind a waypoint does not count), and look for
 *    floor under the end.
 * 2. Clear: keep the heading, leaned away from a wall close at one side, so
 *    the bot runs the middle of a corridor instead of along its wall.
 * 3. Blocked: try headings either side, and take the one that runs clear the
 *    furthest, nearest the wanted heading, on the side chosen last time while
 *    that side still works, so the bot rounds a corner instead of scraping it
 *    and does not swing left and right at a wall.
 *
 * A surface the sweep meets that faces up (a ramp, a stair) is floor, not a
 * wall. A heading that runs out over a ledge counts as blocked, unless the
 * decision means to drop (`dropping`).
 *
 * Only the feet are steered. The view, and so a fight's aim, stays as the
 * decision left it.
 *
 * It also says beforehand whether a trick will work from where the bot is,
 * by running the game's own movement code forward (`rollout`), as the nav
 * graph's jump analysis does: whether a jump at a wall ends standing on top
 * of it (stepping up, or by the ledge grab), and whether a wall jump now ends
 * nearer the goal than not jumping. A trick is taken because it works here,
 * not because a waypoint says so.
 */

import { InputButtons } from "../../../engine/network/components/InputComponent";
import type { MovementInput } from "../../../engine/network/systems/movement/MovementProfile";
import type { AABB, CollisionWorld } from "../../../shared/collision/CollisionWorld";
import { MovementProfile } from "../simulation/MovementProfile";
import type { Vec3 } from "./BotGameState";

/** Room kept between the hull and a wall it runs past, units: a sweep that grazes a corner counts as blocked. */
const WALL_MARGIN = 8;
/**
 * The standing hull around an origin 24 above the feet, clear of the bottom
 * 18 units a step climbs, and WALL_MARGIN wider each side.
 */
const SWEEP_BOUNDS: AABB = {
  min: { x: -15 - WALL_MARGIN, y: -6, z: -15 - WALL_MARGIN },
  max: { x: 15 + WALL_MARGIN, y: 40, z: 15 + WALL_MARGIN },
};
/** The hull alone, for a move along a route line already built clear of the walls. */
const HULL_BOUNDS: AABB = {
  min: { x: -15, y: -6, z: -15 },
  max: { x: 15, y: 40, z: 15 },
};
/** How far ahead the bot looks, in seconds of travel at its speed. */
const LOOKAHEAD_SECONDS = 0.45;
const MIN_LOOKAHEAD = 96;
const MAX_LOOKAHEAD = 320;
/** Speed assumed for a bot starting off, units/s. */
const MIN_SPEED = 220;
/** Headings tried either side of the wanted one, radians. */
const OFFSETS = [12, 24, 36, 50, 65, 80].map((d) => (d * Math.PI) / 180);
/** A hit whose normal points up this much is floor (a ramp or stair), not a wall. */
const FLOOR_NORMAL_Y = 0.7;
/** Floor is looked for this far under the end of a sweep, units. */
const FLOOR_DEPTH = 80;
const HULL_HALF = 16;
/**
 * The fan of rays that leans the heading off walls: angle off the heading,
 * how hard a wall there pushes, and the gap from the hull inside which it
 * starts to, as a share of the fan's reach (the ray nearly ahead sees a
 * corner coming; the one square to the side only a wall close by).
 */
const FAN: readonly (readonly [number, number, number])[] = [
  [(30 * Math.PI) / 180, 1, 1],
  [(60 * Math.PI) / 180, 0.7, 0.6],
  [(90 * Math.PI) / 180, 0.45, 0.35],
];
/** The fan reaches this far past the hull: the bot's travel in FAN_SECONDS, within bounds, units. */
const FAN_SECONDS = 0.4;
const FAN_MIN_REACH = 56;
const FAN_MAX_REACH = 200;
/** Radians of turn for a wall touching the hull on the fan's strongest ray. */
const FAN_GAIN = 0.35;
/** The most the lean turns the heading, radians; less along a route line, which must not be lost. */
const MAX_LEAN = (30 * Math.PI) / 180;
const LINE_LEAN = (15 * Math.PI) / 180;
/** A side chosen to get round something is kept this long while it works, ticks. */
const SIDE_COMMIT_TICKS = 50;
/** Changing to the other side costs this much of a score. */
const SIDE_SWITCH_COST = 0.35;
/** A turn away from the wanted heading has to score this much better to be taken. */
const MIN_GAIN = 0.2;

/** Server ticks per second, for rollouts. */
const ROLLOUT_RATE = 125;
/** A climb is looked for over this long after the jump, ticks: the jump, a ledge grab and its pull-up. */
const CLIMB_TICKS = 150;
/** A wall jump's flight is followed this long, ticks. */
const WALL_JUMP_TICKS = 125;
/** A climb has to end on ground at least this much higher than the bot stood. */
const MIN_CLIMB = 20;
/** A flight rising this much faster than the same flight without the press had a wall jump, units/s. */
const WALL_JUMP_RISE = 100;

/** One command of a rollout: where the keys point (world) and which are held. */
export interface RolloutCommand {
  yaw: number;
  buttons: number;
}

/** Where a rollout ends. */
export interface RolloutEnd {
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  ticks: number;
}

export interface SteerRequest {
  tick: number;
  /** Origin, 24 above the feet. */
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  /** World heading the decision wants to move, radians (atan2(x, z)). */
  yaw: number;
  /** Distance to the point the bot is making for, when it has one. */
  targetDistance?: number;
  /** The move means to go down off an edge: a ledge ahead is the way, not a hazard. */
  dropping?: boolean;
  /**
   * Following a route line, which was built clear of the walls: a smaller
   * lean, and only what the hull itself would hit turns the bot. Leaning it
   * far off the line loses the line.
   */
  onLine?: boolean;
}

export interface SteerResult {
  /** World heading to move. */
  yaw: number;
  /** How much of the lookahead runs clear on that heading, 0..1. */
  clear: number;
  /** Turned off the wanted heading to get round something (not just leaned). */
  turned: boolean;
}

interface Probe {
  /** Share of the run that is clear, 0..1. */
  clear: number;
  /** Floor under the end. */
  floor: boolean;
}

export class BotVisionTracer {
  private side: { sign: number; untilTick: number } | null = null;

  constructor(private readonly world: CollisionWorld) {}

  /** The heading to move on for `request`, or null to leave it alone (in the air, or standing). */
  steer(request: SteerRequest): SteerResult | null {
    if (!request.grounded) return null;
    const speed = Math.max(MIN_SPEED, Math.hypot(request.velocity.x, request.velocity.z));
    let reach = Math.min(MAX_LOOKAHEAD, Math.max(MIN_LOOKAHEAD, speed * LOOKAHEAD_SECONDS));
    if (request.targetDistance !== undefined) reach = Math.max(32, Math.min(reach, request.targetDistance + HULL_HALF));

    const bounds = request.onLine ? HULL_BOUNDS : SWEEP_BOUNDS;
    const wanted = this.probe(request.position, request.yaw, reach, bounds);
    const mindFloor = request.dropping !== true;
    if (wanted.clear >= 1 && (wanted.floor || !mindFloor)) {
      const lean = this.lean(request.position, request.yaw, speed, request.onLine ? LINE_LEAN : MAX_LEAN);
      return { yaw: request.yaw + lean, clear: 1, turned: false };
    }

    const committed = this.side && request.tick < this.side.untilTick ? this.side.sign : 0;
    const stay = this.score(wanted, 0, 0, committed, mindFloor);
    let best = { yaw: request.yaw, score: stay, clear: wanted.clear, sign: 0 };
    for (const offset of OFFSETS) {
      for (const sign of [-1, 1]) {
        const yaw = request.yaw + sign * offset;
        const probe = this.probe(request.position, yaw, reach, bounds);
        const score = this.score(probe, offset, sign, committed, mindFloor);
        if (score > best.score) best = { yaw, score, clear: probe.clear, sign };
      }
    }
    if (best.sign === 0 || best.score < stay + MIN_GAIN) {
      return { yaw: request.yaw, clear: wanted.clear, turned: false };
    }
    this.side = { sign: best.sign, untilTick: request.tick + SIDE_COMMIT_TICKS };
    return { yaw: best.yaw, clear: best.clear, turned: true };
  }

  /**
   * Run the game's movement forward from a state, one command a tick, until
   * `stop` says so or `maxTicks` pass. The keys move along `yaw`; the view
   * looks the same way, which the ledge grab reads for forward.
   */
  rollout(
    start: { position: Vec3; velocity: Vec3; grounded: boolean },
    command: (tick: number, at: RolloutEnd) => RolloutCommand,
    maxTicks: number,
    stop?: (at: RolloutEnd) => boolean,
  ): RolloutEnd {
    const profile = new MovementProfile();
    profile.resetPhysicsState(start.grounded);
    let at: RolloutEnd = {
      position: { ...start.position },
      velocity: { ...start.velocity },
      grounded: start.grounded,
      ticks: 0,
    };
    for (let tick = 1; tick <= maxTicks; tick++) {
      const { yaw, buttons } = command(tick, at);
      const input: MovementInput = {
        direction: { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) },
        viewAngles: { pitch: 0, yaw },
        buttons,
        sequence: tick,
        simStep: tick,
        isPressed(button: number): boolean {
          return (this.buttons & button) !== 0;
        },
      } as MovementInput;
      const result = profile.simulate(at.position, at.velocity, input, 1 / ROLLOUT_RATE, this.world);
      at = { position: result.position, velocity: result.velocity, grounded: result.grounded, ticks: tick };
      if (stop?.(at)) break;
    }
    return at;
  }

  /**
   * Whether jumping now along `yaw`, holding forward, ends standing on ground
   * higher than here: onto a box by the jump, or a ledge by the grab and its
   * pull-up. Returns where the bot stands then, or null.
   */
  climbByJump(position: Vec3, velocity: Vec3, yaw: number): Vec3 | null {
    const end = this.rollout(
      { position, velocity, grounded: true },
      (tick) => ({ yaw, buttons: InputButtons.FORWARD | (tick <= 2 ? InputButtons.JUMP : 0) }),
      CLIMB_TICKS,
      (at) => at.ticks > 4 && at.grounded,
    );
    if (!end.grounded || end.position.y - position.y < MIN_CLIMB) return null;
    return end.position;
  }

  /**
   * In the air: how much nearer `goal` a wall jump pressed now ends than
   * carrying on without one, units (negative: further), or null when no wall
   * jump would happen here. Both flights hold forward along `yaw` and end on
   * landing or after WALL_JUMP_TICKS.
   */
  wallJumpGain(position: Vec3, velocity: Vec3, yaw: number, goal: Vec3): number | null {
    const landed = (at: RolloutEnd) => at.ticks > 2 && at.grounded;
    const start = { position, velocity, grounded: false };
    const plainRise: number[] = [];
    const plain = this.rollout(
      start,
      (tick, at) => {
        plainRise[tick] = at.velocity.y;
        return { yaw, buttons: InputButtons.FORWARD };
      },
      WALL_JUMP_TICKS,
      landed,
    );
    let launched = false;
    const jumped = this.rollout(
      start,
      (tick, at) => {
        // A wall jump throws the bot up off the wall, far faster than the flight without it
        if (tick > 1 && at.velocity.y > (plainRise[tick] ?? Number.NEGATIVE_INFINITY) + WALL_JUMP_RISE) launched = true;
        return { yaw, buttons: InputButtons.FORWARD | (tick === 1 ? InputButtons.JUMP : 0) };
      },
      WALL_JUMP_TICKS,
      landed,
    );
    if (!launched) return null;
    const distance = (at: RolloutEnd) =>
      Math.hypot(goal.x - at.position.x, (goal.y - at.position.y) * 1.5, goal.z - at.position.z);
    return distance(plain) - distance(jumped);
  }

  /** Whether a wall stands within `reach` of the hull at the origin's height, any way round. */
  wallWithin(position: Vec3, reach: number): boolean {
    const length = reach + HULL_HALF;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const hit = this.world.trace(position, {
        x: position.x + Math.sin(a) * length,
        y: position.y,
        z: position.z + Math.cos(a) * length,
      });
      if (hit.fraction < 1 && !(hit.normal && Math.abs(hit.normal.y) > 0.3)) return true;
    }
    return false;
  }

  /** Forget the side chosen: a new route, or a respawn. */
  reset(): void {
    this.side = null;
  }

  private score(probe: Probe, offset: number, sign: number, committed: number, mindFloor: boolean): number {
    const ledge = mindFloor && !probe.floor ? 1 : 0;
    const switching = committed !== 0 && sign !== 0 && sign !== committed ? SIDE_SWITCH_COST : 0;
    return probe.clear * 2 + Math.cos(offset) - ledge * 1.5 - switching;
  }

  /** Sweep the hull `reach` along `yaw` from `from`, and look for floor at the end. */
  private probe(from: Vec3, yaw: number, reach: number, bounds: AABB): Probe {
    const dx = Math.sin(yaw);
    const dz = Math.cos(yaw);
    const end = { x: from.x + dx * reach, y: from.y, z: from.z + dz * reach };
    let sweep = this.world.trace(from, end, bounds);
    // Within the margin of a wall already, the wider box starts inside it and
    // every heading would look blocked: the hull alone says which ways are open
    if (sweep.fraction <= 0 && bounds !== HULL_BOUNDS) sweep = this.world.trace(from, end, HULL_BOUNDS);
    // Running up a ramp meets it like a wall; a surface facing up is floor
    const blocked = sweep.fraction < 1 && !(sweep.normal && sweep.normal.y >= FLOOR_NORMAL_Y);
    const clear = blocked ? sweep.fraction : 1;
    const at = clear >= 1 ? end : { x: from.x + dx * reach * clear, y: from.y, z: from.z + dz * reach * clear };
    const down = this.world.trace(at, { x: at.x, y: at.y - FLOOR_DEPTH, z: at.z });
    return { clear, floor: down.fraction < 1 };
  }

  /**
   * A turn away from the walls ahead and at the sides, radians: a fan of rays
   * either side of the heading, each wall pushing the harder the nearer it
   * is and the more nearly ahead. Walls either side in a corridor push
   * against each other, so the bot runs its middle; a corner coming up on
   * one side turns it wide before it gets there. Surfaces facing up (ramps,
   * stairs) do not push.
   */
  private lean(from: Vec3, yaw: number, speed: number, cap: number): number {
    const room = Math.min(FAN_MAX_REACH, Math.max(FAN_MIN_REACH, speed * FAN_SECONDS));
    const reach = HULL_HALF + room;
    let turn = 0;
    for (const [angle, weight, comfort] of FAN) {
      for (const side of [-1, 1]) {
        const a = yaw + side * angle;
        const hit = this.world.trace(from, {
          x: from.x + Math.sin(a) * reach,
          y: from.y,
          z: from.z + Math.cos(a) * reach,
        });
        if (hit.fraction >= 1 || (hit.normal && hit.normal.y >= FLOOR_NORMAL_Y)) continue;
        const gap = hit.fraction * reach - HULL_HALF;
        const push = Math.max(0, 1 - gap / (comfort * room));
        // A wall on the right (+) turns the heading left (−)
        turn -= side * weight * push;
      }
    }
    return Math.max(-cap, Math.min(cap, turn * FAN_GAIN));
  }
}
