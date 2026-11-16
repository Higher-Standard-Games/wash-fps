/**
 * StateMachineBrain - Phase 1 rule-based AI
 *
 * Priority-based state machine for bot decision making:
 *   1. DEAD?       → Wait, then request respawn
 *   2. Being shot? → FIGHT (engage attacker) or DODGE
 *   3. Enemy LOS   → FIGHT (aim + shoot)
 *   4. Low health  → RETREAT (find health pickups)
 *   5. Need items  → ITEM_RUN (navigate to pickups)
 *   6. Default     → HUNT (patrol/seek enemies)
 *
 * Uses difficulty settings to control aim accuracy, reaction time,
 * prediction skill, and other human-feel parameters.
 */

import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "../../../shared/server/simulation/physics/constants";
import { isBotName } from "../shared/bot/BotNames";
import { type BotWeightProfile, selectGametypeHabits, selectWeightProfile } from "../shared/bot/WeightProfiles";
import type { PickupEntry } from "../shared/bsp/PickupTable";
import { BotBlockedMove } from "./BotBlockedMove";
import { BotBrain, type BotInput, BotState, type BrainMatchReport, travelYaw } from "./BotBrain";
import {
  type BotDifficulty,
  defaultGoalArbiterMode,
  type GoalArbiterMode,
  HIT_ATTENTION_MS,
  InputButtons,
} from "./BotConfig";
import type { BotGameState, Vec3 } from "./BotGameState";
import { vec3Distance, vec3Length, vec3Subtract } from "./BotGameState";
import { BotLife } from "./BotLife";
import { BotMood, type Mood, type MoodEvent } from "./BotMood";
import type { BotNavGraph } from "./BotNavGraph";
import { duelLeadReactionDelay } from "./BotReactionTuning";
import { BotTerritory } from "./BotTerritory";
import type { BotVision, VisionResult } from "./BotVision";
import { getWeaponProfile } from "./BotWeaponProfile";
import { type DecisionTrace, TRACED_CANDIDATES } from "./DecisionTrace";
import type { BotGoal, ItemGoalChoice } from "./goals/BotGoal";
import { isMajorItem } from "./goals/considerations/ItemFacts";
import { ItemGoalPlanner } from "./goals/ItemGoalPlanner";
import { respawnTickOf } from "./goals/ItemGoalSource";
import { InputClaims } from "./InputClaims";
import { loadBaseline, payoffPriors } from "./intel/IntelBaseline";
import { loadPeopleProfile, typicalStackAfter } from "./intel/PeopleProfile";
import { inHarmfulLiquid, liquidEscapeTarget } from "./LiquidEscape";
import { BotSteering, type SteeringHost } from "./movement/BotSteering";
import { BotNavigator, type NavigatorHost, PATH_RECALC_INTERVAL } from "./navigation/BotNavigator";
import { BotTraversal, PICKUP_FAILURE_COOLDOWN_TICKS, type TraversalHost } from "./navigation/BotTraversal";
import { BotOrders, type OrdersHost } from "./orders/BotOrders";
import { BotFight, type FightHost } from "./states/BotFight";
import { BotRoam, PICKUP_SEEK_RANGE, type RoamHost } from "./states/BotRoam";
import { MatchRead } from "./strategy/MatchRead";
import { OpponentModel } from "./strategy/OpponentModel";
import { applyStrategyWeights, STRATEGIES, Strategist, type Strategy, type StrategyId } from "./strategy/Strategist";
import { BotLook, type LookHost } from "./view/BotLook";

/** A weight profile with test multipliers applied (BotOptions.weights). */
function scaleProfile(base: BotWeightProfile, scale: Partial<BotWeightProfile>): BotWeightProfile {
  const out = { ...base };
  for (const [key, factor] of Object.entries(scale) as [keyof BotWeightProfile, number][])
    out[key] = base[key] * factor;
  return out;
}

// ── Constants ───────────────────────────────────────────────────────────

const LOW_HEALTH_THRESHOLD = 40;
const RETREAT_HEALTH_THRESHOLD = 25;
const FIGHT_RANGE = 2000;
/** A teammate's call of enemies is worth hunting this long, ticks. */
const TEAM_SIGHTING_TICKS = 6 * TICK_RATE;
const DODGE_REACT_TICKS = 30; // React to damage within last 30 ticks
/** Blocked in a fight, the bot runs the open way this long before the fight steers again. */
const UNSTICK_TICKS = Math.round(0.5 * 125);
/** How often a bot in slime or lava chooses its way out again (a quarter second). */
const LIQUID_ESCAPE_REPLAN_TICKS = Math.round(0.25 * 125);
/** How far ahead a way out must be walkable, units. */
const UNSTICK_PROBE = 96;
/** Slower than this across the floor, a bot asking to move is not getting anywhere. */
const BLOCKED_SPEED = 60;
/** An enemy this close is what the bot is pressing against, not a wall. */
const ENEMY_BODY_RANGE = 72;
const MOVE_KEYS = InputButtons.FORWARD | InputButtons.BACK | InputButtons.LEFT | InputButtons.RIGHT;

/** Fight habits a head-to-head test can turn off (`BotOptions.fightOff`). */
export type FightHabit = "cover" | "height" | "unstick" | "itemcheck" | "holster" | "steer" | "tricks";

// Feeler ray constants

// Fading and escaping (see _shouldFade, _escapePoint)
/** Damage taken in a fight that makes a fading strategy leave it. */
const FADE_DAMAGE = 40;

// Habits (see _contested)
/** Match sense from which a bot contests the items its opponent keeps taking. */
const CONTEST_SENSE = 0.6;
/** A taken major item coming back within this long is one to race for. */
const TIMED_ITEM_HORIZON_SECONDS = 20;
/** Route length over straight distance, roughly, for a quick travel estimate. */
const ROUTE_WINDING = 1.3;
/** Running speed for that estimate, units per second. */
const TIMING_RUN_SPEED = 320;
/** How much a test bot's fixed habit weighs, as itemDenial. */
const HABIT_WEIGHT = 2;

// Shopping or hunting (see _shouldSeekItems)
/** Desire an item goal needs to be worth shopping for at aggression 0. */
const SEEK_DESIRE_BASE = 0.2;
/** Extra desire per unit of the gametype's aggression. */
const SEEK_DESIRE_PER_AGGRESSION = 0.25;

/** A route that ends further than this from its item has not reached it. */
const UNREACHED_ITEM_DISTANCE = 64;
/** Beside an item, horizontally, for longer than ITEM_CIRCLE_TICKS without taking it: it is out of reach. */
const ITEM_CIRCLE_RADIUS = 64;
const ITEM_CIRCLE_TICKS = 125;
/** A bot that needs an item chases a heard enemy only this close: round the next corner. */
const SOUND_DIVERT_DISTANCE = 384;

export class StateMachineBrain extends BotBrain {
  // ── Internal state ────────────────────────────────────────────────
  /** This life's route, goals and plans; a new one at each death (BotLife). */
  private _life = new BotLife();
  /** Route following (navigation/BotNavigator). */
  private readonly _nav = new BotNavigator(this._navigatorHost());
  /** Traversal sequences and the route's slides and hops (navigation/BotTraversal). */
  private readonly _traversal = new BotTraversal(this._traversalHost());
  /** Wall clearance, pad throws, climbs and wall jumps (movement/BotSteering). */
  private readonly _steering = new BotSteering(this._steeringHost());
  /** Glances while roaming and the calm look (view/BotLook). */
  private readonly _look = new BotLook(this._lookHost());
  /** The CHASE, RETREAT, ITEM_RUN and HUNT states (states/BotRoam). */
  private readonly _roam = new BotRoam(this._roamHost());
  /** The FIGHT and DODGE states, aim, charged shots and the fight's moves (states/BotFight). */
  private readonly _fight = new BotFight(this._fightHost());
  /** The gametype's orders: the goal they set, guard walks and the leash (orders/BotOrders). */
  private readonly _orders = new BotOrders(this._ordersHost());

