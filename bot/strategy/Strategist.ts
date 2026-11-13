/**
 * Strategist — what the bot needs to do to win, from its read of the match.
 *
 * Three steps, every STRATEGY_INTERVAL_TICKS:
 *
 * 1. Diagnose (`diagnose`): name what is going wrong or right, each with a
 *    strength from 0 to 1 and the evidence, from the MatchRead alone.
 * 2. Choose a strategy for the strongest diagnosis the bot's match sense
 *    allows, and hold it at least STRATEGY_HOLD_TICKS so it shows intent.
 * 3. The strategy is data the rules read: multipliers on the gametype's weight
 *    profile (what items are worth, how much danger is felt) and a stance
 *    (when to retreat, how readily to shop, whether to chase).
 *
 * The rules still play. A strategy changes what the goal arbiter scores and
 * where the state machine draws its lines, never a command.
 *
 * `matchSense` (BotDifficulty) sets how much of this a bot does: under 0.3
 * none, under 0.6 only Recover and Protect lead, above that all of it, and
 * then it also adapts: each diagnosis has a few strategies that can answer
 * it, and a bandit keeps, per diagnosis, how each has paid off against this
 * opponent in this match (the score gap, the major items and the stack over
 * the next stretch of play). It plays what has worked, and now and then tries
 * another (Thompson sampling). The rule's answer starts ahead.
 */

import type { BotWeightProfile } from "../../shared/bot/WeightProfiles";
import type { BotGameState } from "../BotGameState";
import type { MatchRead } from "./MatchRead";

const TICK_RATE = 125;
/** How often the strategy is chosen again. */
const STRATEGY_INTERVAL_TICKS = TICK_RATE;
/** A strategy is held at least this long unless a stronger reason appears. */
const STRATEGY_HOLD_TICKS = 6 * TICK_RATE;
/** A new diagnosis this much stronger than the held one's breaks the hold. */
const OVERRIDE_MARGIN = 0.35;
/** "Late" in a match. */
const LATE_SECONDS = 90;
/** A score gap that matters late. */
const LATE_GAP = 2;
/** Being hurt by two or more enemies within this long is being focused. */
const FOCUS_SECONDS = 20;
/**
 * Control sends the bot to the items the opponent wants, where the opponent is
 * going. It is played only with a stack at most this far under the estimate of
 * theirs; further under, the bot recovers first.
 */
const CONTROL_STACK_MARGIN = 25;

export type DiagnosisId = "understacked" | "losing_items" | "enemy_weak" | "ahead_late" | "behind_late" | "focused";
export type StrategyId = "standard" | "recover" | "control" | "pressure" | "protect_lead";

export interface Diagnosis {
  id: DiagnosisId;
  strength: number;
  evidence: string;
}

export interface Stance {
  /** Multiplies the health a bot retreats at. */
  retreatScale: number;
  /** Multiplies the desire an item needs to be worth shopping for. */
  seekScale: number;
  /** Shop for items worth it even with 25 armor or more. */
  shopArmored: boolean;
  /** Keep after an enemy it lost sight of. */
  chase: boolean;
  /** Leave a fight that is costing it, by a way out of the enemy's sight. */
  fade: boolean;
}

export interface Strategy {
  id: StrategyId;
  /** Multipliers on the weight profile; a missing key is 1. */
  weights: Partial<Record<keyof BotWeightProfile, number>>;
  stance: Stance;
}

const STANDARD_STANCE: Stance = { retreatScale: 1, seekScale: 1, shopArmored: false, chase: true, fade: false };

export const STRATEGIES: Record<StrategyId, Strategy> = {
  standard: { id: "standard", weights: {}, stance: STANDARD_STANCE },
  // Understacked: stop taking even fights, collect, come back stacked.
  recover: {
    id: "recover",
    weights: { riskTolerance: 0.5, itemGreed: 1.3, aggression: 0.5 },
    stance: { retreatScale: 1.6, seekScale: 0.6, shopArmored: true, chase: false, fade: true },
  },
  // Losing the major items: time them, take them, deny them.
  control: {
    id: "control",
    weights: { itemTiming: 1.5, majorItemBias: 1.3, itemDenial: 1.5 },
    stance: { retreatScale: 1, seekScale: 0.7, shopArmored: true, chase: true, fade: false },
  },
  // Behind late, or the enemy is weak: go and get them.
  pressure: {
    id: "pressure",
    weights: { aggression: 1.5, riskTolerance: 1.6 },
    stance: { retreatScale: 0.6, seekScale: 1.6, shopArmored: false, chase: true, fade: false },
  },
  // Ahead late: stay stacked, take no risks.
  protect_lead: {
    id: "protect_lead",
    weights: { riskTolerance: 0.5, aggression: 0.6, majorItemBias: 1.2 },
    stance: { retreatScale: 1.4, seekScale: 0.8, shopArmored: true, chase: false, fade: true },
  },
};

