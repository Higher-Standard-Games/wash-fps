/**
 * objective_push / objective_urgency — the pull of a gametype directive.
 *
 * These are what let a mode outrank item greed without any mode-specific code
 * in the bot: an S&D attacker ignores a Red Armor because `objectivePush 0.9`
 * beats `itemGreed 0.2`, not because anything here knows what a bomb is.
 *
 * Two separate considerations rather than one, because priority and time
 * pressure are genuinely different signals. Planting is always important; it is
 * only *urgent* once the round clock is short. Keeping them apart means a
 * gametype can raise urgency late in a round without permanently inflating how
 * much the objective matters.
 */

import { type Consideration, type ConsiderationContext, clamp01 } from "../Consideration";

/**
 * How much a directive's own `priority` can be lifted by simply having been
 * issued. A directive that exists at all is worth something.
 */
const DIRECTIVE_FLOOR = 0.25;

export const ObjectivePush: Consideration = {
  id: "objective_push",
  role: "attractor",
  weightKey: "objectivePush",

  score(ctx: ConsiderationContext): number {
    const directive = ctx.goal.directive;
    if (!directive) return 0;
    // The gametype's own weighting, floored so a low-priority order is still
    // preferred to doing nothing at all.
    return clamp01(DIRECTIVE_FLOOR + (1 - DIRECTIVE_FLOOR) * clamp01(directive.priority));
  },
};

export const ObjectiveUrgency: Consideration = {
  id: "objective_urgency",
  role: "attractor",
  weightKey: "objectivePush",

  score(ctx: ConsiderationContext): number {
    const directive = ctx.goal.directive;
    if (!directive) return 0;
    return clamp01(directive.urgency ?? 0);
  },
};
