/**
 * route_cost — a DISCOUNT for how far away the goal is.
 *
 * Deliberately not an attractor. If proximity were a reason to pursue something,
 * a 5 HP bubble two steps away would score ~1.0 and beat a Mega across the room;
 * "close" is not a reason to want a thing, it only makes a thing you already
 * want cheaper. See Consideration.ts for the role split.
 *
 * The cost itself is injected (never computed here) so the estimator can be
 * upgraded from Euclidean to landmark distances to measured traversal times
 * without touching this file — design doc §7.4.
 */

import { type Consideration, type ConsiderationContext, clamp01 } from "../Consideration";

/**
 * Cost at which the discount halves. Tuned against the brain's existing
 * PICKUP_SEEK_RANGE of 1500 units: with the Phase 1 detour factor a 1500-unit
 * item estimates around 2000, landing near a 0.37 discount — far enough to
 * matter, not so far that anything distant is written off.
 */
export const ROUTE_HALF_COST = 1200;

export const RouteCost: Consideration = {
  id: "route_cost",
  role: "discount",
  // Physics, not policy: no gametype should make distance cheaper.
  weightKey: null,

  score(ctx: ConsiderationContext): number {
    // Unreachable is handled by a hard gate in the arbiter, not by a small
    // score — a route that does not exist must not be merely unattractive.
    //
    // The gate exempts OBJECTIVES, which still have to be attempted whether or
    // not the nav graph knows a way there. Scoring those zero here would gate
    // them a second time by the back door, so they fall back to straight-line
    // distance: a worse estimate than a real route, and a far better one than
    // giving up.
    if (ctx.routeCost === null) {
      return ctx.goal.directive
        ? clamp01(1 / (1 + estimateRouteCost(ctx.self.position, ctx.goal.position) / ROUTE_HALF_COST))
        : 0;
    }
    if (ctx.routeCost <= 0) return 1;
    return clamp01(1 / (1 + ctx.routeCost / ROUTE_HALF_COST));
  },
};

/** Vertical travel is dearer than horizontal — climbing costs time and speed. */
const VERTICAL_PENALTY = 2.0;

/**
 * Phase 1 route estimate: straight line inflated by a detour factor.
 *
 * Wrong by a roughly constant factor, which is acceptable *for ranking* because
 * every candidate is wrong in the same direction. Exact A* runs once, for the
 * winner only. Replaced wholesale in Phase 3.
 */
export const DETOUR_FACTOR = 1.35;

export function estimateRouteCost(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const horizontal = Math.sqrt(dx * dx + dz * dz);
  return (horizontal + Math.abs(dy) * VERTICAL_PENALTY) * DETOUR_FACTOR;
}
