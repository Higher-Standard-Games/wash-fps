/**
 * GoalArbiter — scores candidate goals and picks one.
 *
 * The combination rule (docs/research/BOT_WEIGHTS_AND_GOALS.md §6.3) is:
 *
 *     desire = gate × attraction × discount
 *     attraction = max(wᵢ·cᵢ) + β · mean(other attractors)
 *     discount   = Π(discount considerations)
 *
 * Why not a weighted SUM over everything, which is the usual first instinct:
 * a goal scoring 0.4 on five considerations totals 2.0 and beats a goal scoring
 * 0.95 on the one consideration that actually matters. Mediocre-at-everything
 * wins, and the resulting decisions cannot be explained to anyone. Taking the
 * max means the best REASON drives the choice, while β lets secondary reasons
 * break ties without ever dominating.
 *
 * Gates are hard 0/1 rather than small scores, because "there is no route to
 * this" and "this is slightly unattractive" must not be the same thing.
 *
 * Every decision produces a human-readable explanation. That is not a debugging
 * nicety — a weight surface this size becomes unexplainable within a week
 * without it (§6.5), and the traces are also the training signal a later ML
 * phase needs (§10.2).
 */

import type { BotGoal } from "./BotGoal";
import type { Consideration, ConsiderationContext } from "./Consideration";

/** Weight of the secondary attractors relative to the winning one. */
export const SECONDARY_WEIGHT = 0.15;

/** Score bonus for the goal already being pursued, inside its commitment window. */
export const HYSTERESIS_BONUS = 0.1;

/** Commitment window in server ticks (125 Hz → 1.5 s). Must exceed a typical
 *  sequence duration or bots abandon goals mid-traversal (§7.3). */
export const COMMITMENT_TICKS = 188;

/** A candidate that failed a gate, with the reason, for diagnostics. */
export interface GateFailure {
  goalId: string;
  reason: string;
}

/**
 * `BotDifficulty.mistakeRate` at which a bot takes the runner-up on essentially
 * every goal switch. The presets run 0.2 (expert) to 8 (easy), so this scale
 * yields roughly 1% / 6% / 19% / 50% across expert → easy.
 */
const MISTAKE_RATE_FULL = 16;

/**
 * Convert the declared difficulty knob into a per-switch probability.
 *
 * `mistakeRate` has existed on every difficulty preset since bots were added
 * and was never read by anything — "random dumb decisions per minute" with no
 * implementation. Goal selection is the natural home for it: choosing the
 * second-best item is a mistake a human plausibly makes, unlike the random
 * button noise the field's original description implies.
 */
export function mistakeProbability(mistakeRate: number): number {
  if (!Number.isFinite(mistakeRate) || mistakeRate <= 0) return 0;
  return Math.min(1, mistakeRate / MISTAKE_RATE_FULL);
}

/** Per-candidate score record. Retained for diagnostics and future training. */
export interface GoalScoreTrace {
  goalId: string;
  gate: 0 | 1;
  gateReason?: string;
  /** Raw consideration outputs, keyed by consideration id. */
  features: Record<string, number>;
  /** Post-weight attractor contributions, keyed by consideration id. */
  weighted: Record<string, number>;
  attraction: number;
  discount: number;
  desire: number;
  /** Consideration id that won the max. */
  via?: string;
}

export interface ArbitrationResult {
  goal: BotGoal | null;
  desire: number;
  /** One-line summary suitable for bot diagnostics output. */
  explain: string;
  traces: GoalScoreTrace[];
}

/** A gate is a hard precondition. Returning a string rejects the candidate. */
export type GoalGate = (goal: BotGoal, ctx: ConsiderationContext) => string | null;

export interface GoalArbiterOptions {
  /**
   * Probability of taking the runner-up instead of the winner, rolled ONLY when
   * switching to a new goal — never per tick, which would make a bot oscillate
   * rather than look fallible. See `mistakeProbability()`.
   */
  mistakeChance?: number;
  /** Injectable RNG so golden-scenario fixtures stay deterministic. */
  random?: () => number;
}

export class GoalArbiter {
  private readonly considerations: readonly Consideration[];
  private readonly mistakeChance: number;
  private readonly random: () => number;

  /** Currently committed goal id, and the tick its commitment window ends. */
  private currentGoalId: string | null = null;
  private commitmentUntilTick = 0;

  constructor(considerations: readonly Consideration[], options: GoalArbiterOptions = {}) {
    this.considerations = considerations;
    this.mistakeChance = options.mistakeChance ?? 0;
    this.random = options.random ?? Math.random;
  }

  /** The goal the bot is committed to, if any. */
  get committedGoalId(): string | null {
    return this.currentGoalId;
  }

  /** Drop the commitment — on death, goal completion, or goal failure. */
  reset(): void {
    this.currentGoalId = null;
    this.commitmentUntilTick = 0;
  }