/** Which strategy answers each diagnosis, and how much match sense it takes. */
const ANSWER: Record<DiagnosisId, { strategy: StrategyId; sense: number }> = {
  ahead_late: { strategy: "protect_lead", sense: 0.3 },
  behind_late: { strategy: "pressure", sense: 0.6 },
  understacked: { strategy: "recover", sense: 0.3 },
  enemy_weak: { strategy: "pressure", sense: 0.6 },
  losing_items: { strategy: "control", sense: 0.6 },
  focused: { strategy: "recover", sense: 0.6 },
};

/** The strategies that can answer each diagnosis, the rule's answer first. */
const CHOICES: Record<DiagnosisId, readonly StrategyId[]> = {
  ahead_late: ["protect_lead", "control"],
  behind_late: ["pressure", "control"],
  understacked: ["recover", "control"],
  enemy_weak: ["pressure", "standard"],
  losing_items: ["control", "pressure"],
  focused: ["recover", "control"],
};
/** Match sense from which the bot adapts its answers. */
const ADAPT_SENSE = 0.6;
/** An episode of one strategy is judged after this long at most. */
const EPISODE_TICKS = 30 * TICK_RATE;
/** The rule's answer starts this far ahead, in reward units. */
const RULE_PRIOR = 0.3;
/** Spread of a strategy's payoff before anything is known. */
const PRIOR_SD = 1;
/** Reward: per frag of score gap, per major item of the item balance, per 100 of average stack. */
const REWARD_PER_FRAG = 1;
const REWARD_PER_ITEM = 0.3;
const REWARD_PER_STACK = 0.2;

interface Arm {
  n: number;
  mean: number;
}

/** An episode as judged: for the match report and the baseline. */
export interface JudgedEpisode {
  diagnosis: DiagnosisId;
  strategy: StrategyId;
  reward: number;
  seconds: number;
}

/** Baseline episodes an arm needs before its learned payoff replaces the rule's head start. */
const PRIOR_MIN_EPISODES = 10;

interface Episode {
  diagnosis: DiagnosisId;
  strategy: StrategyId;
  startTick: number;
  gap: number;
}

/** What is going wrong or right, strongest first. */
export function diagnose(read: MatchRead, state: BotGameState): Diagnosis[] {
  const out: Diagnosis[] = [];
  const clamp = (v: number) => Math.max(0, Math.min(1, v));

  const score = read.score();
  const gap = score.own - score.bestOther;
  const late = score.timeRemaining !== undefined && score.timeRemaining < LATE_SECONDS;
  if (late && gap >= LATE_GAP)
    out.push({
      id: "ahead_late",
      strength: clamp(0.6 + gap / 10),
      evidence: `${gap} ahead, ${score.timeRemaining}s left`,
    });
  if (late && gap <= -LATE_GAP)
    out.push({
      id: "behind_late",
      strength: clamp(0.6 - gap / 10),
      evidence: `${-gap} behind, ${score.timeRemaining}s left`,
    });

  // Stacks: fights started under the enemy's stack, and the stack now against the freshest estimate.
  const own = state.self.health + state.self.armor;
  const recentFights = read.fights(90);
  const deficits = recentFights.map((f) => f.enemyStackAtStart - f.ownStackAtStart);
  const fightDeficit = deficits.length > 0 ? deficits.reduce((s, d) => s + d, 0) / deficits.length : 0;
  const freshest = read.enemies().find((e) => e.alive);
  const estimate = freshest ? read.enemyStack(freshest.entityId) : null;
  const nowDeficit = estimate && estimate.uncertainty < 0.5 ? estimate.stack - own : 0;
  const deficit = Math.max(fightDeficit, nowDeficit);
  if (deficit > 40 && own < 150)
    out.push({
      id: "understacked",
      strength: clamp(deficit / 120),
      evidence: `stack ${own} against about ${Math.round(own + deficit)}`,
    });

  if (estimate && estimate.uncertainty < 0.3 && estimate.stack < 70 && own >= 100)
    out.push({
      id: "enemy_weak",
      strength: clamp((100 - estimate.stack) / 80),
      evidence: `enemy about ${Math.round(estimate.stack)}, own ${own}`,
    });

  // Several enemies on this bot at once (Deathmatch): get out of the crowd.
  const attackers = read.attackers(FOCUS_SECONDS);
  if (attackers >= 2)
    out.push({
      id: "focused",
      strength: clamp(0.4 + 0.2 * attackers),
      evidence: `${attackers} enemies hurt it lately`,
    });

  const takes = read.majorTakes(90);
  if (takes.others >= 2 && takes.others > takes.own)
    out.push({
      id: "losing_items",
      strength: clamp(takes.others / (takes.own + takes.others)),
      evidence: `major items ${takes.own}–${takes.others}`,
    });

  return out.sort((a, b) => b.strength - a.strength);
}

