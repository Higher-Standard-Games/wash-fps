/**
 * RouteLine — the line a bot runs along through the plain walking stretch of
 * a route, decided once when the route is planned.
 *
 * A route is a chain of graph nodes, and running node to node takes the
 * inside of every corner and the side of every room the nodes happen to sit
 * at. A player picks a line through a room before entering it. This builds
 * one from the route:
 *
 * 1. Pull the string: skip each node the standing hull can run straight past
 *    with floor under it.
 * 2. Move each remaining corner off the walls near it, toward LINE_CLEARANCE.
 * 3. Where a stretch still passes closer than LINE_TIGHT to a wall, add a
 *    point there moved off it.
 *
 * Every change keeps both stretches next to it walkable. The first point is
 * where the bot stands and the last is exact: the start of the next jump,
 * pad, drop or precise approach, or the end of the route.
 *
 * Pure: the world is passed in, so tests and the offline check
 * (`npm run bot:routes`) use it without a match.
 */

import type { Vec3 } from "./BotGameState";
import type { NavNode, NavPath } from "./BotNavGraph";

/** Clearance the line keeps from walls where the room allows, from the hull's side. */
export const LINE_CLEARANCE = 48;
/** A stretch passing closer than this to a wall gets a point moved off it. */
export const LINE_TIGHT = 24;
/** Moves off a wall are tried in steps of this, up to LINE_CLEARANCE. */
const PUSH_STEP = 16;
/** Stretches are sampled this often for their clearance. */
const SAMPLE_STEP = 32;
/** Passes of corner moves and added points. */
const PASSES = 2;
/** Floor and item nodes sit on the surface; the standing origin is this far above. */
const STANDING_LIFT = 24;

export interface RouteWorld {
  /** A clear straight run for the standing hull with floor under it, origin to origin. */
  walkable(from: Vec3, to: Vec3): boolean;
  /** Gap from the hull to the nearest wall around an origin, and the way away from walls closer than `want`. */
  clearance(at: Vec3, want: number): { gap: number; away: { x: number; z: number } };
}

export interface RouteLine {
  /** Standing origins to run through, in order. */
  points: Vec3[];
  /** Index in `path.steps` of the step the line ends at the start of; `path.steps.length` at the route's end. */
  endStep: number;
}

/** The standing origin of a route node. */
export function standingOrigin(node: NavNode): Vec3 {
  const lifted = node.type === "floor" || node.type === "item";
  return { x: node.position.x, y: node.position.y + (lifted ? STANDING_LIFT : 0), z: node.position.z };
}

/** The steps from `fromStep` a line can cover: plain walks that need no exact approach. */
export function lineEndStep(path: NavPath, fromStep: number): number {
  let end = fromStep;
  while (end < path.steps.length && path.steps[end].type === "walk" && !path.steps[end].requiresPreciseApproach) end++;
  return end;
}

export function buildRouteLine(start: Vec3, path: NavPath, fromStep: number, world: RouteWorld): RouteLine {
  const endStep = lineEndStep(path, fromStep);
  const raw: Vec3[] = [start];
  for (let i = fromStep; i < endStep; i++) raw.push(standingOrigin(path.steps[i].to));
  // With walks covered, the last one's end is where the next step starts; with
  // none, the line runs to the next step's start.
  if (endStep === fromStep && endStep < path.steps.length) raw.push(standingOrigin(path.steps[endStep].from));
  if (raw.length < 2) return { points: raw, endStep };

  let points = pullString(raw, world);
  for (let pass = 0; pass < PASSES; pass++) {
    points = moveCornersOffWalls(points, world);
    points = addPointsOffWalls(points, world);
  }
  return { points, endStep };
}

/** Keep only the points the hull cannot run straight past. */
function pullString(raw: readonly Vec3[], world: RouteWorld): Vec3[] {
  const kept = [raw[0]];
  let from = 0;
  while (from < raw.length - 1) {
    let next = from + 1;
    for (let far = raw.length - 1; far > from + 1; far--) {
      if (world.walkable(raw[from], raw[far])) {
        next = far;
        break;
      }
    }
    kept.push(raw[next]);
    from = next;
  }
  return kept;
}

/** A point moved off the walls near it, as far as the stretches either side stay walkable. */
function offWalls(point: Vec3, before: Vec3, after: Vec3, world: RouteWorld): Vec3 {
  const start = world.clearance(point, LINE_CLEARANCE);
  if (start.gap >= LINE_CLEARANCE || (start.away.x === 0 && start.away.z === 0)) return point;
  let best = point;
  let bestGap = start.gap;
  for (let push = PUSH_STEP; push <= LINE_CLEARANCE - start.gap + 1e-6; push += PUSH_STEP) {
    const moved = { x: point.x + start.away.x * push, y: point.y, z: point.z + start.away.z * push };
    if (!world.walkable(before, moved) || !world.walkable(moved, after)) break;
    const gap = world.clearance(moved, LINE_CLEARANCE).gap;
    if (gap > bestGap) {
      best = moved;
      bestGap = gap;
    }
  }
  return best;
}

function moveCornersOffWalls(points: readonly Vec3[], world: RouteWorld): Vec3[] {
  const moved = [...points];
  for (let i = 1; i < moved.length - 1; i++) moved[i] = offWalls(moved[i], moved[i - 1], moved[i + 1], world);
  return moved;
}

/** Where a stretch passes closer than LINE_TIGHT to a wall, add a point there moved off it. */
function addPointsOffWalls(points: readonly Vec3[], world: RouteWorld): Vec3[] {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const samples = Math.floor(length / SAMPLE_STEP);
    let tightest: Vec3 | null = null;
    let tightestGap = LINE_TIGHT;
    for (let s = 1; s < samples; s++) {
      const t = s / samples;
      const at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
      const gap = world.clearance(at, LINE_CLEARANCE).gap;
      if (gap < tightestGap) {
        tightestGap = gap;
        tightest = at;
      }
    }
    if (tightest) {
      const moved = offWalls(tightest, a, b, world);
      if (moved !== tightest) out.push(moved);
    }
    out.push(b);
  }
  return out;
}

/**
 * The point `ahead` units along `points` past the point on the line nearest
 * `at`, searched from stretch `from` on. Returns the point and the stretch
 * it lies on, so the next call can start there.
 */
export function pointAlong(
  points: readonly Vec3[],
  at: { x: number; z: number },
  ahead: number,
  from = 0,
): { point: Vec3; stretch: number } {
  let stretch = Math.max(0, Math.min(from, points.length - 2));
  let best = { stretch, t: 0, distance: Number.POSITIVE_INFINITY };
  // Nearest point on this stretch or the next two: the line is followed forward.
  for (let i = stretch; i < Math.min(points.length - 1, stretch + 3); i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq < 1 ? 1 : Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.z - a.z) * dz) / lengthSq));
    const distance = Math.hypot(at.x - (a.x + dx * t), at.z - (a.z + dz * t));
    if (distance < best.distance) best = { stretch: i, t, distance };
  }
  stretch = best.stretch;
  let left = ahead;
  let a = lerp(points[stretch], points[stretch + 1], best.t);
  for (let i = stretch; i < points.length - 1; i++) {
    const b = points[i + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length >= left) return { point: lerp(a, b, length < 1e-6 ? 1 : left / length), stretch: best.stretch };
    left -= length;
    a = b;
  }
  return { point: points[points.length - 1], stretch: best.stretch };
}

function lerp(a: Vec3, b: Vec3 | undefined, t: number): Vec3 {
  if (!b) return a;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}