  // Slide-blade lunge: when this bot last slid, and when it may roll for a lunge again
  /** Fight habits turned off for head-to-head tests (`BotOptions.fightOff`). */
  private _fightOff: ReadonlySet<FightHabit> = new Set();
  private readonly _mood = new BotMood();
  /** Kills and deaths since the last `takeMoodEvents`, for chat. */
  private _moodEvents: MoodEvent[] = [];

  // Movement variety
  private _strafeDirection: number = 1; // 1 or -1
  /** Who holds movement, view and buttons this decision (InputClaims). */
  private readonly _claims = new InputClaims();
  /** What the bot knows of how the match is going (strategy/MatchRead.ts). */
  /** Player names by entity, from the last decision: people's stack curve is for people. */
  private _names: ReadonlyMap<string, string> = new Map();
  private readonly _matchRead = new MatchRead((seconds, entityId) =>
    isBotName(this._names.get(entityId) ?? "") ? null : typicalStackAfter(loadPeopleProfile(), seconds),
  );
  /** What it needs to do to win (strategy/Strategist.ts), and the strategy in force. */
  private _strategist: Strategist;
  private _strategy: Strategy = STRATEGIES.standard;
  /** The map and gametype whose baseline priors the strategist has. */
  private _priorsFor: string | null = null;
  /** The opponent's habits in this match (strategy/OpponentModel.ts). */
  private readonly _opponents = new OpponentModel();
  /** A test bot's fixation: it goes for every item of this kind (`BotOptions.habitItem`). */
  private _habitItem: string | null = null;
  private _strategyLimit: readonly StrategyId[] | null = null;

  // Crouchslide cooldown. Sequence phases use authoritative server ticks.

  // Charged weapon cadence (blade alt-fire: hold, then release to shoot)
  /** Where a teammate last called enemies, and when. */
  private _teamSighting: { position: Vec3; tick: number } | null = null;
  /** BotOptions.weights: multipliers on the gametype's profile. */
  private _weightScale: Partial<BotWeightProfile> = {};
  /** BotOptions.trace: a DecisionTrace per decision. */
  private _tracing = false;
  private _lastTrace: DecisionTrace | null = null;

  // Random look-around for human-feel

  // NavGraph pathfinding
  private _navGraph: BotNavGraph | null = null;
  private readonly _territory = new BotTerritory();
  private readonly _blocked = new BotBlockedMove();
  /** How many times a player's size this bot's body is; 1 but for a campaign boss. */
  private _bodyScale = 1;
  /** Slime and lava do not hurt this bot (a campaign boss), so it does not get out of them. */
  private _liquidImmune = false;
  private _leadReactionDelayMs = 0;
  private _cancelScript = false;
  private _lastDecisionTick: number = 0;

  /** Goals (by id, for dropped items with no pickup id) on the same cooldown: id → retry tick. */
  private readonly _blockedGoalIds = new Map<string, number>();

  // Scored item-goal selection (docs/research/BOT_WEIGHTS_AND_GOALS.md Phase 1).
  // Replaces "nearest pickup wins" for WHICH item to fetch; the state ladder
  // above still decides WHETHER to fetch one.
  private readonly _itemGoalPlanner: ItemGoalPlanner;
  private readonly _goalArbiterMode: GoalArbiterMode;
  /**
   * Per-decision memo for goal selection.
   *
   * `_executeItemRun` falls through to `_executeHunt`, which also asks for a
   * goal — so without this the arbiter would run twice in one decision. That is
   * not merely wasteful: `select()` advances the commitment window and rolls
   * the mistake dice, so a double call could commit to a different goal than
   * the one it just returned.
   */
  private _goalMemoTick = -1;
  private _goalMemoKey = "";
  private _goalMemoResult: ItemGoalChoice | null = null;

  constructor(difficulty: BotDifficulty, goalArbiterMode: GoalArbiterMode = defaultGoalArbiterMode()) {
    super(difficulty);
    this._goalArbiterMode = goalArbiterMode;
    this._strategist = new Strategist(difficulty.matchSense ?? 0.5);
    // mistakeRate finally does something: an occasional runner-up pick.
    this._itemGoalPlanner = new ItemGoalPlanner(difficulty.mistakeRate);
  }

  // ── Main Decision Loop ────────────────────────────────────────────

  // Store last vision result for use across state methods
  private _lastVision: VisionResult | null = null;
  private _lastBotVision: BotVision | null = null;
  override steeredOffWall(): boolean {
    return this._steering.steered;
  }

  override getNavigationDebug(): string | null {
    const goal = this._life.mandatoryGoal
      ? `order=${this._life.mandatoryGoal.directive?.id}`
      : this._life.activeItemGoal
        ? this._itemGoalPlanner.explain
        : null;
    const sequence = this._traversal.runtime.getDebug(this._lastDecisionTick);
    if (sequence) {
      const remaining = this._life.currentPath
        ? this._life.currentPath.steps.length - this._life.currentPath.cursor
        : 0;
      return `${sequence} remaining=${remaining}${goal ? ` ${goal}` : ""}`;
    }
    if (this._nav.pathBlockedReason) return `blocked=${this._nav.pathBlockedReason}${goal ? ` ${goal}` : ""}`;
    if (!this._life.currentPath || !this._nav.activeNavStep) {
      // No path to describe, but a scored goal choice is still worth surfacing.
      return goal;
    }
    const remaining = this._life.currentPath.steps.length - this._life.currentPath.cursor;
    const nav = `step=${this._nav.activeNavStep} remaining=${remaining}`;
    return goal ? `${nav} ${goal}` : nav;
  }

  /** The bot's running read of the match. */
  get matchRead(): MatchRead {
    return this._matchRead;
  }

  /**
   * Once per map and gametype: the strategy payoffs learned in earlier matches
   * (config/bot-intel, IntelBaseline.ts) as the bandit's starting estimates.
   */
  private _loadPriors(state: BotGameState): void {
    const map = this._lastBotVision?.mapKnowledge?.mapName;
    const gametype = state.matchState.gametypeName;
    if (!map || !gametype) return;
    const key = `${map}|${gametype}`;
    if (key === this._priorsFor) return;
    this._priorsFor = key;
    this._strategist.setPriors(payoffPriors(loadBaseline(map, gametype)));
  }

  override matchReport(): BrainMatchReport {
    const score = this._matchRead.score();
    return {
      score: { own: score.own, bestOther: score.bestOther, deaths: score.deaths },
      fights: this._matchRead.fights(Number.POSITIVE_INFINITY),
      episodes: this._strategist.judged,
    };
  }

  override get strategyId(): string {
    return this._strategist.strategy.id;
  }

  override setTracing(on: boolean): void {
    this._tracing = on;
    if (!on) this._lastTrace = null;
  }

  override get lastTrace(): DecisionTrace | null {
    return this._lastTrace;
  }

  /** The record of the decision just made (BotOptions.trace). */
  private _trace(state: BotGameState): DecisionTrace {
    const selection = this._itemGoalPlanner.lastSelection(state.tick);
    const passed = (selection?.traces ?? []).filter((t) => t.gate === 1).sort((a, b) => b.desire - a.desire);
    const path = this._life.currentPath;
    const step = path ? path.steps[path.cursor] : undefined;
    const sequence = this._traversal.runtime.getDebug(state.tick);
    const self = state.self;
    return {
      tick: state.tick,
      state: this.currentState,
      strategy: this._strategy.id,
      reason: this._strategist.reason,
      orders: state.directives.map((d) => d.id),
      goal: selection?.goalId ?? null,
      candidates: passed
        .slice(0, TRACED_CANDIDATES)
        .map((t) => ({ id: t.goalId, desire: Math.round(t.desire * 1000) / 1000, via: t.via })),
      gated: (selection?.traces ?? []).length - passed.length,
      step: step ? { type: step.type, to: { ...step.to.position }, route: step.opportunityId } : null,
      sequence: sequence ?? null,
      blocked: this._nav.pathBlockedReason,
      position: { ...self.position },
      speed: Math.round(Math.hypot(self.velocity.x, self.velocity.z)),
      grounded: self.isGrounded,
      crouching: self.isCrouching,
      health: self.health,
      armor: self.armor,
      weapon: self.currentWeapon,
      movementOwner: this._claims.owner("movement"),
    };
  }

