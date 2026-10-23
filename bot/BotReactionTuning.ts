import type { BotGameState } from "./BotGameState";

/** A small, fixed Duel handicap; score differences do not compound it. */
export function duelLeadReactionDelay(state: BotGameState): number {
  if (state.matchState.gametypeName.toLowerCase() !== "duel") return 0;
  const own = state.scores.get(state.selfPlayerId);
  if (!own || state.scores.size !== 2) return 0;
  const opponent = [...state.scores.entries()].find(([id]) => id !== state.selfPlayerId)?.[1];
  return opponent && own.score - opponent.score > 2 ? 40 : 0;
}
