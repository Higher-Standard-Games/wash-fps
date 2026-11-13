/**
 * One record per bot decision: what the bot was doing and why, for tools that
 * need to explain a behaviour from outside (`bot:motion --trace`, `bot:ab`).
 * Built only when `BotOptions.trace` is on; a bot that is not traced pays
 * nothing.
 */

import type { Vec3 } from "./BotGameState";

/** A candidate goal as the arbiter scored it. */
export interface TracedCandidate {
  id: string;
  desire: number;
  /** Strongest attractor, when it passed the gates. */
  via?: string;
  /** Why it was ruled out, when it was. */
  gate?: string;
}

export interface DecisionTrace {
  tick: number;
  /** BotState. */
  state: string;
  strategy: string | null;
  /** The diagnosis the strategy answers, or null. */
  reason: string | null;
  /** Ids of the gametype orders held. */
  orders: string[];
  /** The goal the arbiter chose this decision, or null when it did not choose. */
  goal: string | null;
  /** The best candidates that passed the gates, best first (at most TRACED_CANDIDATES). */
  candidates: TracedCandidate[];
  /** Candidates ruled out by a gate. */
  gated: number;
  /** The path step being followed. */
  step: { type: string; to: Vec3; route?: string } | null;
  /** Active movement sequence and its phase. */
  sequence: string | null;
  /** Why navigation is blocked, if it is. */
  blocked: string | null;
  position: Vec3;
  speed: number;
  grounded: boolean;
  crouching: boolean;
  health: number;
  armor: number;
  weapon: string;
}

/** Candidates kept per record. */
export const TRACED_CANDIDATES = 3;