  /** The strategy in force and why, for diagnostics. */
  get strategyExplain(): string {
    return this._strategist.explain();
  }

  override setDifficulty(difficulty: BotDifficulty): void {
    super.setDifficulty(difficulty);
    this._strategist = new Strategist(difficulty.matchSense ?? 0.5);
    this._strategist.limitTo(this._strategyLimit);
    this._strategy = STRATEGIES.standard;
  }

  /** Multiply the gametype's weights (BotOptions.weights), for head-to-head tests. */
  scaleWeights(scale: Partial<BotWeightProfile>): void {
    this._weightScale = scale;
  }

  /** Play only these strategies (BotOptions.strategies), for head-to-head tests. */
  limitStrategies(strategies: readonly StrategyId[] | null): void {
    this._strategyLimit = strategies;
    this._strategist.limitTo(strategies);
  }

  /**
   * Make this bot go for every item of one kind ("ra", "mega", ...), as a
   * player with a habit does: the opponent the strategist has to read.
   * For head-to-head tests (`bot:ab`).
   */
  setHabitItem(kind: string | null): void {
    this._habitItem = kind;
  }

  /** Turn fight habits off, for head-to-head tests (`bot:ab`). */
  setFightOff(habits: readonly FightHabit[]): void {
    this._fightOff = new Set(habits);
  }

  /** Slime and lava do not hurt this bot: it fights on in them. */
  setLiquidImmune(immune: boolean): void {
    this._liquidImmune = immune;
  }

  /** This bot's body is `scale` times a player's (a campaign boss): its shots leave from its own eye. */
  setBodyScale(scale: number): void {
    this._bodyScale = scale;
  }

  /** The opponent's habits the bot has learned, for diagnostics. */
  get opponentHabits(): OpponentModel {
    return this._opponents;
  }

  /** The gametype's weight profile with the strategy's multipliers. */
  private _weights(state: BotGameState): BotWeightProfile {
    const base = scaleProfile(
      selectWeightProfile(state.matchState.gametypeName, state.getOwnRole(), state.matchState.roundState),
      this._weightScale,
    );
    const weights = applyStrategyWeights(base, this._strategy);
    if (this._habitItem) return { ...weights, itemDenial: Math.max(weights.itemDenial, HABIT_WEIGHT), itemTiming: 1 };
    return weights;
  }

  /**
   * Pickups to contest, 0..1 by pickup id: the opponent's habits, with enough
   * match sense to read them; a test bot's own fixation.
   */
  private _contested(): ReadonlyMap<number, number> | undefined {
    if (this._habitItem) {
      const out = new Map<number, number>();
      for (const pickup of this._lastBotVision?.mapKnowledge.pickupPositions ?? [])
        if (pickup.kind === this._habitItem) out.set(pickup.id, 1);
      return out;
    }
    if ((this.difficulty.matchSense ?? 0.5) < CONTEST_SENSE) return undefined;
    return this._opponents.contested();
  }

  /**
   * Is a major item the bot believes down coming back within
   * TIMED_ITEM_HORIZON_SECONDS, near enough to be there when it does? Then
   * item control is a race the bot can win, whatever its stack.
   */
  private _timedMajorInReach(state: BotGameState, pickups: readonly PickupEntry[] | undefined): boolean {
    for (const entry of pickups ?? []) {
      if (!isMajorItem(entry.type, entry.kind) || state.pickupActiveMask[entry.id] !== false) continue;
      const back = respawnTickOf(state, entry);
      if (back === null) continue;
      const secondsLeft = (back - state.tick) / TICK_RATE;
      if (secondsLeft < 0 || secondsLeft > TIMED_ITEM_HORIZON_SECONDS) continue;
      const travel = (vec3Distance(state.self.position, entry.position) * ROUTE_WINDING) / TIMING_RUN_SPEED;
      if (travel <= secondsLeft + 1) return true;
    }
    return false;
  }

  /** The match read's estimate of an enemy's health and armor, with its uncertainty. */
  private _enemyEstimate(entityId: string): { health: number; armor: number; uncertainty: number } | null {
    const enemy = this._matchRead.enemy(entityId);
    const stack = this._matchRead.enemyStack(entityId);
    return enemy && stack ? { health: enemy.health, armor: enemy.armor, uncertainty: stack.uncertainty } : null;
  }

  /** A retreat line from mood and strategy. */
  private _retreatHealth(base: number): number {
    return this._mood.retreatHealth(base) * this._strategy.stance.retreatScale;
  }

  isSequenceActive(): boolean {
    return this._traversal.runtime.isActive;
  }

  isSequenceCommitted(): boolean {
    return this._traversal.runtime.isCommitted(this._lastDecisionTick);
  }

  decide(
    state: BotGameState,
    vision?: BotVision | null,
    visionResult?: VisionResult | null,
    navGraph?: BotNavGraph | null,
  ): BotInput {
    this._cancelScript = false;
    // Whatever was decided, a blocked bot turns for open ground and one in slime
    // or lava jumps for dry ground; a charge carries on and a calm bot looks down.
    const input = this._escapeLiquid(
      state,
      this._turnFromBlock(state, this._decide(state, vision, visionResult, navGraph)),
    );
    this._fight.carryCharge(state, input);
    if (this._tracing) this._lastTrace = this._trace(state);
    this._look.calm(state, input);
    return this._cancelScript ? { ...input, cancelScript: true } : input;
  }

