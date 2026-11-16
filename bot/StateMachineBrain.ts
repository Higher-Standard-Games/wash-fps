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

import { DEFAULT_VIEWHEIGHT } from "../../../engine/physics/PlayerPhysicsConstants";
import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "../../../shared/server/simulation/physics/constants";
import { scaledBodyHeight } from "../shared/BodyScale";
import { isBotName } from "../shared/bot/BotNames";
import { type BotWeightProfile, selectWeightProfile } from "../shared/bot/WeightProfiles";
import type { PickupEntry } from "../shared/bsp/PickupTable";
import { wrapAngle } from "./BotAimController";
import { BotBlockedMove } from "./BotBlockedMove";
import { BotBrain, type BotInput, BotState, type BrainMatchReport, travelYaw } from "./BotBrain";
import { BotCombatMovement, findHighGround } from "./BotCombatMovement";
import {
  type BotDifficulty,
  defaultGoalArbiterMode,
  type GoalArbiterMode,
  HIT_ATTENTION_MS,
  InputButtons,
} from "./BotConfig";
import { BotCoverPeek } from "./BotCoverPeek";
import type { BotGameState, Vec3, VisiblePlayer } from "./BotGameState";
import { vec3Distance, vec3Length, vec3Normalize, vec3Subtract } from "./BotGameState";
import { BotLife } from "./BotLife";
import { BotMood, type Mood, type MoodEvent } from "./BotMood";
import { PHYSICS } from "./BotMovementProfile";
import type { BotNavGraph } from "./BotNavGraph";
import { duelLeadReactionDelay } from "./BotReactionTuning";
import { BotTerritory } from "./BotTerritory";
import type { BotVision, EnemyTrack, VisionResult } from "./BotVision";
import { BotVisionTracer, wallAheadSide } from "./BotVisionTracer";
import { BotWeaponCombos, has, slotFor } from "./BotWeaponCombos";
import { getWeaponProfile, selectBestWeapon, type WeaponProfile } from "./BotWeaponProfile";
import { type DecisionTrace, TRACED_CANDIDATES } from "./DecisionTrace";
import type { BotGoal } from "./goals/BotGoal";
import { isMajorItem } from "./goals/considerations/ItemFacts";
import { collectDirectiveGoals } from "./goals/DirectiveGoalSource";
import { ItemGoalPlanner } from "./goals/ItemGoalPlanner";
import { respawnTickOf } from "./goals/ItemGoalSource";
import { loadBaseline, payoffPriors } from "./intel/IntelBaseline";
import { loadPeopleProfile, typicalStackAfter } from "./intel/PeopleProfile";
import { inHarmfulLiquid, liquidEscapeTarget } from "./LiquidEscape";
import {
  BotNavigator,
  type NavigatorHost,
  PATH_ARRIVED_THRESHOLD,
  PATH_RECALC_INTERVAL,
} from "./navigation/BotNavigator";
import { BotTraversal, PICKUP_FAILURE_COOLDOWN_TICKS, type TraversalHost } from "./navigation/BotTraversal";
import { sideTurnAngle } from "./sequences/RouteStrafeJumpSequence";
import { canLunge } from "./sequences/SlideBladeSequence";
import { MatchRead } from "./strategy/MatchRead";
import { OpponentModel } from "./strategy/OpponentModel";
import { applyStrategyWeights, STRATEGIES, Strategist, type Strategy, type StrategyId } from "./strategy/Strategist";

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
/** A chased enemy seen this recently is watched for rather than the route ahead. */
const CHASE_WATCH_TICKS = Math.round(1.5 * TICK_RATE);
/** Furthest the view turns from where the bot runs to watch a lost enemy. */
const CHASE_WATCH_MAX_OFF_TRAVEL = (110 * Math.PI) / 180;
const PICKUP_SEEK_RANGE = 1500;
/** A bot timing an item waits this close to it, inside its pickup reach. */
const TIMED_ITEM_HOLD_RADIUS = 40;
/** How long a bot waiting at a timed item watches one way in. */
const ENTRANCE_WATCH_TICKS = 375;
/** A charged blast is let go within this of the aim (radians)… */
const CHARGE_RELEASE_CONE = (12 * Math.PI) / 180;
/** …or this many ticks after its planned release, on the aim or not. */
const CHARGE_AIM_GRACE_TICKS = Math.round(0.5 * TICK_RATE);
/** A teammate's call of enemies is worth hunting this long, ticks. */
const TEAM_SIGHTING_TICKS = 6 * TICK_RATE;
/** A blade charge is held out of a fight at most this long after it started. */
const CHARGE_CARRY_TICKS = Math.round(2 * TICK_RATE);
/** A held watch sweeps this far either side of the way in, radians, at this rate. */
const HOLD_SWEEP = 0.3;
/** A move to a point this much lower than the bot means to drop off an edge, units. */
const STEER_DROP_HEIGHT = 40;
/** Rising faster than any jump, units/s: a jump pad has thrown the bot. */
const PAD_LAUNCH_SPEED = 450;
/** A target this much higher than the bot, behind something in the way, is worth a climb. */
const CLIMB_RISE = 30;
/** Climbs are looked for toward targets at most this far off, units. */
const CLIMB_REACH = 500;
/** The way ahead counts as in the way below this much clear run. */
const CLIMB_BLOCKED = 0.7;
/** A climb or wall jump is checked at most this often, ticks: each check runs the movement forward. */
const TRICK_CHECK_TICKS = 20;
const WALL_JUMP_CHECK_TICKS = 6;
/** After a climbing jump, forward is held toward the target this long, for the ledge grab, ticks. */
const CLIMB_HOLD_TICKS = 90;
/** A wall jump is taken when it ends at least this much nearer the target than not jumping, units. */
const WALL_JUMP_GAIN = 96;
/** A wall this near the hull is one to wall jump from, units. */
const WALL_JUMP_NEAR = 12;
/** A guard picks its next patrol point once this close to the last, units. */
const GUARD_POINT_REACHED = 56;
/** Guard patrol points lie this far out from the spot, as shares of the order's radius. */
const GUARD_RINGS = [0.45, 0.85] as const;
/** Directions round the spot a guard tries for patrol points. */
const GUARD_DIRECTIONS = 10;
/** Patrol points are kept within this of a guard's radius, units, however large the order. */
const GUARD_MIN_RADIUS = 96;
const GUARD_MAX_RADIUS = 420;
/** With nowhere to walk, a guard strafes and turns the way back this often, ticks. */
const GUARD_STRAFE_TICKS = 90;
/** Eye height for a guard's check that a patrol point sees the way in. */
const GUARD_EYE = 40;
const HOLD_SWEEP_RATE = 0.9;
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
/** The slide's own cooldown plus its length, in server ticks, from the start of the last one. */
const SLIDE_COOLDOWN_TICKS = Math.ceil(((PHYSICS.SLIDE_COOLDOWN + PHYSICS.SLIDE_DURATION) / 1000) * TICK_RATE);
/** A lunge chance passed up is not rolled for again this soon. */
const LUNGE_REROLL_TICKS = 125;
/** Too hurt to dive in with a blade. */
const LUNGE_MIN_HEALTH = 30;
/** How often a bot with a splash weapon looks for a ledge to fight from. */
const HIGH_GROUND_SEARCH_TICKS = 250;
/** Cover is fought from at this range and further: closer, the fight is too quick for it. */
const COVER_MIN_RANGE = 350;

/** Fight habits a head-to-head test can turn off (`BotOptions.fightOff`). */
export type FightHabit = "cover" | "height" | "unstick" | "itemcheck" | "holster" | "steer" | "tricks";
/** A heard enemy this close gets the gun for its distance readied, held this long. */
const READY_RANGE = 1500;
const READY_TICKS = 250;
/** Out of a fight, the gun put up in place of the blade is the best one at this range. */
const HOLSTER_RANGE = 800;
/** How far off a wild shot goes, and how far an item may be to glance at. */
const WILD_SHOT_OFFSET = (5 * Math.PI) / 180;
const ITEM_GLANCE_RANGE = 1200;
/** Odds of taking a lunge chance, by dodgeSkill: never below 0.35 (Easy), 25% Medium, 60% Hard, 85% Insane. */
const LUNGE_CHANCE_POINTS: readonly (readonly [number, number])[] = [
  [0.35, 0],
  [0.4, 0.25],
  [0.7, 0.6],
  [0.9, 0.85],
];

