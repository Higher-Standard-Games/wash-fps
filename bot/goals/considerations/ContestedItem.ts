/**
 * ContestedItem — an item the opponent keeps taking.
 *
 * Attractor, weighted by `itemDenial`: being there first takes it from them.
 * The strength comes from what the bot learned in this match
 * (ConsiderationContext.contested, strategy/OpponentModel): an armor the
 * opponent has taken twice is worth contesting, one taken at every respawn is
 * worth a lot. Zero for anything they have not been seen or heard taking.
 */

import { type Consideration, type ConsiderationContext, clamp01 } from "../Consideration";

export const ContestedItem: Consideration = {
  id: "contested_item",
  role: "attractor",
  weightKey: "itemDenial",

  score(ctx: ConsiderationContext): number {
    const id = ctx.goal.pickupId;
    if (id === undefined || !ctx.contested) return 0;
    return clamp01(ctx.contested.get(id) ?? 0);
  },
};