  private _decide(
    state: BotGameState,
    vision?: BotVision | null,
    visionResult?: VisionResult | null,
    navGraph?: BotNavGraph | null,
  ): BotInput {
    this._nav.pathRecalcTimer++;
    this._steering.begin();
    this._nav.onRouteLine = false;
    this._lastVision = visionResult ?? null;
    this._lastDecisionTick = state.tick;
    this._names = state.playerNames;
    this._matchRead.update(state);
    this._loadPriors(state);
    const before = this._strategy.id;
    this._strategy = this._strategist.update(this._matchRead, state, {
      timedItemInReach: this._timedMajorInReach(state, (vision ?? this._lastBotVision)?.mapKnowledge?.pickupPositions),
    });
    this._opponents.update(this._matchRead);
    if (this._goalArbiterMode === "verbose" && this._strategy.id !== before)
      console.log(`[bot] strategy ${this._strategist.explain()}`);
    this._lastBotVision = vision ?? null;
    this._navGraph = navGraph ?? null;

    // Dead → just wait (BotClient handles RequestSpawn)
    this._claims.begin();
    if (state.self.isDead) {
      this.currentState = BotState.SPAWN;
      this._traversal.interrupt(state, "dead", true);
      this._startLife();
      // Clear vision cache on death
      if (vision) vision.clearCache();
      return this._noInput(state);
    }

    const mandatory = this._orders.selectMandatoryGoal(state);
    if (mandatory?.id !== this._life.mandatoryGoal?.id) {
      this._life.currentPath = null;
      this._life.pathTarget = null;
      this._traversal.interrupt(state, "objective_changed", true);
    }
    this._life.mandatoryGoal = mandatory;
    const seesEnemy = this._lastVision ? this._lastVision.visibleEnemies.length > 0 : state.getNearestEnemy() !== null;
    if (seesEnemy || state.wasRecentlyDamaged(DODGE_REACT_TICKS)) this._life.recovery = null;
    if (this._life.recovery && state.tick < this._life.recovery.until && !mandatory) {
      if (vec3Length(vec3Subtract(this._life.recovery.target, state.self.position)) > 24) {
        const input = this._moveTowardPrecise(state, this._life.recovery.target);
        if (!state.self.isGrounded) input.buttons |= InputButtons.CROUCH;
        return input;
      }
      this._life.recovery = null;
    }
    if (
      !state.directives.some(
        (order) => `objective:${order.id}` === this._life.sitePatrol?.goalId && order.expiresAtTick > state.tick,
      )
    ) {
      this._life.sitePatrol = null;
    }

    // Determine state based on priority
    const newState = this._evaluateState(state);
    const stateChanged = newState !== this.currentState;
    if (this._traversal.runtime.isActive && stateChanged) {
      this._traversal.interrupt(state, `state:${newState}`);
    }

    if (this._traversal.runtime.isActive) {
      const sequenceInput = this._traversal.tick(state);
      if (sequenceInput) {
        // A slide along a route is ground movement at speed: steered like any run
        const vision = this._lastBotVision;
        const steered =
          vision && this._traversal.runtime.activeSequenceId === "route_crouchslide" && !this._fightOff.has("steer")
            ? this._steering.steer(sequenceInput, state, vision)
            : sequenceInput;
        return this._nav.recoverStalledNavigation(state, steered);
      }
    }

    if (stateChanged) {
      const inCombat = (s: BotState) => s === BotState.FIGHT || s === BotState.CHASE || s === BotState.DODGE;
      if (newState === BotState.FIGHT && !inCombat(this.currentState)) {
        this._mood.startFight(state.tick, this.difficulty.mistakeRate);
      } else if (!inCombat(newState)) {
        this._mood.endFight();
      }
      this.currentState = newState;
      this._life.currentPath = null; // Clear path on state change
      this._life.huntPatrolTarget = null;
    }

    // Execute current state
    let input: BotInput;
    switch (this.currentState) {
      case BotState.FIGHT:
        input = this._fight.fight(state);
        break;
      case BotState.CHASE:
        input = this._roam.chase(state);
        break;
      case BotState.DODGE:
        input = this._fight.dodge(state);
        break;
      case BotState.RETREAT:
        input = this._roam.retreat(state);
        break;
      case BotState.ITEM_RUN:
        input = this._roam.itemRun(state);
        break;
      case BotState.HUNT:
        input = this._roam.hunt(state);
        break;
      default:
        input = this._roam.hunt(state);
        break;
    }

    return this._afterSteps(state, input, vision);
  }

  /**
   * The after-steps, in this order, on what the state's executor chose:
   *
   * 1. Stall recovery, for a route that has stopped making progress.
   * 2. Clearance: the feet are steered clear of walls, corners and ledges
   *    (BotSteering), except on an exact line.
   * 3. High ground, in a chase with the health for it.
   * 4. The leash: a guard that a fight or chase has drawn past it heads back.
   * 5. Readying the weapon for an enemy heard, out of a fight.
   * 6. Traversal starts: a ledge slide-jump, an item slide, the route's
   *    crouch-slide or strafe jump. One that starts takes the decision.
   * 7. Tricks: climbs and wall jumps toward the point the bot makes for.
   * 8. The look into open space while roaming (BotLook).
   *
   * Corrections and takeovers of movement check who holds it (InputClaims).
   */
  private _afterSteps(state: BotGameState, chosen: BotInput, vision: BotVision | null | undefined): BotInput {
    let input = this._nav.recoverStalledNavigation(state, chosen);

    // Keep the feet clear of walls, corners and ledges in every state: a
    // correction, so not on a line held exactly.
    if (vision && this._claims.mayCorrect("movement")) {
      if (!this._fightOff.has("steer")) input = this._steering.steer(input, state, vision);
      else if (!this._nav.onRouteLine && this.currentState !== BotState.FIGHT && this.currentState !== BotState.DODGE) {
        // The feelers, for head-to-head tests: navigation only, and not on a
        // route line, where they saw a wall beyond a corner and turned off it.
        input = this._steering.feelers(input, state, vision);
      }
    }

    // Combat orders answer the fight and take movement whoever holds it.
    const chase = this.currentState === BotState.CHASE ? this._lastVision?.chaseTarget : null;
    if (chase && state.self.health >= 50)
      input = this._fight.keepUpperGround(state, { position: chase.lastSeenPosition }, input);
    if (
      this.currentState === BotState.FIGHT ||
      this.currentState === BotState.CHASE ||
      this.currentState === BotState.DODGE
    ) {
      input = this._orders.applyLeash(state, input);
    }

    if (this.currentState !== BotState.FIGHT && this.currentState !== BotState.DODGE) {
      this._fight.readyForHeard(state, input);
    }

    // Traversal starts are takeovers: only on movement nobody holds.
    if (this._claims.mayTakeOver("movement")) {
      const ledgeJump = this._traversal.tryStartLedgeSlideJump(input, state);
      if (ledgeJump) return ledgeJump;
      const itemSlideInput = this._traversal.tryStartItemSlideApproach(input, state);
      if (itemSlideInput) return itemSlideInput;
      const routeSlideInput = this._traversal.tryStartRouteCrouchslide(input, state);
      if (routeSlideInput) return routeSlideInput;
      const strafeInput = this._traversal.tryStartRouteStrafeJump(input, state);
      if (strafeInput) return strafeInput;
    }

    if (
      vision &&
      this._claims.mayCorrect("movement") &&
      !this._fightOff.has("steer") &&
      !this._fightOff.has("tricks")
    ) {
      input = this._steering.tryTricks(state, input);
    }
    this._steering.lastJumpHeld = (input.buttons & InputButtons.JUMP) !== 0;

    if (vision) this._look.lookIntoOpenSpace(state, input, vision);
    return input;
  }

  // ── State Evaluation ──────────────────────────────────────────────

