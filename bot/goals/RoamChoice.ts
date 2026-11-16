/**
 * What a roaming bot does next, scored: take the item arbiter's best goal,
 * hunt the freshest enemy sighting, or hold its ground (in a mode that keeps
 * a territory, GametypeHabits). All three are desires in the arbiter's
 * currency (GoalArbiter: gate × attraction × discount), so a strategy or a
 * weight profile moves one comparison instead of a ladder of rules.
 *
 * Used with BotOptions.scoredGoals. Without it the brain keeps its ladder:
 * shop when the best item clears the hunt bar, else hold the territory,
 * else take any item goal, else hunt.
 */

import type { BotWeightProfile } from "../../shared/bot/WeightProfiles";

/** Hunting a fresh sighting is worth this at aggression 0 (the brain's seek bar). */
export const HUNT_DESIRE_BASE = 0.2;
/** ...and this more per unit of the gametype's aggression. */
export const HUNT_DESIRE_PER_AGGRESSION = 0.25;
/** Holding ground is worth this per unit of the profile's mapControl. */
export const HOLD_DESIRE_PER_CONTROL = 0.5;

export type RoamPick = "item" | "hunt" | "hold";

/**
 * What hunting a sighting is worth: the seek bar at its freshest (`fresh` 1,
 * just seen), falling to nothing as it goes stale (0, or no sighting).
 */
export function huntDesire(weights: BotWeightProfile, seekScale: number, fresh: number): number {
  if (!(fresh > 0)) return 0;
  return (HUNT_DESIRE_BASE + HUNT_DESIRE_PER_AGGRESSION * weights.aggression) * seekScale * Math.min(1, fresh);
}

/** What holding a territory is worth, in a mode that keeps one; 0 elsewhere. */
export function holdDesire(weights: BotWeightProfile, keepsTerritory: boolean): number {
  return keepsTerritory ? HOLD_DESIRE_PER_CONTROL * weights.mapControl : 0;
}

/**
 * The best of the three, or null when none is worth anything. An item wins
 * ties: it is a concrete thing to fetch, the others are places to be.
 */
export function chooseRoam(desires: { item: number; hunt: number; hold: number }): RoamPick | null {
  const { item, hunt, hold } = desires;
  if (item <= 0 && hunt <= 0 && hold <= 0) return null;
  if (item >= hunt && item >= hold) return "item";
  return hunt >= hold ? "hunt" : "hold";
}
