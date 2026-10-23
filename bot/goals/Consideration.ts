/**
 * Consideration — one pure scoring function over a candidate goal.
 *
 * The whole point of the design (docs/research/BOT_WEIGHTS_AND_GOALS.md §3) is
 * that these are independently developable: a consideration depends on nothing
 * but its context, so improving one is a change to one function and one test,
 * with no effect on arbitration or on any other consideration.
 *
 * Two roles, and the distinction is load-bearing:
 *
 *   attractor — a REASON to pursue the goal (item value, denial). These compete
 *               for the maximum; the best reason drives the decision.
 *   discount  — a reason the goal is EXPENSIVE or unwise (route cost, danger).
 *               These multiply the result.
 *
 * Keeping them separate is what stops a close, worthless item from winning:
 * were `route_cost` an attractor, a 5 HP bubble two steps away would score ~1.0
 * on proximity and beat a Mega across the room. As a discount it can only ever
 * scale down a reason that already exists.
 */

import type { BotWeightProfile } from "../../shared/bot/WeightProfiles";
import type { BotGameState, BotSelf } from "../BotGameState";
import type { BotGoal } from "./BotGoal";

export type ConsiderationRole = "attractor" | "discount";

export interface ConsiderationContext {
  /** The candidate being scored. */
  goal: BotGoal;
  self: BotSelf;
  state: BotGameState;
  /**
   * Estimated travel cost to the goal, INJECTED rather than computed here.
   *
   * Phase 1 uses a Euclidean × detour estimate; later phases swap in landmark
   * distances or measured traversal times. Considerations must never compute
   * this themselves or that upgrade becomes a rewrite (design doc §7.4).
   * `null` means unreachable.
   */
  routeCost: number | null;
  weights: BotWeightProfile;
}

export interface Consideration {
  /** Stable id — appears in decision traces and in the ML feature vector. */
  readonly id: string;
  readonly role: ConsiderationRole;
  /**
   * Which gametype weight scales this consideration, or null when it is
   * physics rather than policy (route cost) or a modifier (danger).
   */
  readonly weightKey: keyof BotWeightProfile | null;
  /**
   * Pure. MUST return a finite number in [0, 1].
   * No side effects, no randomness, no clock reads — arbitration has to be
   * reproducible from a context alone for the golden-scenario fixtures to work.
   */
  score(ctx: ConsiderationContext): number;
}

/** Clamp to the [0,1] contract. Cheap insurance against a bad curve. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