  private _evaluateState(state: BotGameState): BotState {
    // Non-interruptible work must reach the navigation executor before combat,
    // chase or item shopping can divert it. Death is handled by decide().
    if (this._life.mandatoryGoal) return BotState.ITEM_RUN;
    // A hit holds the bot on its attacker long enough to turn round and
    // answer. Held only a quarter second, a bot shot in the back turned part
    // way and went back to its item, and a chaser shot it in the back again.
    const hitAttentionTicks = Math.round(((this.difficulty.hitAttentionMs ?? HIT_ATTENTION_MS) / 1000) * TICK_RATE);
    const recentlyDamaged = state.wasRecentlyDamaged(hitAttentionTicks);

    // Use vision data if available, otherwise fall back to raw state
    const hasVisibleEnemy = this._lastVision
      ? this._lastVision.visibleEnemies.length > 0
      : state.getNearestEnemy() !== null;

    const nearestVisibleEnemy = this._lastVision
      ? (this._lastVision.visibleEnemies[0]?.player ?? null)
      : state.getNearestEnemy();

    // Priority 1: Being shot at → engage or dodge
    if (recentlyDamaged) {
      const attacker = state.getLastAttacker();
      if (attacker && this._lastVision) {
        // Can we actually SEE the attacker? (LOS check via vision)
        const attackerVisible = this._lastVision.visibleEnemies.find((e) => e.player.playerId === attacker);
        if (attackerVisible) {
          return BotState.FIGHT;
        }
      } else if (attacker && nearestVisibleEnemy) {
        // No vision → fallback: assume nearest enemy is attacker
        return BotState.FIGHT;
      }
      // Can't see attacker → dodge/retreat
      if (state.self.health < this._retreatHealth(RETREAT_HEALTH_THRESHOLD)) {
        return BotState.RETREAT;
      }
      return BotState.DODGE;
    }

    // Priority 2: Enemy visible → fight, unless the strategy says this one is costing too much.
    if (hasVisibleEnemy && nearestVisibleEnemy && nearestVisibleEnemy.distance < FIGHT_RANGE) {
      if (this._shouldFade(state, nearestVisibleEnemy.entityId)) return BotState.RETREAT;
      return BotState.FIGHT;
    }

    // Ducked into cover between shots: still the same fight.
    if (this.currentState === BotState.FIGHT && this._fight.coverPeek.holding(state.tick)) return BotState.FIGHT;

    // Priority 2.5: Lost sight of enemy but tracking them → chase!
    // ...unless this fight's mistake is to forget them the moment they are gone.
    // A distant sound does not pull a bot off an item it needs: the track
    // fades in about a second, and the bot would turn back to the item. Once
    // chasing, it keeps chasing; distance alone would flip it in and out as
    // the gap crosses the limit.
    const chaseTarget = this._lastVision?.chaseTarget;
    // A strategy that wants no fight lets an enemy out of sight go.
    const leash = this._orders.leashOrder(state);
    const pastLeash =
      chaseTarget !== null &&
      chaseTarget !== undefined &&
      leash !== null &&
      Math.hypot(chaseTarget.lastSeenPosition.x - leash.center.x, chaseTarget.lastSeenPosition.z - leash.center.z) >
        leash.leash;
    if (chaseTarget && !pastLeash && this._strategy.stance.chase && this._mood.mistake(state.tick) !== "forget") {
      const distantSound =
        chaseTarget.source === "sound" &&
        this.currentState !== BotState.CHASE &&
        vec3Length(vec3Subtract(chaseTarget.lastSeenPosition, state.self.position)) > SOUND_DIVERT_DISTANCE;
      return (distantSound ? this._evaluateItemState(state) : null) ?? BotState.CHASE;
    }

    // Default: Hunt for enemies
    return this._evaluateItemState(state) ?? BotState.HUNT;
  }

  /** RETREAT or ITEM_RUN when the bot has somewhere to be, else null. */
  private _evaluateItemState(state: BotGameState): BotState | null {
    // Priority 3: Low health → retreat to find health
    if (state.self.health < this._retreatHealth(LOW_HEALTH_THRESHOLD)) {
      const hasPickup = state.getNearestPickup(PICKUP_SEEK_RANGE);
      if (hasPickup) {
        return BotState.RETREAT;
      }
    }

    // Priority 4: Need items → go get them
    if (this._shouldSeekItems(state)) {
      return BotState.ITEM_RUN;
    }

    // A live gametype order is reason enough to stop roaming. ITEM_RUN is the
    // navigate-to-a-goal executor; the arbiter decides whether the order or an
    // item actually wins, so this only says "there is somewhere to be".
    if (state.directives.length > 0) {
      return BotState.ITEM_RUN;
    }
    return null;
  }

  // ── FIGHT State ───────────────────────────────────────────────────

  override get aimDifficulty(): BotDifficulty {
    const difficulty = this._mood.aimDifficulty(this.difficulty);
    return this._leadReactionDelayMs
      ? { ...difficulty, reactionTimeMs: difficulty.reactionTimeMs + this._leadReactionDelayMs }
      : difficulty;
  }

  override observe(state: BotGameState): void {
    this._leadReactionDelayMs = duelLeadReactionDelay(state);
    this._moodEvents.push(...this._mood.update(state));
    if (this._moodEvents.length > 20) this._moodEvents.splice(0, this._moodEvents.length - 20);
  }

  override get moodState(): { mood: Mood; killStreak: number; deathStreak: number } {
    return { mood: this._mood.mood, killStreak: this._mood.killStreak, deathStreak: this._mood.deathStreak };
  }

  override takeMoodEvents(): MoodEvent[] {
    const events = this._moodEvents;
    this._moodEvents = [];
    return events;
  }

  // ── DODGE State ───────────────────────────────────────────────────

  // ── CHASE State — Pursuit after LOS break ──────────────────────────

  // ── RETREAT State ─────────────────────────────────────────────────

  /**
   * Fade out of a fight: a strategy that fades (Recover, Protect lead), at least
   * FADE_DAMAGE taken in this fight, and no stack advantage by the estimate.
   */
  private _shouldFade(state: BotGameState, enemyEntityId: string): boolean {
    if (!this._strategy.stance.fade) return false;
    const fight = this._matchRead.openFight(enemyEntityId);
    if (!fight || fight.taken < FADE_DAMAGE) return false;
    const enemy = this._matchRead.enemyStack(enemyEntityId);
    const own = state.self.health + state.self.armor;
    return !enemy || enemy.uncertainty > 0.5 || own <= enemy.stack;
  }

  // ── ITEM_RUN State ────────────────────────────────────────────────

  // ── HUNT State ────────────────────────────────────────────────────

  // ── Aiming ────────────────────────────────────────────────────────

  // ── Weapon Selection ──────────────────────────────────────────────

  // ── Movement Helpers ──────────────────────────────────────────────

  /**
   * A point on the bot's territory to make for (BotTerritory), round `center`
   * when given, in a mode that keeps territory (GametypeHabits); null in
   * others, or when hurt or out of ammo with no center.
   */
  private _territoryPoint(state: BotGameState, center?: Vec3): Vec3 | null {
    if (!selectGametypeHabits(state.matchState.gametypeName).keepsTerritory || !this._navGraph || !this._lastBotVision)
      return null;
    if (
      !center &&
      (state.self.health < 60 ||
        !state.self.weapons.some((weapon) => !getWeaponProfile(weapon).isMelee && (state.self.ammo[weapon] ?? 10) >= 3))
    )
      return null;
    return this._territory.choose(
      state,
      this._navGraph,
      this._lastBotVision,
      this._nav.pathOptions(state.tick),
      center,
    );
  }

  /**
   * Whatever the state, a bot that asks to move and goes nowhere turns away
   * from what holds it and thinks again (BotBlockedMove). Out of a fight the
   * route is planned again around the spot (`_startRecovery`). In one, where
   * that recovery would be dropped at once, the route is dropped too, and the
   * bot keeps its aim and fire, runs the open way for UNSTICK_TICKS and
   * strafes the other way after.
   */
  private _turnFromBlock(state: BotGameState, input: BotInput): BotInput {
    if (this._fightOff.has("unstick")) return input;
    const self = state.self;
    if (this._life.unstick && state.tick < this._life.unstick.untilTick && !self.isDead) {
      return this._runOpen(input, this._life.unstick.yaw);
    }
    this._life.unstick = null;
    const asking =
      !self.isDead &&
      self.isGrounded &&
      Math.hypot(self.velocity.x, self.velocity.z) < BLOCKED_SPEED &&
      (input.direction.x !== 0 || input.direction.z !== 0 || (input.buttons & MOVE_KEYS) !== 0) &&
      !(this._lastVision?.visibleEnemies.some((enemy) => enemy.player.distance < ENEMY_BODY_RANGE) ?? false);
    if (!this._blocked.update(state.tick, self.position, asking)) return input;
    const heading = travelYaw(input) + Math.atan2(input.direction.x, input.direction.z);
    const fighting =
      this.currentState === BotState.FIGHT ||
      this.currentState === BotState.DODGE ||
      (this._lastVision ? this._lastVision.visibleEnemies.length > 0 : false) ||
      state.wasRecentlyDamaged(DODGE_REACT_TICKS);
    if (!fighting) return this._startRecovery(state, true, heading);
    // The route that led here is planned again, another way.
    const step = this._traversal.activeStep ?? this._life.currentPath?.steps[this._life.currentPath.cursor];
    if (step) this._nav.cooldownStep(step, state.tick);
    this._life.currentPath = null;
    this._life.pathTarget = null;
    this._traversal.interrupt(state, "blocked", true);
    this._cancelScript = true;
    this._strafeDirection = -this._strafeDirection;
    const yaw = this._openHeading(state, heading);
    this._life.unstick = { yaw, untilTick: state.tick + UNSTICK_TICKS };
    return this._runOpen(input, yaw);
  }