export class Strategist {
  private _current: Strategy = STRATEGIES.standard;
  private _because: Diagnosis | null = null;
  private _since = Number.NEGATIVE_INFINITY;
  private _nextTick = Number.NEGATIVE_INFINITY;
  private readonly _arms = new Map<string, Arm>();
  private _episode: Episode | null = null;
  private readonly _judged: JudgedEpisode[] = [];
  /** Prior payoff per "diagnosis:strategy", from the map's baseline (BS-18). */
  private _priors: ReadonlyMap<string, { n: number; mean: number }> = new Map();
  /** The strategies it may play; null is all. */
  private _allowed: ReadonlySet<StrategyId> | null = null;

  /**
   * @param sense the bot's matchSense, 0..1.
   * @param random injectable, for tests of the bandit.
   */
  constructor(
    private readonly _sense: number,
    private readonly _random: () => number = Math.random,
  ) {}

  /** Every episode judged this match, oldest first: for the match report. */
  get judged(): readonly JudgedEpisode[] {
    return this._judged;
  }

  /**
   * Payoffs learned from earlier matches on this map (config/bot-intel), by
   * "diagnosis:strategy". They replace the rule's head start for an arm with
   * enough of them.
   */
  setPriors(priors: ReadonlyMap<string, { n: number; mean: number }>): void {
    this._priors = priors;
  }

  /**
   * Play only these strategies; a diagnosis none of them answers gets Standard.
   * For measuring one strategy at a time (`bot:ab`, BotOptions.strategies).
   */
  limitTo(strategies: readonly StrategyId[] | null): void {
    this._allowed = strategies ? new Set(strategies) : null;
  }

  /** What the bandit has learned: per diagnosis and strategy, episodes and mean payoff. */
  get arms(): ReadonlyMap<string, Arm> {
    return this._arms;
  }

  get strategy(): Strategy {
    return this._current;
  }

  /** One line for diagnostics: the strategy and why. */
  explain(): string {
    return this._because ? `${this._current.id} (${this._because.id}: ${this._because.evidence})` : this._current.id;
  }

  reset(): void {
    this._current = STRATEGIES.standard;
    this._because = null;
    this._since = Number.NEGATIVE_INFINITY;
    this._nextTick = Number.NEGATIVE_INFINITY;
    this._arms.clear();
    this._episode = null;
    this._judged.length = 0;
  }

  /** Choose again when due; returns the strategy in force. */
  update(read: MatchRead, state: BotGameState): Strategy {
    const tick = state.tick;
    if (tick < this._nextTick) return this._current;
    this._nextTick = tick + STRATEGY_INTERVAL_TICKS;
    if (this._sense < 0.3) return this._current;

    const top = diagnose(read, state).find((d) => this._sense >= ANSWER[d.id].sense) ?? null;
    const episodeOver = this._episode !== null && tick - this._episode.startTick >= EPISODE_TICKS;
    if (episodeOver) this._judge(read, tick);
    // Control held without the stack for it is left at once, hold or not.
    const outstacked = this._current.id === "control" && this._fit("control", read, state) !== "control";
    const sameReason = top !== null && this._because !== null && top.id === this._because.id;
    if (sameReason && !episodeOver && !outstacked) {
      this._because = top;
      return this._current;
    }
    const next = top ? STRATEGIES[this._fit(this._choose(top.id), read, state)] : STRATEGIES.standard;
    if (next.id === this._current.id) {
      this._because = top;
      if (top && !this._episode) this._open(top.id, next.id, read, tick);
      return this._current;
    }
    const held = tick - this._since < STRATEGY_HOLD_TICKS;
    const stronger = top && (!this._because || top.strength >= this._because.strength + OVERRIDE_MARGIN);
    if (held && !stronger && !outstacked) return this._current;
    if (this._episode) this._judge(read, tick);
    this._current = next;
    this._because = top;
    this._since = tick;
    if (top) this._open(top.id, next.id, read, tick);
    return this._current;
  }

