/**
 * ItemGoalSource — turns map knowledge into scorable item goals.
 *
 * This is where the identity the bot has always had but always discarded comes
 * back. `BotVision.mapKnowledge.pickupPositions` is a full `PickupEntry[]` —
 * id, classname, type, kind, amount, position, shared with the server — but the
 * only consumer was `findNearestItem(from, type)`, which threw away everything
 * except the position and matched on a coarse type string. That is why a bot
 * could not tell Red Armor from an armor shard.
 *
 * Candidate generation is bounded (design doc §7.5): the nearest N by straight
 * line, since scoring is cheap but not free and a map can hold ~25 live items.
 * Major items (armors, Mega Health, powerups) are always candidates while they
 * are up, at any distance: they are what an item route is planned around, and
 * the nearest twelve leave them out from most of a map.
 */

import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "../../../../shared/server/simulation/physics/constants";
import type { PickupEntry } from "../../shared/bsp/PickupTable";
import { itemRespawnSeconds, MAJOR_ITEM_FIRST_SPAWN_SECONDS } from "../../shared/items/ItemRespawn";
import { type BotGameState, type Vec3, vec3Distance } from "../BotGameState";
import { type BotGoal, droppedItemGoalId, staticItemGoalId } from "./BotGoal";
import { isMajorItem } from "./considerations/ItemFacts";

/** Upper bound on candidates scored per decision, besides major items. */
export const MAX_ITEM_CANDIDATES = 12;

export interface ItemGoalSourceOptions {
  /** Static pickup table for the loaded map (from BotVision.mapKnowledge). */
  pickupPositions: readonly PickupEntry[];
  /** Ignore candidates beyond this straight-line distance. */
  maxDistance: number;
  /** Also offer major items that are down but known to return (item timing). */
  timing?: boolean;
}

/**
 * When a down pickup returns, as a server tick, or null if unknown: from when it
 * was seen taken, or for an armor or Mega not yet spawned, from the match start.
 */
export function respawnTickOf(state: BotGameState, entry: PickupEntry): number | null {
  const taken = state.itemTakenTick.get(entry.id);
  if (taken !== undefined) return taken + Math.round(itemRespawnSeconds(entry.type, entry.kind) * TICK_RATE);
  if (state.liveSinceTick === null) return null;
  const first = state.liveSinceTick + Math.round(MAJOR_ITEM_FIRST_SPAWN_SECONDS * TICK_RATE);
  return state.tick < first ? first : null;
}

/**
 * Build the candidate item goals for this tick.
 *
 * Static pickups are filtered by the authoritative `pickupActiveMask` before
 * scoring — an item the server says is collected is not a candidate at all,
 * rather than a candidate that scores badly.
 */
export function collectItemGoals(state: BotGameState, options: ItemGoalSourceOptions): BotGoal[] {
  const from = state.self.position;
  const goals: Array<{ goal: BotGoal; distance: number }> = [];
  const majors: Array<{ goal: BotGoal; distance: number }> = [];

  for (const entry of options.pickupPositions) {
    // Authoritative availability. An absent mask (older payload) means unknown,
    // and we optimistically allow it — the gate on arrival still applies.
    const major = isMajorItem(entry.type, entry.kind);
    let respawnTick: number | undefined;
    if (state.pickupActiveMask.length > entry.id && state.pickupActiveMask[entry.id] === false) {
      const back = major && options.timing ? respawnTickOf(state, entry) : null;
      if (back === null || back <= state.tick) continue;
      respawnTick = back;
    }

    const distance = vec3Distance(from, entry.position);
    if (distance > options.maxDistance && !major) continue;

    (major ? majors : goals).push({
      distance,
      goal: {
        id: staticItemGoalId(entry.id),
        kind: "acquire_item",
        position: entry.position,
        pickupId: entry.id,
        item: { type: entry.type, kind: entry.kind, amount: entry.amount },
        respawnTick,
      },
    });
  }

  // Dropped weapons are live snapshot entities with no static id. They carry a
  // weaponId in `type` (the weaponMeta component), not a pickup kind.
  for (const dropped of state.pickups) {
    const distance = dropped.distance;
    if (distance > options.maxDistance) continue;
    goals.push({
      distance,
      goal: {
        id: droppedItemGoalId(dropped.entityId),
        kind: "acquire_item",
        position: dropped.position,
        entityId: dropped.entityId,
        item: { type: "weapon", kind: dropped.type },
      },
    });
  }

  goals.sort((a, b) => a.distance - b.distance);
  return [...majors, ...goals.slice(0, MAX_ITEM_CANDIDATES)].map((c) => c.goal);
}

/** Straight-line distance helper shared with the brain's fallbacks. */
export function goalDistance(from: Vec3, goal: BotGoal): number {
  return vec3Distance(from, goal.position);
}
