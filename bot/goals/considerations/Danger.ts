/**
 * danger — a DISCOUNT for how exposed the bot currently is.
 *
 * A suppressor rather than a peer goal. Were "avoid danger" an attractor it
 * would compete with "push the objective" as an equal, and the gametype could
 * never express "advance to the bomb spot regardless" — which is precisely what
 * `riskTolerance` is for (design doc §4.1).
 *
 * Phase 1 uses cheap signals only: how many enemies are known live, and whether
 * the bot has been hit recently. Real exposure (am I standing in the open, is
 * this route overlooked) needs vision traces, which are budgeted per tick and
 * belong with map-control work in a later phase.
 */

import { type Consideration, type ConsiderationContext, clamp01 } from "../Consideration";

/** Ticks over which a hit still counts as "recently damaged" (125 Hz → ~2s). */
const DAMAGE_MEMORY_TICKS = 250;

/** Enemy count at which the crowd term saturates. */
const CROWD_SATURATION = 3;

/** Relative contribution of the two signals. */
const WEIGHT_DAMAGE = 0.6;
const WEIGHT_CROWD = 0.4;

export const Danger: Consideration = {
  id: "danger",
  role: "discount",
  // A modifier scaled by riskTolerance in the arbiter, not a policy weight.
  weightKey: null,

  score(ctx: ConsiderationContext): number {
    const state = ctx.state;

    // Recent damage heat — decays linearly over the memory window.
    let heat = 0;
    for (const hit of state.recentDamage) {
      const age = state.tick - hit.tick;
      if (age < 0 || age > DAMAGE_MEMORY_TICKS) continue;
      heat = Math.max(heat, 1 - age / DAMAGE_MEMORY_TICKS);
    }

    const liveEnemies = state.getKnownEnemyCount();
    const crowd = clamp01(liveEnemies / CROWD_SATURATION);

    const danger = clamp01(WEIGHT_DAMAGE * heat + WEIGHT_CROWD * crowd);

    // Returned as a DISCOUNT (1 = perfectly safe), with riskTolerance deciding
    // how much of the danger is actually felt. riskTolerance 1 ignores it.
    const felt = danger * (1 - clamp01(ctx.weights.riskTolerance));
    return clamp01(1 - felt);
  },
};
