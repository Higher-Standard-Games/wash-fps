/**
 * item_denial — the value of the enemy NOT having this.
 *
 * Separate from `item_value` on purpose. A bot at full armor gains nothing from
 * Red Armor, so `item_value` correctly scores 0 — but taking it anyway to keep
 * it off the map is real arena play. Denial is the attractor that expresses it.
 *
 * Note the interaction with gating: the server refuses a pickup that would give
 * no benefit (`PickupSystem` skips when `after <= before`), so a goal whose only
 * score is denial gets gated out for health/armor. Denial therefore mostly
 * matters for powerups and weapons, which have no such rule — which is the
 * correct arena behaviour anyway: you contest quad, you do not body-block armor.
 */

import { type Consideration, type ConsiderationContext, clamp01 } from "../Consideration";
import { denialValue } from "./ItemFacts";

/**
 * Denial is discounted while the bot is hurting. Contesting an item you cannot
 * use is a luxury; at 20 HP the bot should be solving its own problem.
 */
const HEALTH_COMFORT = 60;

export const ItemDenial: Consideration = {
  id: "item_denial",
  role: "attractor",
  // Its OWN key, not itemGreed. Sharing one weight across both item attractors
  // scales every candidate equally and so cannot change their ranking — the
  // weight would degenerate into an on/off switch. See WeightProfiles.ts.
  weightKey: "itemDenial",

  score(ctx: ConsiderationContext): number {
    const item = ctx.goal.item;
    if (!item) return 0;
    const base = denialValue(item.type, item.kind);
    if (base <= 0) return 0;

    // Only worth contesting if there is somebody to contest it with.
    const liveEnemies = ctx.state.getScoreboardEnemyCount();
    if (liveEnemies === 0) return 0;

    const comfort = clamp01(ctx.self.health / HEALTH_COMFORT);
    return clamp01(base * comfort);
  },
};
