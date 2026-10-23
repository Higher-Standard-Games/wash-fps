/**
 * team_cohesion / carrier_protect — the pull of staying with your team.
 *
 * These are the considerations that make "hang back and guard the carrier
 * instead of chasing that guy" expressible at all. They are positioning
 * pressures, not item targets, which is precisely why the old boolean ladder
 * could never represent them (design doc §6.1).
 *
 * Both score a GOAL, not the bot's current position: the question is "would
 * going here put me where my team needs me", so they measure the goal's
 * relationship to allies rather than the bot's.
 */

import { vec3Distance } from "../../BotGameState";
import { type Consideration, type ConsiderationContext, clamp01 } from "../Consideration";

/** Distance at which a teammate stops counting as "supported". */
const SUPPORT_RADIUS = 900;

/**
 * Below this the bot is already with its team, so moving closer adds nothing.
 * Without it a bot would keep crowding a teammate it is standing next to.
 */
const CROWDING_RADIUS = 200;

export const TeamCohesion: Consideration = {
  id: "team_cohesion",
  role: "attractor",
  weightKey: "teamCohesion",

  score(ctx: ConsiderationContext): number {
    const allies = ctx.state.players.filter((p) => p.relation === "ally" && !p.isDead);
    if (allies.length === 0) return 0;

    // Nearest ally to the GOAL, not to the bot: this asks whether going there
    // brings the bot into support range.
    let nearest = Number.POSITIVE_INFINITY;
    for (const ally of allies) {
      nearest = Math.min(nearest, vec3Distance(ctx.goal.position, ally.position));
    }
    if (!Number.isFinite(nearest)) return 0;
    if (nearest <= CROWDING_RADIUS) return 0;
    if (nearest >= SUPPORT_RADIUS) return 0;

    // Peaks just outside crowding range and falls off toward the support edge.
    return clamp01(1 - (nearest - CROWDING_RADIUS) / (SUPPORT_RADIUS - CROWDING_RADIUS));
  },
};

export const CarrierProtect: Consideration = {
  id: "carrier_protect",
  role: "attractor",
  weightKey: "carrierProtect",

  score(ctx: ConsiderationContext): number {
    // Only an `escort` directive identifies a carrier. Without one there is
    // nobody to protect, and guessing would be worse than abstaining.
    const directive = ctx.goal.directive;
    if (directive?.kind !== "escort") return 0;
    const target = directive.target;
    if (target.type !== "player") return 0;

    const carrier = ctx.state.players.find((p) => p.entityId === target.entityId);
    if (!carrier || carrier.isDead) return 0;

    // Strongest when the carrier is exposed: far from this bot and with enemies
    // about. A carrier already at your shoulder needs no further attention.
    const separation = vec3Distance(ctx.self.position, carrier.position);
    const proximityNeed = clamp01(separation / SUPPORT_RADIUS);
    const liveEnemies = ctx.state.getKnownEnemyCount();
    const threat = liveEnemies > 0 ? 1 : 0.3;

    return clamp01(proximityNeed * threat);
  },
};
