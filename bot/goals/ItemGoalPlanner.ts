/**
 * ItemGoalPlanner — the Phase 1 entry point the brain calls.
 *
 * Assembles the arbiter with the item considerations and gates, and answers one
 * question: "of everything I could go and get, which one?" It deliberately does
 * NOT decide whether the bot should be getting items at all — that stays with
 * the existing StateMachineBrain ladder for Phase 1, so combat behaviour is
 * provably unchanged (design doc §13 Phase 1).
 *
 * Replaces `BotGameState.getNearestPickup()`, which was `pickups.find(p =>
 * p.distance <= max)` — nearest wins, always, with no notion of value.
 */

import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "../../../../shared/server/simulation/physics/constants";
import { type BotWeightProfile, selectWeightProfile } from "../../shared/bot/WeightProfiles";
import type { PickupEntry } from "../../shared/bsp/PickupTable";
import { type ArmorKind, armorAfterPickup, type HealthKind, healthAfterPickup } from "../../shared/items/ItemGrants";
import type { BotGameState, Vec3 } from "../BotGameState";
import type { BotGoal } from "./BotGoal";
import type { ConsiderationContext } from "./Consideration";
import { Danger } from "./considerations/Danger";
import { ItemDenial } from "./considerations/ItemDenial";
import { ItemValue } from "./considerations/ItemValue";
import { ObjectivePush, ObjectiveUrgency } from "./considerations/ObjectivePush";
import { estimateRouteCost, RouteCost } from "./considerations/RouteCost";
import { CarrierProtect, TeamCohesion } from "./considerations/TeamPlay";
import { collectDirectiveGoals } from "./DirectiveGoalSource";
import { type ArbitrationResult, GoalArbiter, type GoalGate, mistakeProbability } from "./GoalArbiter";
import { collectItemGoals } from "./ItemGoalSource";

/**
 * Considerations in a fixed order — the order is the ML feature schema (§10.3),
 * so append, never reorder.
 *
 * Item and objective considerations share one list because they share one
 * currency. A consideration that has nothing to say about a goal returns 0 and
 * abstains, which is what lets "plant the bomb" and "take the Red Armor" be
 * compared at all without either being special-cased.
 */
export const ITEM_CONSIDERATIONS = [
  ItemValue,
  ItemDenial,
  ObjectivePush,
  ObjectiveUrgency,
  TeamCohesion,
  CarrierProtect,
  RouteCost,
  Danger,
] as const;

/**
 * Anything that can price a route. Structural rather than `BotNavGraph` so the
 * estimator stays swappable and tests need no graph — this is the §7.4 seam.
 */
export interface RouteCostSource {
  estimateTravelCost(from: Vec3, to: Vec3): number | null;
}

/**
 * Hard preconditions. These are 0/1 rejections, not low scores: "the server
 * will refuse this pickup" and "this item is mildly unattractive" must never be
 * the same thing.
 */
function buildGates(blockedPickupIds: ReadonlySet<number>): GoalGate[] {
  return [
    // Bot-local failure cooldown (missed the pickup, path failed).
    (goal) => (goal.pickupId !== undefined && blockedPickupIds.has(goal.pickupId) ? "blocked" : null),

    // The server gates health/armor pickups on `after > before`, so an item that
    // would grant nothing is not merely worthless — it is uncollectable, and a
    // bot that walks to one stands on it forever.
    (goal, ctx) => {
      if (!goal.item) return null; // directive goals have no grant to check
      const { type, kind } = goal.item;
      if (type === "health") {
        return healthAfterPickup(ctx.self.health, kind as HealthKind) > ctx.self.health ? null : "no_gain";
      }
      if (type === "armor") {
        return armorAfterPickup(ctx.self.armor, kind as ArmorKind) > ctx.self.armor ? null : "no_gain";
      }
      return null;
    },

    // No route means no goal (design doc §7.4: unreachable is a gate, not a
    // small score) — for ITEMS. An item the bot cannot path to is worthless.
    //
    // An objective is not. It is the thing that has to be done whether or not
    // the nav graph knows a way there, and heading toward it in a straight line
    // is strictly better than standing still. This matters in practice, not in
    // theory: the graph links two nodes only when they have clear line of sight
    // (`BotVision.isPathClear`), so on any map with corners it fragments into
    // per-room islands — measured at 4-10% of node pairs routable across
    // wbomb1, wbomb2 and wdm2. Gating objectives on that made bots ignore the
    // bomb entirely rather than approach it badly.
    (goal, ctx) => (ctx.routeCost === null && !goal.directive ? "unreachable" : null),

    // Item timing: a down item is a goal only once leaving now gets the bot
    // there within its lead window of the respawn — earlier, it would stand
    // waiting for nothing while the game goes on elsewhere.
    (goal, ctx) => {
      if (goal.respawnTick === undefined || ctx.routeCost === null) return null;
      const secondsLeft = (goal.respawnTick - ctx.state.tick) / TICK_RATE;
      const travelSeconds = ctx.routeCost / TIMING_TRAVEL_SPEED;
      return secondsLeft - travelSeconds > TIMING_LEAD_SECONDS * ctx.weights.itemTiming ? "not_yet" : null;
    },
  ];
}