  /** The strategy for a diagnosis: the rule's answer, or what the bandit draws. */
  private _choose(diagnosis: DiagnosisId): StrategyId {
    const allowed = (s: StrategyId) => !this._allowed || this._allowed.has(s);
    const choices = CHOICES[diagnosis].filter(allowed);
    if (choices.length === 0) return "standard";
    const rule = allowed(ANSWER[diagnosis].strategy) ? ANSWER[diagnosis].strategy : choices[0];
    if (this._sense < ADAPT_SENSE) return rule;
    let best = rule;
    let bestDraw = Number.NEGATIVE_INFINITY;
    for (const strategy of choices) {
      const arm = this._arms.get(`${diagnosis}:${strategy}`) ?? { n: 0, mean: 0 };
      const learned = this._priors.get(`${diagnosis}:${strategy}`);
      const prior = learned && learned.n >= PRIOR_MIN_EPISODES ? learned.mean : strategy === rule ? RULE_PRIOR : 0;
      // Posterior of a normal mean under a unit prior: shrinks toward the prior, narrows with episodes.
      const mean = (prior + arm.mean * arm.n) / (1 + arm.n);
      const draw = mean + (PRIOR_SD / Math.sqrt(1 + arm.n)) * gaussian(this._random);
      if (draw > bestDraw) {
        bestDraw = draw;
        best = strategy;
      }
    }
    return best;
  }

  /**
   * Control is a fight at the item: taken only stacked enough to win it, as the
   * read estimates the opponent (CONTROL_STACK_MARGIN). Otherwise Recover.
   */
  private _fit(strategy: StrategyId, read: MatchRead, state: BotGameState): StrategyId {
    if (strategy !== "control") return strategy;
    const freshest = read.enemies().find((e) => e.alive);
    const estimate = freshest ? read.enemyStack(freshest.entityId) : null;
    const own = state.self.health + state.self.armor;
    const stacked = estimate !== null && own >= estimate.stack - CONTROL_STACK_MARGIN;
    if (stacked) return "control";
    return !this._allowed || this._allowed.has("recover") ? "recover" : "standard";
  }

  private _open(diagnosis: DiagnosisId, strategy: StrategyId, read: MatchRead, tick: number): void {
    const score = read.score();
    this._episode = { diagnosis, strategy, startTick: tick, gap: score.own - score.bestOther };
  }

  /** Score the episode under way and fold it into its arm. */
  private _judge(read: MatchRead, tick: number): void {
    const episode = this._episode;
    this._episode = null;
    if (!episode) return;
    const seconds = Math.max(1, (tick - episode.startTick) / TICK_RATE);
    const score = read.score();
    const takes = read.majorTakes(seconds);
    const stack = read.averageOwnStack(seconds);
    const reward =
      REWARD_PER_FRAG * (score.own - score.bestOther - episode.gap) +
      REWARD_PER_ITEM * (takes.own - takes.others) +
      REWARD_PER_STACK * (Number.isNaN(stack) ? 0 : (stack - 100) / 100);
    this._judged.push({ diagnosis: episode.diagnosis, strategy: episode.strategy, reward, seconds });
    const key = `${episode.diagnosis}:${episode.strategy}`;
    const arm = this._arms.get(key) ?? { n: 0, mean: 0 };
    arm.n++;
    arm.mean += (reward - arm.mean) / arm.n;
    this._arms.set(key, arm);
  }
}

/** A standard normal draw (Box-Muller). */
function gaussian(random: () => number): number {
  const u = Math.max(1e-12, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** The weight profile with a strategy's multipliers applied; shares cap at 1. */
export function applyStrategyWeights(base: BotWeightProfile, strategy: Strategy): BotWeightProfile {
  const out = { ...base };
  for (const [key, scale] of Object.entries(strategy.weights) as [keyof BotWeightProfile, number][]) {
    const value = base[key] * scale;
    out[key] = key === "riskTolerance" || key === "itemTiming" ? Math.min(1, value) : value;
  }
  return out;
}
