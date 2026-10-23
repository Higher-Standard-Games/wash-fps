/**
 * item_value — how much this bot, right now, actually gains from this item.
 *
 * Deliberately computed from the SHARED grant functions
 * (`shared/items/ItemGrants.ts`) rather than a hand-written value table, so the
 * bot's idea of an item can never drift from what the server will actually
 * give it. Overcap waste therefore falls out for free: a 5 HP bubble at 98
 * health scores on a gain of 2, and at 100 health it scores 0 — which is also
 * exactly when the server refuses the pickup.
 */

import { type ArmorKind, armorAfterPickup, type HealthKind, healthAfterPickup } from "../../../shared/items/ItemGrants";
import { getWeaponProfile } from "../../BotWeaponProfile";
import { type Consideration, type ConsiderationContext, clamp01 } from "../Consideration";
import { ammoConsumers, ammoNeedFraction, isMajorItem, powerupValue } from "./ItemFacts";

/**
 * Health/armor gain is normalized against this many points.
 *
 * Deliberately ABOVE the 100 a Mega grants. Normalizing against 100 would let
 * the largest ordinary pickup saturate at 1.0, and then nothing — including
 * Quad, the one item a map places exactly once — could ever outrank it. Leaving
 * headroom keeps the top of the scale meaningful; the urgency term below is
 * what pushes health back through the ceiling when the bot is actually dying.
 */
const POINTS_FULL_VALUE = 150;

/**
 * Extra pull on health when genuinely hurt, ramping in only below the
 * threshold. Ramping from full health made a 60 HP bot — which is fine —
 * value a Mega as highly as a Quad.
 */
const HEALTH_URGENCY = 1.5;
const HEALTH_URGENCY_THRESHOLD = 50;

/**
 * Armor points are worth slightly more than health points: armor absorbs ~66%
 * of incoming damage (CombatSystem.BASE_ARMOR_ABSORPTION) and stacks on top of
 * health rather than replacing it. Modest, not clever — a big multiplier here
 * makes bots ignore health while dying.
 */
const ARMOR_POINT_WEIGHT = 1.15;

/** A weapon the bot does not own yet, normalized against the best DPS in the game. */
const DPS_FULL_VALUE = 150;

/** The weapon every player spawns with; it does not count towards an arsenal. */
const MELEE_WEAPON = "blade";

/** A new weapon's value by guns already owned (besides the blade): 0, 1, 2, 3 or more. */
const EXTRA_WEAPON_SCALE = [1, 1, 0.5, 0.3];

/** Ammo for a weapon the bot does not own is nearly worthless, but not zero. */
const AMMO_UNOWNED_WEAPON_SCALE = 0.1;

export const ItemValue: Consideration = {
  id: "item_value",
  role: "attractor",
  weightKey: "itemGreed",

  score(ctx: ConsiderationContext): number {
    // Directive-backed goals carry no item, so this consideration simply has
    // nothing to say about them. Returning 0 is how a consideration abstains —
    // the max picks whichever consideration DOES have something to say.
    const item = ctx.goal.item;
    if (!item) return 0;
    const value = itemValue(ctx);
    // The mode's policy on the big items (WeightProfiles: majorItemBias).
    return isMajorItem(item.type, item.kind) ? clamp01(value * ctx.weights.majorItemBias) : value;
  },
};

/** What the item is worth to this bot before the mode's bias. */
function itemValue(ctx: ConsiderationContext): number {
  const item = ctx.goal.item;
  if (!item) return 0;
  const self = ctx.self;

  switch (item.type) {
    case "health": {
      const gain = healthAfterPickup(self.health, item.kind as HealthKind) - self.health;
      if (gain <= 0) return 0;
      const deficit = clamp01((HEALTH_URGENCY_THRESHOLD - self.health) / HEALTH_URGENCY_THRESHOLD);
      const urgency = 1 + HEALTH_URGENCY * deficit;
      return clamp01((gain / POINTS_FULL_VALUE) * urgency);
    }

    case "armor": {
      const gain = armorAfterPickup(self.armor, item.kind as ArmorKind) - self.armor;
      if (gain <= 0) return 0;
      return clamp01((gain / POINTS_FULL_VALUE) * ARMOR_POINT_WEIGHT);
    }

    case "weapon": {
      const profile = getWeaponProfile(item.kind);
      const dpsValue = clamp01(profile.dps / DPS_FULL_VALUE);
      if (!self.weapons.includes(item.kind)) {
        // A weapon you don't have is a capability change, not a top-up, and
        // most of all the first one: a bot with only the blade has no answer
        // at range. Each gun after that adds an option, not a capability,
        // and is worth less than the armor and health that keep it alive.
        const owned = self.weapons.filter((w) => w !== MELEE_WEAPON).length;
        const scale = EXTRA_WEAPON_SCALE[Math.min(owned, EXTRA_WEAPON_SCALE.length - 1)];
        return clamp01((0.5 + 0.5 * dpsValue) * scale);
      }
      // Already owned — worth only the ammo it carries.
      return clamp01(ammoNeedFraction(self, item.kind) * dpsValue);
    }

    case "ammo": {
      const need = ammoNeedFraction(self, item.kind, item.amount);
      if (need <= 0) return 0;
      const ownsConsumer = ammoConsumerOwned(self.weapons, item.kind);
      return clamp01(need * (ownsConsumer ? 1 : AMMO_UNOWNED_WEAPON_SCALE));
    }

    case "powerup":
      // Powerups have no "gain" to compute — you can always take one, and
      // there is at most one on the map. Value is intrinsic.
      return powerupValue(item.kind);

    default:
      return 0;
  }
}

/**
 * True when the bot holds a weapon that consumes this ammo pool.
 * Resolved through the weapon table rather than `WeaponProfile`, which carries
 * combat characteristics only and has no ammo fields.
 */
function ammoConsumerOwned(weapons: readonly string[], ammoKind: string): boolean {
  const consumers = ammoConsumers(ammoKind);
  return weapons.some((weaponId) => consumers.includes(weaponId));
}