  /**
   * Score every candidate and pick the best.
   *
   * `makeContext` is supplied by the caller so the arbiter never has to know how
   * a route cost is obtained — that is what keeps the Phase 3 estimator swap
   * from reaching in here.
   */
  select(
    candidates: readonly BotGoal[],
    makeContext: (goal: BotGoal) => ConsiderationContext,
    tick: number,
    gates: readonly GoalGate[] = [],
  ): ArbitrationResult {
    const traces: GoalScoreTrace[] = [];
    let best: BotGoal | null = null;
    let bestTrace: GoalScoreTrace | null = null;
    let bestDesire = 0;

    for (const goal of candidates) {
      const ctx = makeContext(goal);
      const trace = this.scoreGoal(goal, ctx, tick, gates);
      traces.push(trace);

      if (trace.gate === 0) continue;
      if (trace.desire > bestDesire) {
        bestDesire = trace.desire;
        best = goal;
        bestTrace = trace;
      }
    }

    // Human fallibility: sometimes take the second-best option. Rolled only on
    // a genuine switch, so the bot commits to its mistake and looks like it
    // misjudged rather than like it is malfunctioning.
    let mistaken = false;
    if (best && best.id !== this.currentGoalId && this.mistakeChance > 0 && this.random() < this.mistakeChance) {
      const runnerUp = traces
        .filter((t) => t.gate === 1 && t.goalId !== best?.id)
        .sort((a, b) => b.desire - a.desire)[0];
      const alternative = runnerUp ? candidates.find((c) => c.id === runnerUp.goalId) : undefined;
      if (alternative && runnerUp) {
        best = alternative;
        bestTrace = runnerUp;
        bestDesire = runnerUp.desire;
        mistaken = true;
      }
    }

    // Commit. A newly chosen goal starts a fresh window; re-picking the same
    // goal does NOT extend it, otherwise a bot could stay committed forever.
    if (best && best.id !== this.currentGoalId) {
      this.currentGoalId = best.id;
      this.commitmentUntilTick = tick + COMMITMENT_TICKS;
    } else if (!best) {
      this.reset();
    }

    const explain = this.explain(best, bestTrace, traces);
    return {
      goal: best,
      desire: bestDesire,
      explain: mistaken ? `${explain} [mistake: took runner-up]` : explain,
      traces,
    };
  }

  private scoreGoal(
    goal: BotGoal,
    ctx: ConsiderationContext,
    tick: number,
    gates: readonly GoalGate[],
  ): GoalScoreTrace {
    const features: Record<string, number> = {};
    const weighted: Record<string, number> = {};

    for (const gate of gates) {
      const reason = gate(goal, ctx);
      if (reason) {
        return {
          goalId: goal.id,
          gate: 0,
          gateReason: reason,
          features,
          weighted,
          attraction: 0,
          discount: 0,
          desire: 0,
        };
      }
    }

    let topScore = 0;
    let topId: string | undefined;
    let secondarySum = 0;
    let secondaryCount = 0;
    let discount = 1;

    for (const consideration of this.considerations) {
      const raw = consideration.score(ctx);
      features[consideration.id] = raw;

      if (consideration.role === "discount") {
        discount *= raw;
        continue;
      }

      const weight = consideration.weightKey === null ? 1 : ctx.weights[consideration.weightKey];
      const value = raw * weight;
      weighted[consideration.id] = value;

      if (value > topScore) {
        // Previous leader demotes to a secondary contribution.
        if (topId !== undefined) {
          secondarySum += topScore;
          secondaryCount++;
        }
        topScore = value;
        topId = consideration.id;
      } else {
        secondarySum += value;
        secondaryCount++;
      }
    }

    const secondaryMean = secondaryCount > 0 ? secondarySum / secondaryCount : 0;
    const attraction = topScore + SECONDARY_WEIGHT * secondaryMean;

    let desire = attraction * discount;
    if (goal.id === this.currentGoalId && tick < this.commitmentUntilTick) {
      desire += HYSTERESIS_BONUS;
    }

    return { goalId: goal.id, gate: 1, features, weighted, attraction, discount, desire, via: topId };
  }

  /** One-line decision summary — the §6.5 requirement. */
  private explain(goal: BotGoal | null, trace: GoalScoreTrace | null, all: readonly GoalScoreTrace[]): string {
    if (!goal || !trace) {
      const gated = all.filter((t) => t.gate === 0).length;
      return `goal=none candidates=${all.length} gated=${gated}`;
    }

    const via = trace.via ?? "?";
    const viaRaw = trace.features[via] ?? 0;
    const parts = [
      `goal=${goal.id}(${goal.item ? `${goal.item.type}:${goal.item.kind}` : goal.kind})`,
      `desire=${trace.desire.toFixed(2)}`,
      `via=${via}(${viaRaw.toFixed(2)})`,
      `route=${(trace.features.route_cost ?? 1).toFixed(2)}`,
      `danger=${(trace.features.danger ?? 1).toFixed(2)}`,
    ];

    const runnerUp = all.filter((t) => t.gate === 1 && t.goalId !== goal.id).sort((a, b) => b.desire - a.desire)[0];
    if (runnerUp) parts.push(`next=${runnerUp.goalId}(${runnerUp.desire.toFixed(2)})`);

    const gated = all.filter((t) => t.gate === 0);
    if (gated.length > 0) parts.push(`gated=${gated.length}[${gated[0].gateReason}…]`);

    return parts.join(" ");
  }
}