export function lungeChance(dodgeSkill: number): number {
  const points = LUNGE_CHANCE_POINTS;
  if (dodgeSkill < points[0][0]) return 0;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (dodgeSkill <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (dodgeSkill - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}
const HUNT_DIRECTION_CHANGE_INTERVAL = 180; // Change hunt direction every ~3 sec at 60Hz

const MELEE_RANGE = 150;
const CLOSE_RANGE = 400;

// Feeler ray constants
const FEELER_FORWARD_DIST = 300; // Forward ray distance
const FEELER_SIDE_DIST = 200; // Side ray distance
const FEELER_SIDE_ANGLE = Math.PI / 6; // 30° offset for side rays
const FEELER_STEER_THRESHOLD = 0.6; // fraction below which we steer away
/** A wall ahead keeps the bot turning the side it chose for this long. */
const FEELER_SIDE_COMMIT_TICKS = 50;

// Fading and escaping (see _shouldFade, _escapePoint)
/** Damage taken in a fight that makes a fading strategy leave it. */
const FADE_DAMAGE = 40;
/** An escape point lies this far away, units. */
const ESCAPE_MIN = 192;
const ESCAPE_MAX = 900;
/** ... and no more toward the threat than this (cosine). */
const ESCAPE_MAX_TOWARD = 0.2;
/** Reached when this close, units; given up after ESCAPE_HOLD_TICKS. */
const ESCAPE_REACHED = 64;
const ESCAPE_HOLD_TICKS = 375;
/** Nearest candidate nodes checked for sight and route cost. */
const ESCAPE_CANDIDATES = 24;
/** With no way out found, look again after this long. */
const ESCAPE_RETRY_TICKS = 60;

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

// Looking round while running (out of a fight)
/** Calm, the view rests this far below where the brain looks: people look at the floor ahead. */
const CALM_PITCH = (10 * Math.PI) / 180;
/** Calm, the view never looks further down than this. */
const CALM_MAX_PITCH = (45 * Math.PI) / 180;
/** Furthest the view turns from where the bot runs to look into open space. */
const LOOK_MAX_OFF_TRAVEL = (45 * Math.PI) / 180;
const LOOK_STEP = (15 * Math.PI) / 180;
/** Sight lines are scored out to this far, units. */
const LOOK_RANGE = 1500;
/** What looking the full LOOK_MAX_OFF_TRAVEL aside costs, of a score out of 1. */
const LOOK_OFF_COST = 0.3;
/** With nothing worth a glance, how soon to look for one again, ticks. */
const LOOK_INTERVAL_TICKS = 50;
/** How long a glance holds, ticks (±30%). */
const GLANCE_TICKS = 85;
/** Rest between glances, ticks (from 0.67 to 1.33 of it). */
const GLANCE_REST_TICKS = 375;
/** How much more open another direction must be to take over. */
const LOOK_SWITCH_MARGIN = 0.2;
/** What turning the view a quarter turn from where it is costs, of a score out of 1. */
const LOOK_TURN_COST = 0.3;
/** A major item's spot unseen this long is worth a look in passing, ticks. */
const SPOT_STALE_TICKS = 8 * TICK_RATE;
/** Spots are looked at from this far to as far as perception tells them apart (BotPerception). */
const SPOT_MIN_DISTANCE = 200;
const SPOT_MAX_DISTANCE = 2000;

/** A route that ends further than this from its item has not reached it. */
const UNREACHED_ITEM_DISTANCE = 64;
/** Beside an item, horizontally, for longer than ITEM_CIRCLE_TICKS without taking it: it is out of reach. */
const ITEM_CIRCLE_RADIUS = 64;
const ITEM_CIRCLE_TICKS = 125;
/** A bot that needs an item chases a heard enemy only this close: round the next corner. */
const SOUND_DIVERT_DISTANCE = 384;

/** Rays this far up count too, so stairs ahead are not a wall. */
const LOOK_UP_PITCH = (10 * Math.PI) / 180;

/** How open the view is toward `yaw` from `eye`: 1 when nothing is within LOOK_RANGE. */
function openFraction(vision: BotVision, eye: Vec3, yaw: number): number {
  let best = 0;
  for (const pitch of [0, LOOK_UP_PITCH]) {
    const reach = LOOK_RANGE * Math.cos(pitch);
    const end = {
      x: eye.x + Math.sin(yaw) * reach,
      y: eye.y + LOOK_RANGE * Math.sin(pitch),
      z: eye.z + Math.cos(yaw) * reach,
    };
    best = Math.max(best, vision.collisionWorld.trace(eye, end).fraction);
  }
  return best;
}

/** An item goal, and an item worth taking on the way to it. */
interface ItemGoalChoice {
  goal: BotGoal;
  stopover: BotGoal | null;
  /** The arbiter's score for `goal` (GoalArbiter: gate × attraction × discount). */
  desire: number;
}

/** RETREAT wants healing, not shopping — see ItemGoalPlannerOptions.typeFilter. */
const RETREAT_ITEM_TYPES: ReadonlySet<string> = new Set(["health"]);

export class StateMachineBrain extends BotBrain {
  // ── Internal state ────────────────────────────────────────────────
  /** This life's route, goals and plans; a new one at each death (BotLife). */
  private _life = new BotLife();
  /** Route following (navigation/BotNavigator). */
  private readonly _nav = new BotNavigator(this._navigatorHost());
  /** Traversal sequences and the route's slides and hops (navigation/BotTraversal). */
  private readonly _traversal = new BotTraversal(this._traversalHost());
  private _huntYaw: number = 0;
  private _huntTimer: number = 0;

  // Slide-blade lunge: when this bot last slid, and when it may roll for a lunge again
  private _lastSlideTick = Number.NEGATIVE_INFINITY;
  private _lungeRollAfterTick = 0;
  private readonly _combatMovement = new BotCombatMovement();
  private readonly _coverPeek: BotCoverPeek;
  /** When the bot last fired the weapon out, for peeking between shots. */
  private _firedTick = Number.NEGATIVE_INFINITY;
  /** Fight habits turned off for head-to-head tests (`BotOptions.fightOff`). */
  private _fightOff: ReadonlySet<FightHabit> = new Set();
  private readonly _weaponCombos = new BotWeaponCombos();
  private readonly _mood = new BotMood();
  /** Kills and deaths since the last `takeMoodEvents`, for chat. */
  private _moodEvents: MoodEvent[] = [];
  private _readyRollTick = 0;
  private _highGroundSearchTick = 0;

  // Movement variety
  private _strafeDirection: number = 1; // 1 or -1
  /** Whether the feelers turned this decision's heading. */
  private _feelerSteered = false;
  /** This decision's move is an exact line (a sequence, a trick's approach): not steered. */
  private _exactMove = false;
  /** Keeps the feet clear of walls in every state (BotVisionTracer), made per collision world. */
  private _tracer: BotVisionTracer | null = null;
  private _tracerWorld: unknown = null;
  /** The point this decision's movement makes for, when it has one: the tracer looks no further. */
  private _steerTarget: Vec3 | null = null;
  /** How clear the way ahead ran on the last steer, 0..1. */
  private _steerClear = 1;
  /** Next tick a climb or wall jump may be checked for; a climb under way holds forward to its target. */
  private _trickCheckTick = 0;
  /** A wall jump wants a fresh press: jump let go this decision, pressed on the next. */
  private _wallJumpPress = false;
  private _lastJumpHeld = false;
  /** When a look at each major item's spot was last begun, by pickup id. */
  private readonly _spotLooks = new Map<number, number>();
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
  private _escapeRetryTick = 0;
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
  private _lookAroundTimer: number = 0;
  private _lookAroundYaw: number = 0;

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
    this._coverPeek = new BotCoverPeek(difficulty.dodgeSkill);
    this._strategist = new Strategist(difficulty.matchSense ?? 0.5);
    // mistakeRate finally does something: an occasional runner-up pick.
    this._itemGoalPlanner = new ItemGoalPlanner(difficulty.mistakeRate);
    this._huntYaw = Math.random() * Math.PI * 2;
  }

  // ── Main Decision Loop ────────────────────────────────────────────

  // Store last vision result for use across state methods
  private _lastVision: VisionResult | null = null;
  private _lastBotVision: BotVision | null = null;
  private _suppressTraversalAutomation: boolean = false;
  override steeredOffWall(): boolean {
    return this._feelerSteered;
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
    const input = this._escapeLiquid(
      state,
      this._turnFromBlock(state, this._decide(state, vision, visionResult, navGraph)),
    );
    this._carryCharge(state, input);
    if (this._tracing) this._lastTrace = this._trace(state);
    if (this._isCalm(state, input)) {
      input.calm = true;
      // People look a little down while running, at the floor ahead (BS-1: 11°).
      input.pitch = Math.min(CALM_MAX_PITCH, input.pitch + CALM_PITCH);
    }
    return this._cancelScript ? { ...input, cancelScript: true } : input;
  }

  /** Roaming with no enemy in sight and no scripted move: see `BotInput.calm`. */
  private _isCalm(state: BotGameState, input: BotInput): boolean {
    if (state.self.isDead || input.script || this._traversal.runtime.isActive) return false;
    if ((input.buttons & (InputButtons.FIRE | InputButtons.ALT_FIRE)) !== 0) return false;
    if ((this._lastVision?.visibleEnemies.length ?? 0) > 0) return false;
    // A chase with the enemy out of sight turns toward where they were: a memory, not a sight.
    return (
      this.currentState === BotState.ITEM_RUN ||
      this.currentState === BotState.HUNT ||
      this.currentState === BotState.CHASE ||
      this.currentState === BotState.RETREAT ||
      this.currentState === BotState.IDLE
    );
  }

  private _decide(
    state: BotGameState,
    vision?: BotVision | null,
    visionResult?: VisionResult | null,
    navGraph?: BotNavGraph | null,
  ): BotInput {
    this._nav.pathRecalcTimer++;
    this._feelerSteered = false;
    this._nav.onRouteLine = false;
    this._steerTarget = null;
    this._steerClear = 1;
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
    this._suppressTraversalAutomation = false;
    this._exactMove = false;
    if (state.self.isDead) {
      this.currentState = BotState.SPAWN;
      this._traversal.interrupt(state, "dead", true);
      this._startLife();
      // Clear vision cache on death
      if (vision) vision.clearCache();
      return this._noInput(state);
    }

    const mandatory = this._selectMandatoryGoal(state);
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
            ? this._steer(sequenceInput, state, vision)
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
        input = this._executeFight(state);
        break;
      case BotState.CHASE:
        input = this._executeChase(state);
        break;
      case BotState.DODGE:
        input = this._executeDodge(state);
        break;
      case BotState.RETREAT:
        input = this._executeRetreat(state);
        break;
      case BotState.ITEM_RUN:
        input = this._executeItemRun(state);
        break;
      case BotState.HUNT:
        input = this._executeHunt(state);
        break;
      default:
        input = this._executeHunt(state);
        break;
    }

    input = this._nav.recoverStalledNavigation(state, input);

    // Keep the feet clear of walls, corners and ledges in every state. Not on
    // a verified approach to a trick, whose line is exact on purpose.
    if (vision && !this._exactMove) {
      if (!this._fightOff.has("steer")) input = this._steer(input, state, vision);
      else if (!this._nav.onRouteLine && this.currentState !== BotState.FIGHT && this.currentState !== BotState.DODGE) {
        // The feelers, for head-to-head tests: navigation only, and not on a
        // route line, where they saw a wall beyond a corner and turned off it.
        input = this._applyFeelers(input, state, vision);
      }
    }

    const chase = this.currentState === BotState.CHASE ? this._lastVision?.chaseTarget : null;
    if (chase && state.self.health >= 50)
      input = this._keepUpperGround(state, { position: chase.lastSeenPosition }, input);
    if (
      this.currentState === BotState.FIGHT ||
      this.currentState === BotState.CHASE ||
      this.currentState === BotState.DODGE
    ) {
      input = this._applyLeash(state, input);
    }

    if (this.currentState !== BotState.FIGHT && this.currentState !== BotState.DODGE) {
      this._readyForHeard(state, input);
    }

    if (!this._suppressTraversalAutomation) {
      const ledgeJump = this._traversal.tryStartLedgeSlideJump(input, state);
      if (ledgeJump) return ledgeJump;
      const itemSlideInput = this._traversal.tryStartItemSlideApproach(input, state);
      if (itemSlideInput) return itemSlideInput;
      const routeSlideInput = this._traversal.tryStartRouteCrouchslide(input, state);
      if (routeSlideInput) return routeSlideInput;
      const strafeInput = this._traversal.tryStartRouteStrafeJump(input, state);
      if (strafeInput) return strafeInput;
    }

    if (vision && !this._exactMove && !this._fightOff.has("steer") && !this._fightOff.has("tricks")) {
      input = this._tryTricks(state, input);
    }
    this._lastJumpHeld = (input.buttons & InputButtons.JUMP) !== 0;

    if (vision) this._lookIntoOpenSpace(state, input, vision);
    return input;
  }

  /**
   * Running out of a fight, glance now and then toward the most open
   * direction near where it looks: a sight line down a hall rather than the
   * wall a route corner points at. Between glances the view rests where the
   * bot runs, as a player's does: recorded people have the view more than 20°
   * off their movement 38% of the time running, and bots that held the most
   * open direction all the time 55% (docs/research/BOT_STRATEGY_LAYER.md).
   * A glance lasts GLANCE_TICKS and comes every GLANCE_REST_TICKS or so, when
   * a direction is clearly more open than straight ahead. Movement keeps its
   * heading; the view stays within a quarter turn of it.
   */
  private _lookIntoOpenSpace(state: BotGameState, input: BotInput, vision: BotVision): void {
    const roaming =
      this.currentState === BotState.HUNT ||
      this.currentState === BotState.ITEM_RUN ||
      this.currentState === BotState.RETREAT;
    if (!roaming) {
      this._life.look = null;
      return;
    }
    // Not while firing or standing, nor in a scripted move; a hop or slide keeps the look.
    const running =
      (input.buttons & InputButtons.FORWARD) !== 0 &&
      (input.buttons & (InputButtons.FIRE | InputButtons.ALT_FIRE)) === 0 &&
      input.direction.x === 0 &&
      input.direction.z > 0;
    if (!running || this._traversal.runtime.isActive) return;
    const travel = travelYaw(input);
    const base = input.yaw;
    const allowed = (off: number) => Math.abs(wrapAngle(base + off - travel)) <= Math.PI / 2;
    const spot = this._life.look?.spot;
    if (this._life.look && spot) {
      // A look at an item's spot follows it, and ends once perception has seen it.
      this._life.look.off = wrapAngle(bearingTo(state.self.position, spot.position) - base);
      if ((state.itemSpotSeenTick.get(spot.pickupId) ?? -1) >= spot.sinceTick) this._life.look.untilTick = state.tick;
    }
    if (!this._life.look || this._life.look.off === 0) {
      const check = this._fightOff.has("itemcheck") ? null : this._spotToCheck(state, base, allowed, vision);
      if (check) {
        this._spotLooks.set(check.pickupId, state.tick);
        this._life.look = {
          off: wrapAngle(bearingTo(state.self.position, check.position) - base),
          untilTick: state.tick + GLANCE_TICKS,
          spot: { ...check, sinceTick: state.tick },
        };
      }
    }
    if (
      this._life.look &&
      this._life.look.off !== 0 &&
      (state.tick >= this._life.look.untilTick || !allowed(this._life.look.off))
    ) {
      // A glance ends: back to where the bot runs, for a rest of 2–4 s.
      this._life.look = { off: 0, untilTick: state.tick + GLANCE_REST_TICKS * (0.67 + 0.67 * Math.random()) };
    }
    if (!this._life.look || state.tick >= this._life.look.untilTick) {
      const eye = { x: state.self.position.x, y: state.self.position.y + 36, z: state.self.position.z };
      // Turning from where the view is costs too: a route corner moves the
      // way the bot runs, and choosing afresh from it swung the view across.
      const score = (off: number) => {
        const yaw = base + off;
        return (
          openFraction(vision, eye, yaw) -
          (LOOK_OFF_COST * Math.abs(off)) / LOOK_MAX_OFF_TRAVEL -
          (LOOK_TURN_COST * Math.abs(wrapAngle(yaw - state.self.yaw))) / (Math.PI / 2)
        );
      };
      let bestOff = 0;
      let bestScore = score(0) + LOOK_SWITCH_MARGIN;
      for (let off = -LOOK_MAX_OFF_TRAVEL; off <= LOOK_MAX_OFF_TRAVEL + 1e-9; off += LOOK_STEP) {
        if (Math.abs(off) < 1e-9 || !allowed(off)) continue;
        const value = score(off);
        if (value > bestScore) {
          bestScore = value;
          bestOff = off;
        }
      }
      // Nothing worth a glance: look again in a moment.
      this._life.look = {
        off: bestOff,
        untilTick: state.tick + (bestOff === 0 ? LOOK_INTERVAL_TICKS : GLANCE_TICKS * (0.7 + 0.6 * Math.random())),
      };
    }
    input.moveYaw = travel;
    input.yaw = base + this._life.look.off;
  }

  /**
   * A major item's spot to look at in passing, as a player checks the Red
   * Armor: one not seen for SPOT_STALE_TICKS, in sight from here and within a
   * quarter turn of where the bot runs, the longest unseen first. Seeing it
   * there or gone is what dates its next return.
   */
  private _spotToCheck(
    state: BotGameState,
    base: number,
    allowed: (off: number) => boolean,
    vision: BotVision,
  ): { pickupId: number; position: Vec3 } | null {
    const self = state.self.position;
    let best: { pickupId: number; position: Vec3 } | null = null;
    let bestSeen = Number.POSITIVE_INFINITY;
    // A vision with no map knowledge (a stand-in) has no spots to look at.
    for (const entry of vision.mapKnowledge?.pickupPositions ?? []) {
      if (!isMajorItem(entry.type, entry.kind)) continue;
      const seen = state.itemSpotSeenTick.get(entry.id) ?? Number.NEGATIVE_INFINITY;
      if (state.tick - seen < SPOT_STALE_TICKS || seen >= bestSeen) continue;
      if (state.tick - (this._spotLooks.get(entry.id) ?? Number.NEGATIVE_INFINITY) < SPOT_STALE_TICKS) continue;
      const distance = vec3Distance(self, entry.position);
      if (distance < SPOT_MIN_DISTANCE || distance > SPOT_MAX_DISTANCE) continue;
      if (!allowed(wrapAngle(bearingTo(self, entry.position) - base))) continue;
      const lift = { x: entry.position.x, y: entry.position.y - 24, z: entry.position.z };
      if (!vision.canSeeFrom(self, lift)) continue;
      best = { pickupId: entry.id, position: entry.position };
      bestSeen = seen;
    }
    return best;
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
    if (this.currentState === BotState.FIGHT && this._coverPeek.holding(state.tick)) return BotState.FIGHT;

    // Priority 2.5: Lost sight of enemy but tracking them → chase!
    // ...unless this fight's mistake is to forget them the moment they are gone.
    // A distant sound does not pull a bot off an item it needs: the track
    // fades in about a second, and the bot would turn back to the item. Once
    // chasing, it keeps chasing; distance alone would flip it in and out as
    // the gap crosses the limit.
    const chaseTarget = this._lastVision?.chaseTarget;
    // A strategy that wants no fight lets an enemy out of sight go.
    const leash = this._leashOrder(state);
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

  /**
   * Maybe lunge at `enemy` with a crouch-slide and the blade. Each chance is
   * rolled once (then not again for a second), at odds from dodgeSkill: never
   * on Easy, most of the time on Insane. The slide's own cooldown is kept here,
   * from when this bot last stopped sliding.
   */
  private _tryStartSlideBlade(state: BotGameState, enemy: VisiblePlayer): BotInput | null {
    if (state.self.isSliding) this._lastSlideTick = state.tick;
    if (this._traversal.runtime.isActive || state.tick < this._lungeRollAfterTick) return null;
    if (state.tick - this._lastSlideTick < SLIDE_COOLDOWN_TICKS) return null;
    if (state.self.health < LUNGE_MIN_HEALTH) return null;
    const context = { ...this._traversal.context(state, null), combatTarget: enemy };
    if (!canLunge(context, enemy)) return null;
    this._lungeRollAfterTick = state.tick + LUNGE_REROLL_TICKS;
    if (Math.random() >= lungeChance(this.difficulty.dodgeSkill)) return null;
    if (!this._traversal.runtime.start("combat_slide_blade", context)) return null;
    return this._traversal.tick(state);
  }

  private _executeFight(state: BotGameState): BotInput {
    // Find strongest enemy (from vision or fallback)
    const enemy = this._lastVision?.visibleEnemies[0]?.player ?? state.getNearestEnemy();
    if (!enemy) {
      return this._executeHunt(state);
    }

    const lunge = this._tryStartSlideBlade(state, enemy);
    if (lunge) return lunge;

    // Select best weapon for distance (profile-based). The server switches before
    // firing, so combat behavior can use the selected profile immediately.
    let { slot: weaponSlot, profile: selectedProfile } = selectBestWeapon(
      state.self.weapons,
      state.self.ammo,
      state.self.currentWeapon,
      enemy.distance,
    );
    let selectedWeaponId = weaponSlot > 0 ? state.self.weapons[weaponSlot - 1] : state.self.currentWeapon;
    let currentProfile = selectedProfile.id === "unknown" ? getWeaponProfile(selectedWeaponId) : selectedProfile;

    const mistake = this._mood.mistake(state.tick);
    if (mistake === "wrong_weapon" && state.self.currentWeapon) {
      // Fights on with whatever was out
      weaponSlot = 0;
      selectedWeaponId = state.self.currentWeapon;
      currentProfile = getWeaponProfile(selectedWeaponId);
    }

    // A combo (rocket into rail, riotgun or blade; a rail between plasma) overrides the distance pick
    const combo =
      mistake === "wrong_weapon"
        ? null
        : this._weaponCombos.choose(
            state,
            enemy,
            this.difficulty.predictionSkill,
            selectedWeaponId,
            this._enemyEstimate(enemy.entityId),
          );
    if (combo) {
      weaponSlot = slotFor(state, combo);
      selectedWeaponId = combo;
      currentProfile = getWeaponProfile(combo);
    }

    // Aim at enemy - use projectile prediction if needed.
    const useProjectileAim =
      (currentProfile.isProjectile || currentProfile.hasChargedProjectile) && currentProfile.projectileSpeed > 0;
    let aim = useProjectileAim
      ? this._aimAtTargetWithLead(state, enemy, currentProfile)
      : this._aimAtTarget(state, enemy);

    // Strafe while fighting: rhythm, dodges and hops from BotCombatMovement
    const moves = this._combatMovement.step(state, this.aimDifficulty, enemy.distance);
    let strafeInput = moves.strafe;
    // At range, from the edge of cover: out to shoot, back while reloading.
    const enemyInSight = this._lastVision
      ? this._lastVision.visibleEnemies.some((e) => e.player.playerId === enemy.playerId)
      : true;
    const peek = this._peekFromCover(state, enemy, currentProfile, selectedWeaponId, aim.yaw, enemyInSight);
    if (peek !== null && !this._combatMovement.dodging(state.tick)) strafeInput = peek;
    const peeking = peek !== null;
    if (strafeInput !== 0) this._strafeDirection = strafeInput;

    // Build buttons
    let buttons = 0;
    // Out of sight in cover there is nothing to shoot at, and a rocket into the wall hits the bot.
    let wantsFire = this._hasAmmoForWeapon(state, selectedWeaponId) && (enemyInSight || !peeking);

    if (mistake === "wild_shot") {
      // Fires before the aim is on: a few degrees off to one side
      const side = this._mood.mistakeTick % 2 === 0 ? 1 : -1;
      aim = { ...aim, yaw: aim.yaw + side * WILD_SHOT_OFFSET };
    } else if (mistake === "item_glance") {
      const item = state.getNearestPickup(ITEM_GLANCE_RANGE);
      if (item) {
        const dx = item.position.x - state.self.position.x;
        const dz = item.position.z - state.self.position.z;
        aim = { yaw: Math.atan2(dx, dz), pitch: 0 };
        wantsFire = false;
      }
    }

    // Weapon-aware combat behavior
    if (currentProfile.isMelee) {
      const chargeFire = this._updateChargedProjectileFire(
        state,
        enemy,
        selectedWeaponId,
        currentProfile,
        aim,
        wantsFire,
      );

      if (chargeFire.holdAltFire) {
        buttons |= InputButtons.ALT_FIRE;
      }

      // Close range: swing. Mid range: keep pressure while charging/releasing the blade blast.
      if (enemy.distance < MELEE_RANGE && wantsFire && !chargeFire.holdAltFire) {
        buttons |= InputButtons.FIRE;
      }

      buttons |= InputButtons.FORWARD;
      buttons |= InputButtons.SPRINT;
    } else {
      this._clearChargedProjectileFire();

      // ADS whenever it tightens the shot; firing walks anyway, so aiming costs no speed.
      // A weapon whose aim takes time to settle holds fire until the server
      // counts the shot as aimed, which starts once that weapon is up.
      // Only with that weapon up: alt-fire pressed while the blade is still
      // out, mid-switch, starts a blade charge the switch then cancels.
      const aimsDownSights =
        currentProfile.aimsDownSights && wantsFire && state.self.currentWeapon === selectedWeaponId;
      if (aimsDownSights) buttons |= InputButtons.ALT_FIRE;
      if (!aimsDownSights || state.self.currentWeapon !== selectedWeaponId) this._life.adsSinceTick = null;
      else this._life.adsSinceTick ??= state.tick;
      const aimReady =
        currentProfile.adsReadyTicks === 0 ||
        (this._life.adsSinceTick !== null && state.tick - this._life.adsSinceTick >= currentProfile.adsReadyTicks);

      // Fire
      if (wantsFire && aimReady) {
        buttons |= InputButtons.FIRE;
      }

      // Movement based on range
      if (enemy.distance > CLOSE_RANGE) {
        buttons |= InputButtons.FORWARD; // Close distance
      } else if (enemy.distance < MELEE_RANGE) {
        buttons |= InputButtons.BACK; // Too close for ranged, back up
      }

      // Back up from splash weapons at close range (avoid self-damage)
      if (currentProfile.hasSplash && enemy.distance < 250) {
        buttons |= InputButtons.BACK;
        buttons &= ~InputButtons.FORWARD;
      }
    }

    // Always sprint - arena FPS players strafe-run by default
    buttons |= InputButtons.SPRINT;

    if (strafeInput > 0) buttons |= InputButtons.RIGHT;
    else if (strafeInput < 0) buttons |= InputButtons.LEFT;
    if (moves.jump) buttons |= InputButtons.JUMP;
    if (moves.crouch) buttons |= InputButtons.CROUCH;

    if (wantsFire && (buttons & InputButtons.FIRE) !== 0 && state.self.currentWeapon === selectedWeaponId) {
      if (state.tick - this._firedTick >= currentProfile.fireIntervalTicks) this._firedTick = state.tick;
    }
    // Using cover, the bot keeps its distance: walking in leaves the cover behind.
    if (peeking) buttons &= ~(InputButtons.FORWARD | InputButtons.BACK);

    // Movement direction
    let forwardZ = 0;
    if (currentProfile.isMelee) {
      forwardZ = 1; // Always rush forward with melee
    } else if (enemy.distance > CLOSE_RANGE) {
      forwardZ = 1;
    } else if (enemy.distance < MELEE_RANGE || (currentProfile.hasSplash && enemy.distance < 250)) {
      forwardZ = -1;
    }
    if (peeking) forwardZ = 0;
    let strafeX = peeking ? strafeInput : strafeInput * 0.5;

    // With a splash weapon, take a ledge above the enemy when one is close
    const ledge = currentProfile.hasSplash && !peeking ? this._highGround(state, enemy) : null;
    if (ledge) {
      const towardYaw = Math.atan2(ledge.x - state.self.position.x, ledge.z - state.self.position.z);
      const off = towardYaw - aim.yaw;
      forwardZ = Math.cos(off);
      strafeX = Math.sin(off);
      buttons &= ~(InputButtons.FORWARD | InputButtons.BACK);
      buttons |= forwardZ >= 0 ? InputButtons.FORWARD : InputButtons.BACK;
    }

    return this._keepUpperGround(state, enemy, {
      direction: { x: strafeX, y: 0, z: forwardZ },
      pitch: aim.pitch,
      yaw: aim.yaw,
      buttons,
      weaponSlot,
    });
  }

  private _keepUpperGround(state: BotGameState, enemy: Pick<VisiblePlayer, "position">, input: BotInput): BotInput {
    const vision = this._lastBotVision;
    const self = state.self.position;
    if (
      !vision ||
      !state.self.isGrounded ||
      (this._fightOff.has("height") && state.matchState.gametypeName.toLowerCase() !== "duel") ||
      self.y - enemy.position.y < 64
    )
      return input;
    const heading = travelYaw(input) + Math.atan2(input.direction.x, input.direction.z);
    for (const turn of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const yaw = heading + turn;
      const target = { x: self.x + Math.sin(yaw) * 96, y: self.y, z: self.z + Math.cos(yaw) * 96 };
      if (!vision.isWalkable(self, target)) continue;
      const floor = vision.collisionWorld.trace(target, { ...target, y: target.y - 64 });
      if (!floor.hit || floor.fraction >= 1) continue;
      if (turn === 0) return input;
      input.moveYaw = yaw;
      input.direction = { x: 0, y: 0, z: 1 };
      input.buttons &= ~(InputButtons.LEFT | InputButtons.RIGHT | InputButtons.BACK);
      input.buttons |= InputButtons.FORWARD | InputButtons.SPRINT;
      return input;
    }
    return input;
  }

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

  /**
   * The strafe that fights from cover at range (BotCoverPeek), or null to
   * fight in the open: close in, with the blade, or with the habit off.
   */
  private _peekFromCover(
    state: BotGameState,
    enemy: VisiblePlayer,
    profile: WeaponProfile,
    weaponId: string,
    yaw: number,
    inSight: boolean,
  ): -1 | 0 | 1 | null {
    const vision = this._lastBotVision;
    if (
      !vision ||
      this._fightOff.has("cover") ||
      profile.isMelee ||
      enemy.distance < COVER_MIN_RANGE ||
      !state.self.isGrounded ||
      state.self.currentWeapon !== weaponId
    ) {
      this._coverPeek.reset();
      return null;
    }
    const self = state.self.position;
    const enemyEye = { x: enemy.position.x, y: enemy.position.y + DEFAULT_VIEWHEIGHT, z: enemy.position.z };
    return this._coverPeek.step({
      tick: state.tick,
      self,
      yaw,
      hidden: (at) => !vision.canSee({ x: at.x, y: at.y + DEFAULT_VIEWHEIGHT, z: at.z }, enemyEye),
      walkable: (to) => vision.isWalkable(self, to),
      refireTicks: profile.fireIntervalTicks,
      firedTick: this._firedTick,
      visible: inSight,
    });
  }

  /**
   * A ledge to fight from, looked for every two seconds while the bot has a
   * splash weapon and is not yet above the enemy. Dropped once reached.
   */
  private _highGround(state: BotGameState, enemy: VisiblePlayer): Vec3 | null {
    const self = state.self.position;
    if (
      this._life.highGroundSpot &&
      Math.hypot(this._life.highGroundSpot.x - self.x, this._life.highGroundSpot.z - self.z) < 48
    ) {
      this._life.highGroundSpot = null;
    }
    if (state.tick >= this._highGroundSearchTick) {
      this._highGroundSearchTick = state.tick + HIGH_GROUND_SEARCH_TICKS;
      const vision = this._lastBotVision;
      this._life.highGroundSpot =
        vision && this._navGraph && enemy.distance <= 900 && Math.random() < this.difficulty.dodgeSkill
          ? findHighGround(this._navGraph.nodes, self, enemy.position, (from, to) => vision.canSee(from, to))
          : null;
    }
    return this._life.highGroundSpot;
  }

  /**
   * Out of a fight, with an enemy heard close but not seen, get out the gun for
   * the distance they were heard at, so it is ready when they come round the
   * corner. Rolled every two seconds at `predictionSkill` odds.
   */
  private _readyForHeard(state: BotGameState, input: BotInput): void {
    if (
      this._life.readyWeapon &&
      (state.tick >= this._life.readyWeapon.until || !has(state, this._life.readyWeapon.weapon))
    ) {
      this._life.readyWeapon = null;
    }
    const heard = state.heardEnemies.reduce<VisiblePlayer | null>(
      (near, enemy) => (!near || enemy.distance < near.distance ? enemy : near),
      null,
    );
    if (!this._life.readyWeapon && heard && heard.distance <= READY_RANGE && state.tick >= this._readyRollTick) {
      this._readyRollTick = state.tick + READY_TICKS;
      if (Math.random() < this.difficulty.predictionSkill) {
        const { slot } = selectBestWeapon(
          state.self.weapons,
          state.self.ammo,
          state.self.currentWeapon,
          heard.distance,
        );
        const weapon = slot > 0 ? state.self.weapons[slot - 1] : state.self.currentWeapon;
        if (weapon) this._life.readyWeapon = { weapon, until: state.tick + READY_TICKS };
      }
    }
    if (this._life.readyWeapon && (input.weaponSlot ?? 0) === 0)
      input.weaponSlot = slotFor(state, this._life.readyWeapon.weapon);
    // Out of a fight, the blade goes away for a gun: whoever comes round the
    // next corner is more likely at mid range than in reach of a swing.
    if (
      (input.weaponSlot ?? 0) === 0 &&
      state.self.currentWeapon === "blade" &&
      this._life.chargeStartTick === null &&
      !this._fightOff.has("holster")
    ) {
      const { slot } = selectBestWeapon(state.self.weapons, state.self.ammo, state.self.currentWeapon, HOLSTER_RANGE);
      const weapon = slot > 0 ? state.self.weapons[slot - 1] : undefined;
      if (weapon && weapon !== "blade") input.weaponSlot = slot;
    }
  }

  private _hasAmmoForWeapon(state: BotGameState, weaponId: string): boolean {
    if (!weaponId) return true;
    const ammo = state.self.ammo[weaponId];
    return ammo === undefined || ammo > 0;
  }

  private _updateChargedProjectileFire(
    state: BotGameState,
    enemy: VisiblePlayer,
    weaponId: string,
    profile: WeaponProfile,
    aim: { yaw: number; pitch: number },
    wantsFire: boolean,
  ): { holdAltFire: boolean } {
    if (!profile.hasChargedProjectile || !weaponId || enemy.distance < MELEE_RANGE) {
      this._clearChargedProjectileFire();
      return { holdAltFire: false };
    }

    // If we are switching to this weapon, let the server confirm the switch before
    // starting charge state. This keeps the cached 125Hz input loop from charging
    // an old weapon for one snapshot interval.
    if (state.self.currentWeapon && weaponId !== state.self.currentWeapon) {
      this._clearChargedProjectileFire();
      return { holdAltFire: false };
    }

    const targetChanged = this._life.chargeTargetId !== enemy.playerId;
    const weaponChanged = this._life.chargeWeaponId !== weaponId;
    if (
      targetChanged ||
      weaponChanged ||
      this._life.chargeStartTick === null ||
      this._life.chargeReleaseTick === null
    ) {
      // A charge starts only when the bot means to fire; once started it is
      // held through a moment's hesitation, because letting go before the
      // minimum cancels it on the server.
      if (!wantsFire) {
        this._clearChargedProjectileFire();
        return { holdAltFire: false };
      }
      this._life.chargeWeaponId = weaponId;
      this._life.chargeTargetId = enemy.playerId;
      this._life.chargeStartTick = state.tick;

      const chargeSpan = Math.max(0, profile.chargeMaxTicks - profile.chargeMinTicks);
      const skillHold = 0.35 + this.difficulty.predictionSkill * 0.4;
      const jitter = (Math.random() - 0.5) * 0.15;
      const holdTicks = Math.round(profile.chargeMinTicks + chargeSpan * Math.max(0, Math.min(1, skillHold + jitter)));
      this._life.chargeReleaseTick = state.tick + Math.max(profile.chargeMinTicks, holdTicks);
      return { holdAltFire: true };
    }

    // Release on the aim: a blast let go while the view is still turning
    // misses. The charge stops growing at its maximum, so waiting costs only
    // time, and after CHARGE_AIM_GRACE_TICKS it goes anyway.
    const off = Math.max(Math.abs(wrapAngle(aim.yaw - state.self.yaw)), Math.abs(aim.pitch - state.self.pitch));
    const onAim = off <= CHARGE_RELEASE_CONE;
    if (
      state.tick >= this._life.chargeReleaseTick &&
      (onAim || state.tick >= this._life.chargeReleaseTick + CHARGE_AIM_GRACE_TICKS)
    ) {
      this._clearChargedProjectileFire();
      return { holdAltFire: false };
    }

    return { holdAltFire: true };
  }

  /**
   * A blade charge outlives the fight decision that started it: the enemy
   * steps out of sight, or a hit sends the bot dodging, and a player keeps
   * holding to let go when they are back. Carried up to CHARGE_CARRY_TICKS
   * with the charging weapon still out; any decision that lets go of
   * alt-fire otherwise ends the charge, on the server and here.
   */
  private _carryCharge(state: BotGameState, input: BotInput): void {
    if ((input.buttons & InputButtons.ALT_FIRE) !== 0 || this._life.chargeStartTick === null) return;
    const carried =
      !state.self.isDead &&
      this.currentState !== BotState.FIGHT &&
      state.self.currentWeapon === this._life.chargeWeaponId &&
      !input.script &&
      (input.weaponSlot ?? 0) === 0 &&
      state.tick - this._life.chargeStartTick < CHARGE_CARRY_TICKS;
    if (carried) input.buttons |= InputButtons.ALT_FIRE;
    else this._clearChargedProjectileFire();
  }

  private _clearChargedProjectileFire(): void {
    this._life.chargeWeaponId = null;
    this._life.chargeTargetId = null;
    this._life.chargeStartTick = null;
    this._life.chargeReleaseTick = null;
  }
  // ── DODGE State ───────────────────────────────────────────────────

  private _executeDodge(state: BotGameState): BotInput {
    // Sidestep threats; jump or slide only when the combat controller requests it.
    const enemyDistance = state.getNearestEnemy()?.distance ?? 0;
    const moves = this._combatMovement.step(state, this.aimDifficulty, enemyDistance);
    const side = moves.strafe;
    if (side !== 0) this._strafeDirection = side;

    let buttons = InputButtons.SPRINT;
    if (moves.jump) buttons |= InputButtons.JUMP;
    if (moves.crouch) buttons |= InputButtons.CROUCH;
    buttons |= this._strafeDirection > 0 ? InputButtons.RIGHT : InputButtons.LEFT;
    buttons |= InputButtons.FORWARD;

    // Try to aim at nearest visible enemy while dodging
    const enemy = this._lastVision?.visibleEnemies[0]?.player ?? state.getNearestEnemy();
    let pitch = state.self.pitch;
    let yaw = state.self.yaw;

    if (enemy) {
      const aim = this._aimAtTarget(state, enemy);
      pitch = aim.pitch;
      yaw = aim.yaw;
      // Only fire if we have vision-confirmed LOS
      if (this._lastVision?.visibleEnemies.some((e) => e.player.playerId === enemy.playerId)) {
        buttons |= InputButtons.FIRE;
      }
    }

    return {
      direction: { x: this._strafeDirection, y: 0, z: 1 },
      pitch,
      yaw,
      buttons,
      weaponSlot: 0,
    };
  }

  // ── CHASE State — Pursuit after LOS break ──────────────────────────

  private _executeChase(state: BotGameState): BotInput {
    const target = this._lastVision?.chaseTarget;
    if (!target) {
      // No target to chase — fall back to hunt
      return this._executeHunt(state);
    }

    // Move toward predicted (extrapolated) position using navGraph if available
    const holdUpper =
      state.matchState.gametypeName.toLowerCase() === "duel" &&
      target.lastSeenPosition.y < state.self.position.y - 64 &&
      state.self.health >= 50;
    const territory = holdUpper ? this._duelTerritory(state) : null;
    const input =
      holdUpper && !territory
        ? this._keepUpperGround(
            state,
            { position: target.predictedPosition },
            this._moveToward(state, { ...target.predictedPosition, y: state.self.position.y }, false),
          )
        : this._nav.navigateTo(state, territory ?? target.predictedPosition, false);
    if (holdUpper) {
      input.moveYaw = travelYaw(input);
      input.yaw = Math.atan2(
        target.predictedPosition.x - state.self.position.x,
        target.predictedPosition.z - state.self.position.z,
      );
    } else {
      this._watchLostEnemy(state, target, input);
    }

    // Only pre-fire when very close to predicted position (near corners)
    const distToTarget = vec3Length(vec3Subtract(target.predictedPosition, state.self.position));
    if (!holdUpper && distToTarget < 200 && target.confidence > 0.7) {
      input.buttons |= InputButtons.FIRE;
    }

    // Select appropriate weapon (use last known distance)
    const { slot: chaseSlot } = selectBestWeapon(
      state.self.weapons,
      state.self.ammo,
      state.self.currentWeapon,
      target.lastDistance,
    );
    if (chaseSlot > 0) {
      input.weaponSlot = chaseSlot;
    }

    return input;
  }

  /**
   * Keep looking where an enemy just went out of sight while running the
   * route after them, as a player watches the corner. Looking along the route
   * instead swung the view away and back each time sight came and went.
   */
  private _watchLostEnemy(state: BotGameState, target: EnemyTrack, input: BotInput): void {
    if (target.source !== "visual" || state.tick - target.lastSeenTick > CHASE_WATCH_TICKS) return;
    const delta = vec3Subtract(target.predictedPosition, this._getFireOrigin(state));
    const horizontal = Math.hypot(delta.x, delta.z);
    if (horizontal < 1) return;
    const watchYaw = Math.atan2(delta.x, delta.z);
    const moveYaw = travelYaw(input);
    if (Math.abs(wrapAngle(watchYaw - moveYaw)) > CHASE_WATCH_MAX_OFF_TRAVEL) return;
    input.moveYaw = moveYaw;
    input.yaw = watchYaw;
    input.pitch = -Math.atan2(delta.y, horizontal);
  }

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

  /**
   * A way out of a known enemy's sight: the nearest route node, within reach,
   * that the enemy cannot see from where it was last known and that does not
   * lie toward it. Reached once and dropped; null with no enemy or no node.
   */
  private _escapePoint(state: BotGameState): Vec3 | null {
    const graph = this._navGraph;
    const vision = this._lastBotVision;
    if (!graph || !vision) return null;
    const threat = this._lastVision?.visibleEnemies[0]?.player.position ?? this._getHuntTarget(state);
    if (!threat) return null;
    const self = state.self.position;
    if (this._life.escape && state.tick < this._life.escape.untilTick) {
      if (vec3Length(vec3Subtract(this._life.escape.point, self)) > ESCAPE_REACHED) return this._life.escape.point;
      this._life.escape = null;
      return null;
    }
    if (state.tick < this._escapeRetryTick) return null;
    const toThreat = vec3Normalize(vec3Subtract(threat, self));
    const eye = { x: threat.x, y: threat.y + 36, z: threat.z };
    const candidates: { position: Vec3; distance: number }[] = [];
    for (const node of graph.nodes) {
      const offset = vec3Subtract(node.position, self);
      const distance = vec3Length(offset);
      if (distance < ESCAPE_MIN || distance > ESCAPE_MAX) continue;
      const away = (offset.x * toThreat.x + offset.z * toThreat.z) / Math.max(1, distance);
      if (away <= ESCAPE_MAX_TOWARD) candidates.push({ position: node.position, distance });
    }
    // Sight lines and route costs for the nearest few only.
    candidates.sort((a, b) => a.distance - b.distance);
    let best: { point: Vec3; cost: number } | null = null;
    for (const { position } of candidates.slice(0, ESCAPE_CANDIDATES)) {
      if (vision.canSee(eye, { x: position.x, y: position.y + 36, z: position.z })) continue;
      const cost = graph.estimateTravelCost(self, position);
      if (cost === null || (best && cost >= best.cost)) continue;
      best = { point: position, cost };
    }
    this._life.escape = best ? { point: best.point, untilTick: state.tick + ESCAPE_HOLD_TICKS } : null;
    if (!best) this._escapeRetryTick = state.tick + ESCAPE_RETRY_TICKS;
    return best?.point ?? null;
  }

  private _executeRetreat(state: BotGameState): BotInput {
    // First out of the enemy's sight, then to health.
    if (this._lastVision?.visibleEnemies.length) {
      const wayOut = this._escapePoint(state);
      if (wayOut) return this._nav.navigateTo(state, wayOut, true);
    } else this._life.escape = null;

    // Scored choice among HEALTH ONLY. Retreating is a specific intent, so the
    // candidate set is filtered rather than left open — but within health the
    // arbiter still beats "nearest": it accounts for overcap (a bubble at 98 HP
    // is worthless), route cost, and mega vs. medium.
    const healthGoal = this._selectItemGoal(state, RETREAT_ITEM_TYPES, true)?.goal;
    if (healthGoal) return this._nav.navigateTo(state, healthGoal.position, true);

    // Try NavGraph path to nearest health (cached via _navigateToItem)
    if (this._navGraph) {
      const result = this._navigateToItem(state, "health", true);
      if (result) return result;
    }

    // Try vision's cover finding
    if (this._lastVision?.nearestCover) {
      return this._nav.navigateTo(state, this._lastVision.nearestCover, true);
    }

    // Try nearest health item from BSP knowledge
    if (this._lastBotVision) {
      const healthPos = this._lastBotVision.findNearestItem(state.self.position, "health", state.pickupActiveMask);
      if (healthPos) {
        return this._nav.navigateTo(state, healthPos, true);
      }
    }

    // Find nearest pickup (prefer health)
    const pickup = state.getNearestPickup(PICKUP_SEEK_RANGE);
    if (pickup) {
      return this._nav.navigateTo(state, pickup.position, true);
    }

    // No pickup found → run away from nearest enemy
    const enemy = state.getNearestEnemy();
    if (enemy) {
      // Move away from enemy (guard against same-position producing zero-length vector)
      const rawDir = vec3Subtract(state.self.position, enemy.position);
      const len = vec3Length(rawDir);
      const awayDir = len > 0.01 ? vec3Normalize(rawDir) : { x: Math.random() - 0.5, y: 0, z: Math.random() - 0.5 };
      const targetYaw = Math.atan2(awayDir.x, awayDir.z);

      return {
        direction: { x: 0, y: 0, z: 1 },
        pitch: 0,
        yaw: targetYaw,
        buttons: InputButtons.FORWARD | InputButtons.SPRINT,
        weaponSlot: 0,
      };
    }

    // No enemy to run from → hunt
    return this._executeHunt(state);
  }

  // ── ITEM_RUN State ────────────────────────────────────────────────

  private _executeItemRun(state: BotGameState): BotInput {
    if (this._life.mandatoryGoal) {
      const goal = this._life.mandatoryGoal;
      this._life.activeItemGoal = goal;
      return this._navigateGoal(state, goal, true);
    }
    // Scored choice first: value, denial, route and danger decide which item,
    // instead of the fixed weapon > health > armor > ammo ordering below (which
    // took the nearest of whichever type came first, so a 5 HP bubble could
    // outrank Red Armor). Falls through to the legacy path when disabled or
    // when nothing scores.
    const choice = this._selectItemGoal(state);
    // Only a DIRECTIVE goal holds on arrival. An item goal has to be touched,
    // and a bot that stops next to a Red Armor never picks it up.
    if (choice) {
      const goal = choice.goal;
      // An item worth having just off the way there is taken first.
      if (choice.stopover && !goal.directive) return this._navigateGoal(state, choice.stopover, false);
      const territory =
        !goal.directive && goal.position.y < state.self.position.y - 48 ? this._duelTerritory(state) : null;
      return territory ? this._nav.navigateTo(state, territory, false) : this._navigateGoal(state, goal, false);
    }

    // Try NavGraph path to nearest item (weapon > health > armor > ammo)
    // Uses cached _navigateToItem to avoid A* every tick
    if (this._navGraph) {
      for (const itemType of ["weapon", "health", "armor", "ammo"]) {
        const result = this._navigateToItem(state, itemType, false);
        if (result) return result;
      }
    }

    // Prefer vision-verified reachable pickups
    if (this._lastVision) {
      const reachable = this._lastVision.pickups.find((p) => p.isReachable);
      if (reachable) {
        return this._nav.navigateTo(state, reachable.pickup.position, false);
      }
    }

    // Try BSP-known item positions
    if (this._lastBotVision) {
      const weaponPos = this._lastBotVision.findNearestItem(state.self.position, "weapon", state.pickupActiveMask);
      if (weaponPos) {
        return this._nav.navigateTo(state, weaponPos, false);
      }
    }

    // Fallback to raw state pickups
    const pickup = state.getNearestPickup(PICKUP_SEEK_RANGE);
    if (pickup) {
      return this._nav.navigateTo(state, pickup.position, false);
    }

    // No pickups found → hunt
    return this._executeHunt(state);
  }

  // ── HUNT State ────────────────────────────────────────────────────

  private _executeHunt(state: BotGameState): BotInput {
    this._huntTimer++;

    const territory = this._duelTerritory(state);
    if (territory) return this._nav.navigateTo(state, territory, false);

    // Prefer a scored goal over aimless patrol. Reached when the ladder falls
    // through to HUNT but the arbiter still has something worth doing — an
    // objective, or an item that did not meet _shouldSeekItems' cruder bar.
    const goal = this._selectItemGoal(state)?.goal;
    if (goal) return this._navigateGoal(state, goal, false);

    // Check if we know a last enemy position to investigate
    const huntTarget = this._getHuntTarget(state);
    if (huntTarget) {
      return this._nav.navigateTo(state, huntTarget, false);
    }

    // NavGraph patrol: pick a random nav node to walk toward
    if (this._navGraph) {
      const nodes = this._navGraph.nodes;
      if (nodes.length > 0 && (!this._life.huntPatrolTarget || this._nav.pathRecalcTimer > PATH_RECALC_INTERVAL * 2)) {
        const randomNode = nodes[Math.floor(Math.random() * nodes.length)];
        this._life.huntPatrolTarget = randomNode.position;
        this._nav.pathRecalcTimer = 0;
      }
      if (this._life.huntPatrolTarget) {
        // Check if we've arrived at patrol target
        const distToPatrol = vec3Length(vec3Subtract(this._life.huntPatrolTarget, state.self.position));
        if (distToPatrol < PATH_ARRIVED_THRESHOLD) {
          this._life.huntPatrolTarget = null; // Pick new target next tick
          this._life.currentPath = null;
        } else {
          return this._nav.navigateTo(state, this._life.huntPatrolTarget, false);
        }
      }
    }

    // Fallback: random patrol — change direction periodically
    if (this._huntTimer > HUNT_DIRECTION_CHANGE_INTERVAL) {
      this._huntYaw += (Math.random() - 0.5) * Math.PI;
      this._huntTimer = 0;
    }

    // Look around randomly (human-feel)
    this._updateLookAround();

    const buttons = InputButtons.FORWARD | InputButtons.SPRINT;

    return {
      direction: { x: 0, y: 0, z: 1 },
      pitch: 0,
      yaw: this._huntYaw + this._lookAroundYaw,
      buttons,
      weaponSlot: 0,
    };
  }

  // ── Aiming ────────────────────────────────────────────────────────

  private _aimAtTarget(state: BotGameState, target: VisiblePlayer): { pitch: number; yaw: number } {
    let targetPos = { ...target.position };

    // Predict target position based on velocity (for projectile weapons)
    if (this.difficulty.predictionSkill > 0) {
      const prediction = this._predictTargetPosition(state, target);
      targetPos = prediction;
    }

    // Weapons fire from the eye, not the player origin. Aim at the enemy origin
    // from our fire origin so same-floor shots do not pass above the target.
    const delta = vec3Subtract(targetPos, this._getFireOrigin(state));
    const horizontalDist = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
    const perfectYaw = horizontalDist > 0.01 ? Math.atan2(delta.x, delta.z) : state.self.yaw;
    const perfectPitch =
      horizontalDist > 0.01 ? -Math.atan2(delta.y, horizontalDist) : delta.y > 0 ? -Math.PI / 2 : Math.PI / 2;

    // Where to look, exactly: the client turns the view there at this
    // difficulty's speed and adds its wandering error (BotAimController).
    return { yaw: perfectYaw, pitch: perfectPitch };
  }

  private _predictTargetPosition(_state: BotGameState, target: VisiblePlayer): Vec3 {
    // Estimate projectile travel time
    const distance = target.distance;
    const estimatedProjectileSpeed = 1400; // rough average projectile speed
    const travelTime = distance / estimatedProjectileSpeed;

    // Apply prediction with skill factor
    const predFactor = this.difficulty.predictionSkill * travelTime;

    return {
      x: target.position.x + target.velocity.x * predFactor,
      y: target.position.y + target.velocity.y * predFactor,
      z: target.position.z + target.velocity.z * predFactor,
    };
  }

  // ── Weapon Selection ──────────────────────────────────────────────

  /**
   * Aim at target with projectile lead prediction.
   * Uses the weapon's projectile speed to predict where the target will be.
   */
  private _aimAtTargetWithLead(
    state: BotGameState,
    target: VisiblePlayer,
    profile: WeaponProfile,
  ): { pitch: number; yaw: number } {
    // Estimate travel time: distance / projectileSpeed
    const travelTime = target.distance / (profile.projectileSpeed || 2500);

    // Predicted position = current position + velocity * travelTime
    const predicted: Vec3 = {
      x: target.position.x + (target.velocity?.x ?? 0) * travelTime,
      y: target.position.y + (target.velocity?.y ?? 0) * travelTime,
      z: target.position.z + (target.velocity?.z ?? 0) * travelTime,
    };

    // Splash weapons: aim slightly lower (toward feet)
    if (profile.hasSplash) {
      predicted.y -= 20;
    }

    // Calculate angles from the actual weapon fire origin.
    const diff = vec3Subtract(predicted, this._getFireOrigin(state));
    const dist2D = Math.sqrt(diff.x * diff.x + diff.z * diff.z);

    const yaw = Math.atan2(diff.x, diff.z);
    const pitch = -Math.atan2(diff.y, dist2D);

    // Turn speed and aim error are the client's (BotAimController), as in _aimAtTarget.
    return { yaw, pitch };
  }

  // ── Movement Helpers ──────────────────────────────────────────────

  /** Where this bot's shots leave from: its eye, as the game server places it. */
  private _getFireOrigin(state: BotGameState): Vec3 {
    return {
      x: state.self.position.x,
      y: state.self.position.y + scaledBodyHeight(DEFAULT_VIEWHEIGHT, this._bodyScale),
      z: state.self.position.z,
    };
  }

  /**
   * Navigate to a target position using NavGraph pathfinding when available.
   * Falls back to direct movement when no graph exists.
   */
  /**
   * How close to a goal the bot stops and waits: a directive's own radius, or
   * beside a timed item that is not back yet. Undefined for goals to touch.
   */
  private _holdRadius(goal: BotGoal, state: BotGameState): number | undefined {
    if (goal.directive) return goal.radius;
    if (goal.respawnTick !== undefined && goal.respawnTick > state.tick) return TIMED_ITEM_HOLD_RADIUS;
    return undefined;
  }

  private _selectMandatoryGoal(state: BotGameState): BotGoal | null {
    if (this._goalArbiterMode === "legacy") return null;
    const weights = selectWeightProfile(state.matchState.gametypeName, state.getOwnRole(), state.matchState.roundState);
    if (weights.objectivePush <= 0) return null;
    const goals = collectDirectiveGoals(state).filter(
      (goal) => goal.directive?.interrupt === "never" && Number.isFinite(goal.directive.priority),
    );
    goals.sort((a, b) => (b.directive?.priority ?? 0) - (a.directive?.priority ?? 0) || a.id.localeCompare(b.id));
    return goals[0] ?? null;
  }

  private _navigateGoal(state: BotGameState, goal: BotGoal, urgent: boolean): BotInput {
    const waypoint = this._nav.nextWaypoint(state, goal);
    if (waypoint) return this._nav.navigateTo(state, waypoint, urgent);
    const radius = this._holdRadius(goal, state);
    // Planting and defusing use move_to: those orders must stay still on arrival.
    // Escorting patrols round the player escorted, as it moves.
    const patrol =
      goal.directive?.kind === "defend" || goal.directive?.kind === "hold_area" || goal.directive?.kind === "escort";
    if (patrol && radius !== undefined && vec3Length(vec3Subtract(goal.position, state.self.position)) <= radius) {
      return this._guardPatrol(state, goal.id, goal.position, radius, goal.directive?.watch ?? null);
    }
    this._life.sitePatrol = null;
    const timed = !goal.directive && goal.respawnTick !== undefined && goal.respawnTick > state.tick;
    if (timed && radius !== undefined && vec3Length(vec3Subtract(goal.position, state.self.position)) <= radius) {
      if (state.matchState.gametypeName.toLowerCase() === "duel") {
        const patrol = this._duelTerritory(state, goal.position);
        return patrol ? this._nav.navigateTo(state, patrol, false) : this._startRecovery(state);
      }
      return this._watchEntrances(state, goal.position);
    }
    return this._nav.navigateTo(state, goal.position, urgent, radius);
  }

  private _duelTerritory(state: BotGameState, center?: Vec3): Vec3 | null {
    if (state.matchState.gametypeName.toLowerCase() !== "duel" || !this._navGraph || !this._lastBotVision) return null;
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
  /** Waiting for an item: on the move round it, watching the ways in. */
  private _watchEntrances(state: BotGameState, item: Vec3): BotInput {
    return this._guardPatrol(state, `item:${item.x},${item.z}`, item, TIMED_ITEM_HOLD_RADIUS, null);
  }

  /**
   * Guarding: on the move round `center`, never standing. The guard runs
   * between walkable points within `radius`, choosing ones that see the way
   * in, and keeps its view on that way in (or on the ways into the spot) while
   * it runs, as a player strafes about a doorway instead of standing in it.
   * With nowhere to run, it strafes side to side facing the way in.
   */
  private _guardPatrol(
    state: BotGameState,
    goalId: string,
    center: Vec3,
    radius: number,
    watch: Vec3 | null,
  ): BotInput {
    // These are verified walking segments, not approaches to a traversal trick.
    this._suppressTraversalAutomation = true;
    const self = state.self.position;
    const look = watch ?? this._entranceToWatch(state, center);
    const lookYaw = look ? Math.atan2(look.x - self.x, look.z - self.z) : state.self.yaw;
    const sweep = Math.sin((state.tick / TICK_RATE) * HOLD_SWEEP_RATE) * HOLD_SWEEP;
    const pitch = look
      ? -Math.atan2(
          look.y - (self.y + scaledBodyHeight(DEFAULT_VIEWHEIGHT, this._bodyScale)),
          Math.hypot(look.x - self.x, look.z - self.z),
        )
      : 0;

    const previous = this._life.sitePatrol;
    let target =
      previous?.goalId === goalId &&
      state.tick < previous.expires &&
      vec3Length(vec3Subtract(previous.target, self)) > GUARD_POINT_REACHED
        ? previous.target
        : null;
    if (!target) {
      target = this._guardPoint(state, center, radius, look, previous?.goalId === goalId ? previous.target : null);
      this._life.sitePatrol = target ? { goalId, target, expires: state.tick + 4 * TICK_RATE, pauseUntil: 0 } : null;
    }
    if (!target) {
      // Strafe across the way in, turning back every so often, toward the side with room
      const room = (sign: number) => {
        const a = lookYaw + sign * (Math.PI / 2);
        const world = this._lastBotVision?.collisionWorld;
        if (!world) return 1;
        return world.trace(self, { x: self.x + Math.sin(a) * 96, y: self.y, z: self.z + Math.cos(a) * 96 }).fraction;
      };
      const turn = Math.floor(state.tick / GUARD_STRAFE_TICKS) % 2 === 0 ? 1 : -1;
      const side = room(turn) >= 0.5 || room(turn) >= room(-turn) ? turn : -turn;
      return {
        direction: { x: side, y: 0, z: 0 },
        pitch,
        yaw: lookYaw + sweep,
        moveYaw: lookYaw,
        buttons: side < 0 ? InputButtons.LEFT : InputButtons.RIGHT,
        weaponSlot: 0,
      };
    }
    return {
      direction: { x: 0, y: 0, z: 1 },
      pitch,
      yaw: lookYaw + sweep,
      moveYaw: Math.atan2(target.x - self.x, target.z - self.z),
      buttons: InputButtons.FORWARD | InputButtons.SPRINT,
      weaponSlot: 0,
    };
  }

  /**
   * The next patrol point round `center`: walkable from here on this floor,
   * away from the last one, and where the way in can be seen, if any can.
   */
  private _guardPoint(
    state: BotGameState,
    center: Vec3,
    radius: number,
    look: Vec3 | null,
    last: Vec3 | null,
  ): Vec3 | null {
    const vision = this._lastBotVision;
    if (!vision) return null;
    const self = state.self.position;
    const r = Math.max(GUARD_MIN_RADIUS, Math.min(GUARD_MAX_RADIUS, radius));
    const offset = Math.random() * Math.PI * 2;
    const candidates: { point: Vec3; score: number }[] = [];
    for (const ring of GUARD_RINGS) {
      for (let k = 0; k < GUARD_DIRECTIONS; k++) {
        const a = offset + (k / GUARD_DIRECTIONS) * Math.PI * 2;
        const point = { x: center.x + Math.sin(a) * r * ring, y: self.y, z: center.z + Math.cos(a) * r * ring };
        if (vec3Length(vec3Subtract(point, self)) < 96) continue;
        if (last && vec3Length(vec3Subtract(point, last)) < 96) continue;
        if (!vision.isWalkable(self, point)) continue;
        const sees =
          look !== null && vision.canSee({ ...point, y: point.y + GUARD_EYE }, { ...look, y: look.y + GUARD_EYE });
        candidates.push({ point, score: (sees ? 2 : 0) + Math.random() });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.point ?? null;
  }

  /** One of the ways into `spot` on the nav graph, taken in turn over time; null if none. */
  private _entranceToWatch(state: BotGameState, spot: Vec3): Vec3 | null {
    const graph = this._navGraph;
    const node = graph?.findNearestNode(spot);
    if (!graph || !node) return null;
    const ways = graph.edges
      .filter((edge) => edge.to === node.id && edge.from !== node.id)
      .map((edge) => graph.nodes.find((n) => n.id === edge.from)?.position)
      .filter((position): position is Vec3 => position !== undefined)
      .filter((position) => vec3Length(vec3Subtract(position, state.self.position)) > 64);
    if (ways.length === 0) return null;
    return ways[Math.floor(state.tick / ENTRANCE_WATCH_TICKS) % ways.length];
  }

  /** The guard order whose ground a fight or chase must not leave, if any. */
  private _leashOrder(state: BotGameState): { center: Vec3; leash: number } | null {
    let best: { center: Vec3; leash: number; priority: number } | null = null;
    for (const order of state.directives) {
      if (order.leash === undefined || order.target.type !== "position" || order.expiresAtTick <= state.tick) continue;
      if (order.kind !== "hold_area" && order.kind !== "defend") continue;
      if (!best || order.priority > best.priority) {
        best = { center: order.target.position, leash: order.leash, priority: order.priority };
      }
    }
    return best;
  }

  /**
   * A guard in a fight that has drifted past its leash heads back while it
   * keeps aiming: the fight is answered from the ground it was sent to hold.
   */
  private _applyLeash(state: BotGameState, input: BotInput): BotInput {
    const order = this._leashOrder(state);
    if (!order) return input;
    const self = state.self.position;
    if (Math.hypot(self.x - order.center.x, self.z - order.center.z) <= order.leash) return input;
    const back = Math.atan2(order.center.x - self.x, order.center.z - self.z);
    const keep = InputButtons.FIRE | InputButtons.ALT_FIRE | InputButtons.JUMP | InputButtons.CROUCH;
    return {
      ...input,
      direction: { x: 0, y: 0, z: 1 },
      moveYaw: back,
      buttons: (input.buttons & keep) | InputButtons.FORWARD,
    };
  }

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
    this._steerTarget = target;
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

  /**
   * Turn the feet, not the view, onto the heading BotVisionTracer finds
   * clear. The keys stay as the decision chose them: the move yaw turns so
   * they carry the bot along the clear heading.
   */
  private _steer(input: BotInput, state: BotGameState, vision: BotVision): BotInput {
    const keys = input.direction;
    if (Math.hypot(keys.x, keys.z) < 0.01) return input;
    if (!this._tracer || this._tracerWorld !== vision.collisionWorld) {
      this._tracer = new BotVisionTracer(
        vision.collisionWorld,
        (vision.mapKnowledge?.triggerVolumes ?? []).filter((t) => t.type === "push" || t.type === "teleport"),
      );
      this._tracerWorld = vision.collisionWorld;
    }
    const keyTurn = Math.atan2(keys.x, keys.z);
    const moveYaw = travelYaw(input);
    const self = state.self;
    const target = this._steerTarget;
    const result = this._tracer.steer({
      tick: state.tick,
      position: self.position,
      velocity: self.velocity,
      grounded: self.isGrounded,
      yaw: moveYaw + keyTurn,
      onLine: this._nav.onRouteLine,
      throughTriggers: this._routeUsesTrigger(),
      ...(target
        ? {
            targetDistance: Math.hypot(target.x - self.position.x, target.z - self.position.z),
            dropping: target.y < self.position.y - STEER_DROP_HEIGHT,
          }
        : {}),
    });
    if (!result) {
      if (self.isGrounded) {
        this._life.padRide = null;
        return input;
      }
      // Thrown by a pad with no sequence flying it (one the route did not mean to
      // use, or one whose traversal gave up): fly on to where it throws, until
      // down again. Its throw ends at the ledge it serves, and a bot that steers
      // back toward its own way falls onto the pad and is thrown again.
      if (!this._life.padRide && self.velocity.y > PAD_LAUNCH_SPEED && !this._traversal.runtime.isActive) {
        const pad = this._padUnder(self.position, vision);
        if (pad) this._life.padRide = { dest: pad.dest };
      }
      if (this._life.padRide) {
        const dest = this._life.padRide.dest;
        const keep = InputButtons.FIRE | InputButtons.ALT_FIRE | InputButtons.CROUCH;
        return {
          ...input,
          direction: { x: 0, y: 0, z: 1 },
          moveYaw: Math.atan2(dest.x - self.position.x, dest.z - self.position.z),
          buttons: (input.buttons & keep) | InputButtons.FORWARD,
        };
      }
      return this._steerAir(input, state, vision);
    }
    this._steerClear = result.clear;
    if (result.turned) this._feelerSteered = true;
    return { ...input, moveYaw: result.yaw - keyTurn };
  }

  /**
   * Tricks the tracer says work from here (BotVisionTracer.climbByJump,
   * wallJumpGain), on the way to the point the bot makes for: a jump onto
   * what stands in the way when the point is above it, and a wall jump when
   * one ends nearer the point than falling on. Navigation only; a fight
   * moves for the fight.
   */
  private _tryTricks(state: BotGameState, input: BotInput): BotInput {
    const tracer = this._tracer;
    const self = state.self;
    const navigating =
      this.currentState === BotState.HUNT ||
      this.currentState === BotState.ITEM_RUN ||
      this.currentState === BotState.RETREAT ||
      this.currentState === BotState.CHASE;
    if (!tracer || !navigating || self.isDead) {
      this._life.climb = null;
      this._wallJumpPress = false;
      return input;
    }
    const toward = (target: Vec3) => Math.atan2(target.x - self.position.x, target.z - self.position.z);
    const forwardTo = (target: Vec3, jump: boolean): BotInput => ({
      ...input,
      direction: { x: 0, y: 0, z: 1 },
      moveYaw: toward(target),
      buttons:
        (input.buttons & ~(InputButtons.BACK | InputButtons.LEFT | InputButtons.RIGHT | InputButtons.CROUCH)) |
        InputButtons.FORWARD |
        (jump ? InputButtons.JUMP : 0),
    });

    // A climb under way: forward to its target until down again, for the ledge grab
    const climb = this._life.climb;
    if (climb) {
      if (state.tick > climb.untilTick || (self.isGrounded && state.tick > climb.untilTick - CLIMB_HOLD_TICKS + 10)) {
        this._life.climb = null;
      } else if (!self.isGrounded) {
        return forwardTo(climb.target, false);
      }
    }
    const target = this._steerTarget;
    if (!target) return input;

    if (self.isGrounded) {
      this._wallJumpPress = false;
      const rise = target.y - self.position.y;
      const far = Math.hypot(target.x - self.position.x, target.z - self.position.z);
      if (rise < CLIMB_RISE || far > CLIMB_REACH || this._steerClear >= CLIMB_BLOCKED) return input;
      if (state.tick < this._trickCheckTick) return input;
      this._trickCheckTick = state.tick + TRICK_CHECK_TICKS;
      const top = tracer.climbByJump(self.position, self.velocity, toward(target));
      if (!top || top.y < self.position.y + CLIMB_RISE) return input;
      this._life.climb = { target: { ...target }, untilTick: state.tick + CLIMB_HOLD_TICKS };
      return forwardTo(target, true);
    }

    // In the air beside a wall: press for a wall jump that ends nearer the target
    if (this._wallJumpPress) {
      this._wallJumpPress = false;
      return forwardTo(target, true);
    }
    if (state.tick < this._trickCheckTick || !tracer.wallWithin(self.position, WALL_JUMP_NEAR)) return input;
    this._trickCheckTick = state.tick + WALL_JUMP_CHECK_TICKS;
    const gain = tracer.wallJumpGain(self.position, self.velocity, toward(target), target);
    if (gain === null || gain < WALL_JUMP_GAIN) return input;
    // Jump held from the take-off would make this no fresh press: let go first
    if (this._lastJumpHeld) {
      this._wallJumpPress = true;
      return forwardTo(target, false);
    }
    return forwardTo(target, true);
  }

  /**
   * In the air, about to fly into a wall: a side key alone toward the open
   * side, at the angle that turns the flight without losing speed
   * (sideTurnAngle), instead of the keys the decision held. Jump, fire and
   * crouch stay as they were.
   */
  private _steerAir(input: BotInput, state: BotGameState, vision: BotVision): BotInput {
    const self = state.self;
    const side = wallAheadSide(vision.collisionWorld, self.position, self.velocity);
    if (side === 0) return input;
    this._feelerSteered = true;
    const speed = Math.hypot(self.velocity.x, self.velocity.z);
    const wish = Math.atan2(self.velocity.x, self.velocity.z) + side * sideTurnAngle(speed);
    const keep = InputButtons.JUMP | InputButtons.FIRE | InputButtons.ALT_FIRE | InputButtons.CROUCH;
    return {
      ...input,
      direction: { x: side, y: 0, z: 0 },
      // The key is a quarter turn off the move yaw
      moveYaw: wish - side * (Math.PI / 2),
      buttons: (input.buttons & keep) | (side < 0 ? InputButtons.LEFT : InputButtons.RIGHT),
    };
  }

  /** The jump pad at or just below `position` (the bot leaves it within a tick of the throw), or null. */
  private _padUnder(position: Vec3, vision: BotVision): { dest: Vec3 } | null {
    const pads = (vision.mapKnowledge?.triggerVolumes ?? []).filter((t) => t.type === "push");
    for (const pad of pads) {
      const inside =
        position.x >= pad.min.x - 32 &&
        position.x <= pad.max.x + 32 &&
        position.z >= pad.min.z - 32 &&
        position.z <= pad.max.z + 32 &&
        position.y >= pad.min.y - 32 &&
        position.y <= pad.max.y + 96;
      if (inside) return { dest: pad.dest };
    }
    return null;
  }

  /** Whether the route's current step goes to or through a jump pad or teleporter. */
  private _routeUsesTrigger(): boolean {
    const path = this._life.currentPath;
    const step = path?.steps[path.cursor];
    if (!step) return false;
    return (
      step.type === "jumppad" ||
      step.type === "teleporter" ||
      step.to.type === "jumppad" ||
      step.to.type === "teleporter"
    );
  }

  private _applyFeelers(input: BotInput, state: BotGameState, vision: BotVision): BotInput {
    /**
     * Cast 3 rays from bot position to detect nearby walls.
     * If a wall is detected, steer the bot away from it.
     * Runs after brain decision and adjusts heading without overriding state.
     */

    const pos = state.self.position;
    const yaw = travelYaw(input);
    const cw = vision.collisionWorld;

    // Eye height offset
    const eyePos = { x: pos.x, y: pos.y + 36, z: pos.z };

    // Forward ray
    const fwdEnd = {
      x: eyePos.x + Math.sin(yaw) * FEELER_FORWARD_DIST,
      y: eyePos.y,
      z: eyePos.z + Math.cos(yaw) * FEELER_FORWARD_DIST,
    };
    const fwdResult = cw.trace(eyePos, fwdEnd);

    // Forward-left ray (yaw - 30°)
    const leftYaw = yaw - FEELER_SIDE_ANGLE;
    const leftEnd = {
      x: eyePos.x + Math.sin(leftYaw) * FEELER_SIDE_DIST,
      y: eyePos.y,
      z: eyePos.z + Math.cos(leftYaw) * FEELER_SIDE_DIST,
    };
    const leftResult = cw.trace(eyePos, leftEnd);

    // Forward-right ray (yaw + 30°)
    const rightYaw = yaw + FEELER_SIDE_ANGLE;
    const rightEnd = {
      x: eyePos.x + Math.sin(rightYaw) * FEELER_SIDE_DIST,
      y: eyePos.y,
      z: eyePos.z + Math.cos(rightYaw) * FEELER_SIDE_DIST,
    };
    const rightResult = cw.trace(eyePos, rightEnd);

    // Determine steering adjustment
    let yawAdjust = 0;
    const fwdBlocked = fwdResult.hit && fwdResult.fraction < FEELER_STEER_THRESHOLD;
    const leftBlocked = leftResult.hit && leftResult.fraction < FEELER_STEER_THRESHOLD;
    const rightBlocked = rightResult.hit && rightResult.fraction < FEELER_STEER_THRESHOLD;

    if (fwdBlocked) {
      // Wall directly ahead — steer toward open side
      if (leftBlocked && !rightBlocked) {
        yawAdjust = 0.5; // Turn right
      } else if (rightBlocked && !leftBlocked) {
        yawAdjust = -0.5; // Turn left
      } else if (leftBlocked && rightBlocked) {
        // Walled in on all sides — turn hard (pick random side)
        yawAdjust = this._strafeDirection > 0 ? 1.2 : -1.2;
      } else {
        // Forward blocked but sides open — steer toward more open side
        const leftDist = leftResult.fraction;
        const rightDist = rightResult.fraction;
        yawAdjust = leftDist > rightDist ? -0.4 : 0.4;
      }
      // Turning away changes what the rays see, and choosing again from the
      // new heading swung the bot left, right and left at the same wall.
      const side = this._life.feelerSide;
      const sideClosed = side && (side.sign > 0 ? rightBlocked && !leftBlocked : leftBlocked && !rightBlocked);
      if (side && state.tick < side.untilTick && !sideClosed) {
        yawAdjust = side.sign * Math.abs(yawAdjust);
      } else {
        this._life.feelerSide = { sign: Math.sign(yawAdjust), untilTick: state.tick + FEELER_SIDE_COMMIT_TICKS };
      }
    } else if (leftBlocked && !rightBlocked) {
      yawAdjust = 0.2; // Gentle right
    } else if (rightBlocked && !leftBlocked) {
      yawAdjust = -0.2; // Gentle left
    }

    if (yawAdjust !== 0) {
      this._feelerSteered = true;
      // Steer the heading; a bot looking ahead along its route keeps looking there.
      if (input.moveYaw !== undefined) input.moveYaw += yawAdjust;
      else input.yaw += yawAdjust;
    }

    return input;
  }

  private _updateLookAround(): void {
    this._lookAroundTimer++;
    const interval = this.difficulty.lookAroundInterval * 60; // Convert seconds to ticks
    if (this._lookAroundTimer > interval) {
      this._lookAroundYaw = (Math.random() - 0.5) * 0.5; // Small random look
      this._lookAroundTimer = 0;
    }
  }

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
        return brain._tracer;
      },
      get nav() {
        return brain._nav;
      },
      cancelScript: () => {
        this._cancelScript = true;
      },
      exactStep: () => {
        this._suppressTraversalAutomation = true;
        this._exactMove = true;
      },
      startRecovery: (state, stuck) => this._startRecovery(state, stuck),
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
      exactStep: () => {
        this._suppressTraversalAutomation = true;
        this._exactMove = true;
      },
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
    this._combatMovement.reset();
    this._coverPeek.reset();
    this._weaponCombos.reset();
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

/** Yaw from `from` toward `to`, as the view measures it. */
function bearingTo(from: Vec3, to: Vec3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}