  /**
   * In slime or lava, whatever the state, the bot jumps for the nearest dry
   * ground (LiquidEscape): back up to a ledge or on to an island, whichever is
   * nearer. Aim and fire stay.
   */
  private _escapeLiquid(state: BotGameState, input: BotInput): BotInput {
    const self = state.self;
    const world = this._lastBotVision?.collisionWorld;
    if (self.isDead || !world || this._liquidImmune || !inHarmfulLiquid(world, self.position)) {
      this._life.liquidEscape = null;
      return input;
    }
    if (!this._life.liquidEscape || state.tick - this._life.liquidEscape.chosenTick >= LIQUID_ESCAPE_REPLAN_TICKS) {
      const target = liquidEscapeTarget(world, self.position, this._navGraph?.nodes ?? []);
      this._life.liquidEscape = { target, chosenTick: state.tick };
    }
    const target = this._life.liquidEscape.target;
    const yaw = target ? Math.atan2(target.x - self.position.x, target.z - self.position.z) : travelYaw(input);
    // Jump held: it hops off the bottom and swims up
    const out = this._runOpen(input, yaw);
    return { ...out, buttons: out.buttons | InputButtons.JUMP };
  }

  /** The way out nearest to straight back from `heading` with floor to walk on. */
  private _openHeading(state: BotGameState, heading: number): number {
    const vision = this._lastBotVision;
    const self = state.self.position;
    for (const turn of [Math.PI, Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 4, (-3 * Math.PI) / 4]) {
      const yaw = heading + turn;
      if (!vision) return yaw;
      const target = {
        x: self.x + Math.sin(yaw) * UNSTICK_PROBE,
        y: self.y,
        z: self.z + Math.cos(yaw) * UNSTICK_PROBE,
      };
      if (!vision.isWalkable(self, target)) continue;
      const floor = vision.collisionWorld.trace(target, { ...target, y: target.y - 64 });
      if (floor.hit && floor.fraction < 1) return yaw;
    }
    return heading + Math.PI;
  }

  /** `input` with its movement replaced by a run toward `yaw`; aim and fire stay. */
  private _runOpen(input: BotInput, yaw: number): BotInput {
    return {
      ...input,
      moveYaw: yaw,
      direction: { x: 0, y: 0, z: 1 },
      buttons:
        (input.buttons & ~(MOVE_KEYS | InputButtons.JUMP | InputButtons.CROUCH)) |
        InputButtons.FORWARD |
        InputButtons.SPRINT,
    };
  }

  /**
   * Step back and plan again. The step under way goes on cooldown, so the next
   * route goes another way. `stuck` (no progress at all) also puts the item
   * being fetched on cooldown; a missed jump or a blocked drop does not: the
   * item is still worth having and other routes, other tricks, lead to it.
   */
  private _startRecovery(state: BotGameState, stuck = false, blockedHeading?: number): BotInput {
    this._cancelScript = true;
    const step = this._traversal.activeStep ?? this._life.currentPath?.steps[this._life.currentPath.cursor];
    if (step) this._nav.cooldownStep(step, state.tick);
    if (stuck && this.currentState !== BotState.CHASE && this._life.activeItemGoal?.pickupId !== undefined)
      this._nav.blockedPickupIds.set(this._life.activeItemGoal.pickupId, state.tick + PICKUP_FAILURE_COOLDOWN_TICKS);
    this._traversal.interrupt(state, "no_navigation_progress", true);
    this._itemGoalPlanner.reset();
    this._life.activeItemGoal = null;
    this._life.currentPath = null;
    this._life.pathTarget = null;
    this._life.huntPatrolTarget = null;
    this._territory.reset();
    this._life.navigationProgress = { position: { ...state.self.position }, tick: state.tick };
    this._blocked.reset();
    const self = state.self.position;
    const away = step
      ? Math.atan2(self.x - step.to.position.x, self.z - step.to.position.z)
      : (blockedHeading ?? state.self.yaw) + Math.PI;
    for (const distance of [128, 64, 32]) {
      for (const turn of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
        const target = {
          x: self.x + Math.sin(away + turn) * distance,
          y: self.y,
          z: self.z + Math.cos(away + turn) * distance,
        };
        const vision = this._lastBotVision;
        if (vision && !vision.isWalkable(self, target)) continue;
        if (vision) {
          const floor = vision.collisionWorld.trace(target, { ...target, y: target.y - 64 });
          if (!floor.hit || floor.fraction >= 1) continue;
        }
        this._life.recovery = { target, until: state.tick + 125 };
        const input = this._moveTowardPrecise(state, target);
        if (!state.self.isGrounded) input.buttons |= InputButtons.CROUCH;
        return input;
      }
    }
    const input = this._moveToward(
      state,
      { x: self.x + Math.sin(away) * 32, y: self.y, z: self.z + Math.cos(away) * 32 },
      false,
    );
    return input;
  }

  /**
   * Wait by a timed item looking at the ways in, a few seconds each, rather
   * than at the item: whoever comes for it arrives through one of them.
   */

  /**
   * The route ended short of the item being fetched and there is no clear walk
   * from here to it: an item dropped down a ledge or behind a wall from the
   * nearest node. Put it on the failure cooldown. Walking straight at it ran
   * the bot into the wall, and the next decision found the same route back to
   * the node, turning it round every few tenths of a second.
   */
  private _dropUnreachableItemGoal(state: BotGameState, target: Vec3): void {
    const goal = this._life.activeItemGoal;
    const vision = this._lastBotVision;
    if (!goal || goal.directive || !vision) return;
    if (vec3Length(vec3Subtract(goal.position, target)) > 1) return;
    if (vec3Length(vec3Subtract(target, state.self.position)) <= UNREACHED_ITEM_DISTANCE) return;
    if (vision.isWalkable(state.self.position, target)) return;
    this._blockItemGoal(goal, state.tick);
  }

  /**
   * Give up for a while on an item the bot has stayed beside without taking:
   * one on a lip above or below it, which it circled at full speed.
   */
  private _giveUpOnCircledItem(state: BotGameState): void {
    const goal = this._life.activeItemGoal;
    const self = state.self.position;
    // Waiting beside a major item for its return is item timing, not circling.
    const down = goal?.respawnTick !== undefined && goal.respawnTick > state.tick;
    if (
      !goal ||
      goal.directive ||
      down ||
      Math.hypot(goal.position.x - self.x, goal.position.z - self.z) > ITEM_CIRCLE_RADIUS
    ) {
      this._life.itemCircle = null;
      return;
    }
    if (this._life.itemCircle?.goalId !== goal.id) {
      this._life.itemCircle = { goalId: goal.id, sinceTick: state.tick };
    } else if (state.tick - this._life.itemCircle.sinceTick > ITEM_CIRCLE_TICKS) {
      this._life.itemCircle = null;
      this._blockItemGoal(goal, state.tick);
    }
  }

  private _blockItemGoal(goal: BotGoal, tick: number): void {
    const retry = tick + PICKUP_FAILURE_COOLDOWN_TICKS;
    this._blockedGoalIds.set(goal.id, retry);
    if (goal.pickupId !== undefined) this._nav.blockedPickupIds.set(goal.pickupId, retry);
    this._itemGoalPlanner.reset();
    this._life.activeItemGoal = null;
  }

