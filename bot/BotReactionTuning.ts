import { selectGametypeHabits } from "../shared/bot/WeightProfiles";
import type { BotGameState } from "./BotGameState";

/** A small, fixed handicap for a lead in a one-on-one mode (GametypeHabits); score differences do not compound it. */
export function duelLeadReactionDelay(state: BotGameState): number {
  const delay = selectGametypeHabits(state.matchState.gametypeName).leadReactionDelayMs;
  if (delay === 0) return 0;
  const own = state.scores.get(state.selfPlayerId);
  if (!own || state.scores.size !== 2) return 0;
  const opponent = [...state.scores.entries()].find(([id]) => id !== state.selfPlayerId)?.[1];
  return opponent && own.score - opponent.score > 2 ? delay : 0;
}