/**
 * Lead window at full item timing: be at the item this long before it returns,
 * at most, to hold it against whoever comes for it.
 */
const TIMING_LEAD_SECONDS = 10;
/** Travel speed assumed for timing, units per second (running, not sprinting). */
const TIMING_TRAVEL_SPEED = 320;

export interface ItemGoalPlannerOptions {
  /** Static pickup table for the map. */
  pickupPositions: readonly PickupEntry[];
  /** Candidate cutoff (straight-line units). */
  maxDistance: number;
  /** Pickup ids on a local failure cooldown. */
  blockedPickupIds: ReadonlySet<number>;
  /**
   * Override the behavioural profile. Normally omitted — the planner selects
   * one from the gametype reported in `match_state`. Tests and future
   * per-bot personalities use this.
   */
  weights?: BotWeightProfile;
  /**
   * Navigation graph, when the map's is loaded.
   *
   * Supplies exact graph travel costs and, critically, honest reachability.
   * Absent, the planner falls back to the Euclidean estimate — which is fine
   * for ranking but cannot tell that an item is behind a wall.
   */
  navGraph?: RouteCostSource | null;
  /**
   * Skip gametype directives entirely.
   *
   * Used by RETREAT: fleeing to heal is a survival act, and an objective order
   * must not drag a bot at 20 HP back into the fight it is escaping.
   */
  ignoreDirectives?: boolean;
  /**
   * Restrict candidates to these pickup types.
   *
   * Used by RETREAT, which means "I am about to die, go heal" — a specific
   * intent, not an open shopping trip. Without it the arbiter would correctly
   * but unhelpfully rank Red Armor above a health bubble at 39 HP (armor is
   * worth more effective HP), which is a fine deathmatch judgement and the
   * wrong answer for a bot that is fleeing. Keeping the filter also holds
   * Phase 1 to its promise that only item CHOICE changes, not bot behaviour.
   */
  typeFilter?: ReadonlySet<string>;
}

export class ItemGoalPlanner {
  private readonly arbiter: GoalArbiter;
  private lastExplain = "";

  /**
   * @param mistakeRate `BotDifficulty.mistakeRate`; 0 makes selection fully
   *   deterministic, which is what the golden-scenario fixtures rely on.
   * @param random injectable RNG, for deterministic tests of the mistake path.
   */
  constructor(mistakeRate = 0, random?: () => number) {
    this.arbiter = new GoalArbiter(ITEM_CONSIDERATIONS, {
      mistakeChance: mistakeProbability(mistakeRate),
      random,
    });
  }

  /** Committed goal id, for the brain's replan logic. */
  get committedGoalId(): string | null {
    return this.arbiter.committedGoalId;
  }

  /** Last decision summary, for bot diagnostics. */
  get explain(): string {
    return this.lastExplain;
  }

  /** Drop commitment — on death, respawn, or a completed/failed goal. */
  reset(): void {
    this.arbiter.reset();
    this.lastExplain = "";
  }

  /**
   * Choose the best item goal, or null when nothing is worth going for.
   * Pure with respect to the world: reads state, mutates only commitment.
   */
  select(state: BotGameState, options: ItemGoalPlannerOptions): ArbitrationResult {
    // Policy comes from the gametype the server already reports. An unknown or
    // not-yet-received gametype resolves to the deathmatch-shaped default, so a
    // bot is never left without a profile.
    const weights =
      options.weights ??
      selectWeightProfile(state.matchState.gametypeName, state.getOwnRole(), state.matchState.roundState);
    // Gates are per-call because the blocked set changes each tick; the arbiter
    // itself is long-lived because it owns the commitment window.
    const gates = buildGates(options.blockedPickupIds);

    let candidates = collectItemGoals(state, {
      pickupPositions: options.pickupPositions,
      maxDistance: options.maxDistance,
      timing: weights.itemTiming > 0,
    });
    if (options.typeFilter) {
      const allowed = options.typeFilter;
      candidates = candidates.filter((c) => c.item !== undefined && allowed.has(c.item.type));
    }

    // Gametype orders compete with items in the same currency. Deliberately NOT
    // subject to `maxDistance` or `typeFilter`: those bound the item shopping
    // list, and an objective is not shopping — a bomb site across the map is
    // still the thing to do.
    if (!options.ignoreDirectives) {
      candidates = candidates.concat(collectDirectiveGoals(state));
    }

    const result = this.arbiter.select(
      candidates,
      (goal) => this.makeContext(goal, state, weights, options.navGraph ?? null),
      state.tick,
      gates,
    );
    this.lastExplain = result.explain;
    return result;
  }

  private makeContext(
    goal: BotGoal,
    state: BotGameState,
    weights: BotWeightProfile,
    navGraph: RouteCostSource | null,
  ): ConsiderationContext {
    // Graph distance when the map is loaded — exact, and honest about
    // unreachable targets. Euclidean otherwise, which ranks acceptably but
    // cannot see walls.
    const routeCost = navGraph
      ? navGraph.estimateTravelCost(state.self.position, goal.position)
      : estimateRouteCost(state.self.position, goal.position);
    return { goal, self: state.self, state, routeCost, weights };
  }
}