  /**
   * Navigate to nearest item of a given type using NavGraph.
   * Caches the path to avoid running A* every tick.
   * Returns null if no path to item found.
   */
  /**
   * Choose WHICH item to fetch, by score rather than by distance.
   *
   * Returns null when the arbiter is disabled, when map pickup knowledge is not
   * loaded, or when nothing is worth going for — callers then fall through to
   * the legacy path, so a bot is never left standing still by this returning
   * nothing. The goal comes with the item to take on the way to it, if any.
   */
  private _selectItemGoal(
    state: BotGameState,
    typeFilter?: ReadonlySet<string>,
    ignoreDirectives = false,
  ): ItemGoalChoice | null {
    if (this._goalArbiterMode === "legacy") return null;

    // One arbitration per decision, per distinct request shape.
    const memoKey = `${typeFilter ? [...typeFilter].join(",") : "*"}|${ignoreDirectives ? 1 : 0}`;
    if (this._goalMemoTick === state.tick && this._goalMemoKey === memoKey) {
      return this._goalMemoResult;
    }

    const pickupPositions = this._lastBotVision?.mapKnowledge.pickupPositions;
    // Directives still stand without map pickup knowledge — an objective is not
    // an item, and a bot with no nav cache must still follow its orders.
    if ((!pickupPositions || pickupPositions.length === 0) && (ignoreDirectives || state.directives.length === 0)) {
      return null;
    }

    // Expire failure cooldowns first so a previously-blocked item can return.
    for (const [pickupId, retryTick] of this._nav.blockedPickupIds) {
      if (state.tick >= retryTick) this._nav.blockedPickupIds.delete(pickupId);
    }
    for (const [goalId, retryTick] of this._blockedGoalIds) {
      if (state.tick >= retryTick) this._blockedGoalIds.delete(goalId);
    }
    this._giveUpOnCircledItem(state);

    const result = this._itemGoalPlanner.select(state, {
      pickupPositions: pickupPositions ?? [],
      maxDistance: PICKUP_SEEK_RANGE,
      blockedPickupIds: new Set(this._nav.blockedPickupIds.keys()),
      blockedGoalIds: new Set(this._blockedGoalIds.keys()),
      typeFilter,
      ignoreDirectives,
      weights: this._weights(state),
      contested: this._contested(),
      // Real graph distances when the map's nav graph is loaded, so an item
      // behind a wall is gated as unreachable instead of looking close.
      navGraph: this._navGraph,
    });

    this._life.activeItemGoal = result.goal;
    this._goalMemoTick = state.tick;
    this._goalMemoKey = memoKey;
    this._goalMemoResult = result.goal ? { goal: result.goal, stopover: result.stopover, desire: result.desire } : null;
    if (this._goalArbiterMode === "verbose" && result.goal) {
      console.log(`[bot] ${result.explain}`);
    }
    return this._goalMemoResult;
  }

  private _navigateToItem(state: BotGameState, itemType: string, urgent: boolean): BotInput | null {
    if (!this._navGraph) return null;

    const goalPickupId = this._life.currentPath?.nodes[this._life.currentPath.nodes.length - 1]?.pickupId;
    if (
      goalPickupId !== undefined &&
      (state.pickupActiveMask[goalPickupId] === false || this._nav.blockedPickupIds.has(goalPickupId))
    ) {
      this._life.currentPath = null;
      this._life.pathTarget = null;
      this._nav.pathRecalcTimer = PATH_RECALC_INTERVAL + 1;
    }

    // Only recalculate item paths periodically
    if (!this._life.currentPath || this._nav.pathRecalcTimer > PATH_RECALC_INTERVAL) {
      const itemPath = this._navGraph.findPathToItem(
        state.self.position,
        itemType,
        state.pickupActiveMask,
        this._nav.pathOptions(state.tick),
      );
      if (!itemPath) return null;
      this._life.currentPath = itemPath;
      this._life.pathTarget = itemPath.nodes[itemPath.nodes.length - 1]?.position ?? null;
      this._nav.pathRecalcTimer = 0;
    }

    if (this._life.currentPath) {
      const result = this._nav.followCurrentPath(state, urgent);
      if (result.status === "moving") return result.input;
      if (result.status === "blocked") return this._startRecovery(state);
      // Arrived at item — clear path
      this._life.currentPath = null;
    }

    return null;
  }

  private _moveTowardPrecise(state: BotGameState, target: Vec3): BotInput {
    return this._makePrecise(this._moveToward(state, target, false));
  }

  private _makePrecise(input: BotInput): BotInput {
    input.buttons &= ~(InputButtons.JUMP | InputButtons.CROUCH);
    input.buttons |= InputButtons.FORWARD | InputButtons.SPRINT;
    input.direction.x = 0;
    input.direction.z = 1;
    return input;
  }

  /**
   * Direct movement toward a target position.
   * Low-level: run toward a point; traversal and combat own jump decisions.
   *
   * NOTE: Server ticks at 125Hz but bot sends input at 12-33Hz.
   * Last input PERSISTS across ~4-10 server ticks. This means:
   * - JUMP stays pressed for many physics ticks → autohop triggers on landing
   * - Button flags like LEFT/RIGHT must be set alongside direction.x
   *   for the server's strafejump air acceleration to activate
   */
  private _moveToward(state: BotGameState, target: Vec3, _urgent: boolean): BotInput {
    this._steering.target = target;
    const delta = vec3Subtract(target, state.self.position);
    const distance = vec3Length(delta);
    const targetYaw = distance < 1 ? state.self.yaw : Math.atan2(delta.x, delta.z);

    // NEVER send zero direction — it persists on the server for 30-80ms
    // causing friction to decelerate the bot to 0 across multiple physics ticks.
    // Even if very close, keep moving forward.

    // Always sprint + forward — arena FPS bots strafe-run by default
    const buttons = InputButtons.FORWARD | InputButtons.SPRINT;

    return {
      direction: { x: 0, y: 0, z: 1 },
      pitch: 0,
      yaw: targetYaw,
      buttons,
      weaponSlot: 0,
    };
  }

  // ── Feeler Raycasts (Wall Avoidance) ──────────────────────────────

  // ── Decision Helpers ──────────────────────────────────────────────

  /**
   * Whether to go shopping rather than hunt. Hurt or out of ammo, always; with
   * 25 armor or more, no, unless the strategy shops armoured (Recover, Control,
   * Protect lead), and then for an item worth it as below. Under 25 armor with no idea where an enemy is, yes:
   * there is no one to hunt, so the item cycle is the better use of the time.
   * Under 25 armor with an enemy to hunt, the item planner's best goal has to
   * be worth it against the gametype's `aggression`: SEEK_DESIRE_BASE +
   * SEEK_DESIRE_PER_AGGRESSION × aggression, scaled by the strategy's
   * `seekScale`. Duel (aggression 0.5) keeps
   * shopping for most items; Deathmatch (0.8) takes only the good ones.
   * Before, any bot under 25 armor shopped, which is every bot after it spawns,
   * and HUNT was about 1–2% of roaming time.
   */
  private _shouldSeekItems(state: BotGameState): boolean {
    if (state.self.health < 50) return true;
    const currentAmmo = state.self.ammo[state.self.currentWeapon];
    if (currentAmmo !== undefined && currentAmmo < 3) return true;

    const stance = this._strategy.stance;
    if (state.self.armor >= 25 && !stance.shopArmored) return false;
    if (state.self.armor < 25 && !this._getHuntTarget(state)) return true;
    const best = this._selectItemGoal(state);
    if (!best) return this._goalArbiterMode === "legacy" && state.self.armor < 25;
    const worth = (SEEK_DESIRE_BASE + SEEK_DESIRE_PER_AGGRESSION * this._weights(state).aggression) * stance.seekScale;
    return best.desire >= worth;
  }

