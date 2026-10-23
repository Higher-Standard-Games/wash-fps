/**
 * DirectiveGoalSource — turns gametype orders into scorable goals.
 *
 * The gametype→bot boundary in one function. Everything arriving here is plain
 * data that crossed a process boundary, so it is treated as untrusted: shapes
 * are checked, expiry is enforced locally, and anything malformed is dropped
 * rather than allowed to produce a goal with a NaN position.
 *
 * Note what is deliberately absent — any knowledge of what a directive MEANS.
 * "Plant the bomb" and "hold this corridor" are both a position and a priority
 * here. That is what keeps S&D out of the bot application.
 */

import type { AgentDirective } from "../../../../shared/server/gametype/index";
import type { BotGameState, Vec3 } from "../BotGameState";
import { type BotGoal, type BotGoalKind, directiveGoalId } from "./BotGoal";

/** Fallback arrival radius when a directive does not specify one. */
const DEFAULT_DIRECTIVE_RADIUS = 160;

const DIRECTIVE_KINDS = new Set(["move_to", "hold_area", "defend", "escort", "hunt"]);

function isFiniteVec3(value: unknown): value is Vec3 {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<Vec3>;
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/**
 * Resolve a directive's target to a world position.
 *
 * `player` targets are resolved against the CURRENT snapshot, so an escort goal
 * tracks the carrier as they move. Returns null when the target cannot be
 * located — an escort for a player who left is not a goal, it is nothing.
 */
function resolveTargetPosition(directive: AgentDirective, state: BotGameState): Vec3 | null {
  const target = directive.target;
  if (!target || typeof target !== "object") return null;

  if (target.type === "position") {
    return isFiniteVec3(target.position) ? target.position : null;
  }
  if (target.type === "player") {
    // The game marks a directive's target for players too, so it is known unseen.
    const player = (state.perceptionManaged ? state.snapshotPlayers : state.players).find(
      (p) => p.entityId === target.entityId,
    );
    if (!player || player.isDead) return null;
    return player.position;
  }
  return null;
}

/**
 * Build goal candidates from the directives addressed to this bot.
 *
 * Expiry is checked here as well as in `BotGameState`, because these two run at
 * different times and a directive that lapses mid-tick must not still produce a
 * goal.
 */
export function collectDirectiveGoals(state: BotGameState): BotGoal[] {
  if (state.directives.length === 0) return [];

  const goals: BotGoal[] = [];
  for (const directive of state.directives) {
    if (!directive || typeof directive.id !== "string" || directive.id.length === 0) continue;
    if (!DIRECTIVE_KINDS.has(directive.kind)) continue;
    if (!Number.isFinite(directive.expiresAtTick) || state.tick >= directive.expiresAtTick) continue;

    const position = resolveTargetPosition(directive, state);
    if (!position) continue;

    const radius =
      directive.target.type === "position" && Number.isFinite(directive.target.radius)
        ? directive.target.radius
        : DEFAULT_DIRECTIVE_RADIUS;

    goals.push({
      id: directiveGoalId(directive.id),
      kind: directive.kind as BotGoalKind,
      position: { ...position },
      directive,
      radius,
    });
  }
  return goals;
}