  private _getHuntTarget(state: BotGameState): Vec3 | null {
    // Go to last known enemy position (if recent)
    let bestTarget: Vec3 | null = null;
    let bestTick = 0;

    for (const [, data] of state.lastKnownEnemyPositions) {
      if (data.tick > bestTick && state.tick - data.tick < 300) {
        bestTick = data.tick;
        bestTarget = data.position;
      }
    }
    // Else where a teammate last called enemies, while the call is fresh.
    const call = this._teamSighting;
    if (!bestTarget && call && state.tick - call.tick < TEAM_SIGHTING_TICKS) bestTarget = call.position;

    return bestTarget;
  }

  /** A teammate called enemies at a place (BotCallouts): somewhere to hunt. */
  override noteTeamSighting(position: Vec3, tick: number): void {
    this._teamSighting = { position: { ...position }, tick };
  }

  /** What traversal reaches of this brain. */
  private _traversalHost(): TraversalHost {
    const brain = this;
    return {
      get life() {
        return brain._life;
      },
      get navGraph() {
        return brain._navGraph;
      },
      get vision() {
        return brain._lastBotVision;
      },
      get visionResult() {
        return brain._lastVision;
      },
      get difficulty() {
        return brain.difficulty;
      },
      get currentState() {
        return brain.currentState;
      },
      get tracer() {
        return brain._steering.tracer;
      },
      get nav() {
        return brain._nav;
      },
      cancelScript: () => {
        this._cancelScript = true;
      },
      holdMovementExact: (owner) => this._claims.hold("movement", owner, "exact"),
      startRecovery: (state, stuck) => this._startRecovery(state, stuck),
    };
  }

  /** What steering reaches of this brain. */
  private _steeringHost(): SteeringHost {
    const brain = this;
    return {
      get life() {
        return brain._life;
      },
      get currentState() {
        return brain.currentState;
      },
      get sequenceActive() {
        return brain._traversal.runtime.isActive;
      },
      get onRouteLine() {
        return brain._nav.onRouteLine;
      },
      get strafeDirection() {
        return brain._strafeDirection;
      },
    };
  }

  /** What the look reaches of this brain. */
  private _lookHost(): LookHost {
    const brain = this;
    return {
      get life() {
        return brain._life;
      },
      get currentState() {
        return brain.currentState;
      },
      get sequenceActive() {
        return brain._traversal.runtime.isActive;
      },
      get visionResult() {
        return brain._lastVision;
      },
      get fightOff() {
        return brain._fightOff;
      },
    };
  }

  /** What following orders reaches of this brain. */
  private _ordersHost(): OrdersHost {
    const brain = this;
    return {
      get life() {
        return brain._life;
      },
      get nav() {
        return brain._nav;
      },
      get navGraph() {
        return brain._navGraph;
      },
      get vision() {
        return brain._lastBotVision;
      },
      get claims() {
        return brain._claims;
      },
      get bodyScale() {
        return brain._bodyScale;
      },
      get goalArbiterMode() {
        return brain._goalArbiterMode;
      },
      territoryPoint: (...args) => brain._territoryPoint(...args),
      startRecovery: (...args) => brain._startRecovery(...args),
    };
  }

  /** What fighting reaches of this brain. */
  private _fightHost(): FightHost {
    const brain = this;
    return {
      get life() {
        return brain._life;
      },
      get navGraph() {
        return brain._navGraph;
      },
      get vision() {
        return brain._lastBotVision;
      },
      get visionResult() {
        return brain._lastVision;
      },
      get traversal() {
        return brain._traversal;
      },
      get mood() {
        return brain._mood;
      },
      get difficulty() {
        return brain.difficulty;
      },
      get aimDifficulty() {
        return brain.aimDifficulty;
      },
      get currentState() {
        return brain.currentState;
      },
      get fightOff() {
        return brain._fightOff;
      },
      get bodyScale() {
        return brain._bodyScale;
      },
      get strafeDirection() {
        return brain._strafeDirection;
      },
      set strafeDirection(value) {
        brain._strafeDirection = value;
      },
      enemyEstimate: (...args) => brain._enemyEstimate(...args),
      hunt: (...args) => brain._roam.hunt(...args),
    };
  }

  /** What roaming reaches of this brain. */
  private _roamHost(): RoamHost {
    const brain = this;
    return {
      get life() {
        return brain._life;
      },
      get nav() {
        return brain._nav;
      },
      get navGraph() {
        return brain._navGraph;
      },
      get vision() {
        return brain._lastBotVision;
      },
      get visionResult() {
        return brain._lastVision;
      },
      get difficulty() {
        return brain.difficulty;
      },
      territoryPoint: (...args) => brain._territoryPoint(...args),
      keepUpperGround: (...args) => brain._fight.keepUpperGround(...args),
      fireOrigin: (...args) => brain._fight.fireOrigin(...args),
      moveToward: (...args) => brain._moveToward(...args),
      selectItemGoal: (...args) => brain._selectItemGoal(...args),
      navigateToItem: (...args) => brain._navigateToItem(...args),
      navigateGoal: (...args) => brain._orders.navigateGoal(...args),
      huntTarget: (...args) => brain._getHuntTarget(...args),
    };
  }

  /** What the navigator reaches of this brain. */
  private _navigatorHost(): NavigatorHost {
    const brain = this;
    return {
      get life() {
        return brain._life;
      },
      get navGraph() {
        return brain._navGraph;
      },
      get vision() {
        return brain._lastBotVision;
      },
      get currentState() {
        return brain.currentState;
      },
      moveToward: (state, target, urgent) => this._moveToward(state, target, urgent),
      moveTowardPrecise: (state, target) => this._moveTowardPrecise(state, target),
      makePrecise: (input) => this._makePrecise(input),
      holdPosition: (state, target) => this._holdPosition(state, target),
      startRecovery: (state, stuck) => this._startRecovery(state, stuck),
      dropUnreachableItemGoal: (state, target) => this._dropUnreachableItemGoal(state, target),
      tryStartLedgeSlideJump: (input, state) => this._traversal.tryStartLedgeSlideJump(input, state),
      startNavSequence: (state, step, sequenceId) => this._traversal.startNav(state, step, sequenceId),
      holdMovementExact: (owner) => this._claims.hold("movement", owner, "exact"),
    };
  }

  /**
   * A new life: nothing of the last one's route, goals and plans, and the
   * helpers that keep per-life state of their own reset. Goal commitment goes
   * too: the item worth crossing the map for at 30 HP is a different
   * proposition after respawning at 100.
   */
  private _startLife(): void {
    this._life = new BotLife();
    this._itemGoalPlanner.reset();
    this._fight.startLife();
    this._mood.endFight();
    this._territory.reset();
    this._blocked.reset();
  }

  /**
   * Stand still where you are, facing the thing you came for.
   *
   * Zero direction is normally forbidden here because it persists on the server
   * for 30-80 ms and friction bleeds the bot to a stop over several ticks —
   * which is exactly what is wanted on arrival. Sprint is dropped too, so the
   * bot is under the plant speed limit rather than merely slower.
   *
   * The bot keeps looking at the objective rather than freezing its view: a
   * planted bomb is worth watching, and a fixed stare reads as a hung bot.
   */
  private _holdPosition(state: BotGameState, target: Vec3): BotInput {
    const delta = vec3Subtract(target, state.self.position);
    const distance = vec3Length(delta);
    return {
      direction: { x: 0, y: 0, z: 0 },
      pitch: 0,
      yaw: distance < 1 ? state.self.yaw : Math.atan2(delta.x, delta.z),
      buttons: 0,
      weaponSlot: 0,
    };
  }

  private _noInput(_state: BotGameState): BotInput {
    return {
      direction: { x: 0, y: 0, z: 0 },
      pitch: _state.self.pitch,
      yaw: _state.self.yaw,
      buttons: 0,
      weaponSlot: 0,
    };
  }
}
