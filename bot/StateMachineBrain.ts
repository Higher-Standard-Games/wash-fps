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
import { selectWeightProfile } from "../shared/bot/WeightProfiles";
import { BotBrain, type BotInput, BotState, travelYaw } from "./BotBrain";
import { BotCombatMovement, findHighGround } from "./BotCombatMovement";
import { type BotDifficulty, defaultGoalArbiterMode, type GoalArbiterMode, InputButtons } from "./BotConfig";
import type { BotGameState, Vec3, VisiblePlayer } from "./BotGameState";
import { vec3Length, vec3Normalize, vec3Subtract } from "./BotGameState";
import { BotMood, type Mood, type MoodEvent } from "./BotMood";
import { canInitiateSlide, PHYSICS } from "./BotMovementProfile";
import { type BotNavGraph, type NavPath, type NavPathOptions, type NavStep, navEdgeKey } from "./BotNavGraph";
import { duelLeadReactionDelay } from "./BotReactionTuning";
import { BotSequenceRegistry, BotSequenceRuntime, type BotSequenceRuntimeTick } from "./BotSequence";
import { BotTerritory } from "./BotTerritory";
import type { BotVision, VisionResult } from "./BotVision";
import { BotWeaponCombos, has, slotFor } from "./BotWeaponCombos";
import { getWeaponProfile, selectBestWeapon, type WeaponProfile } from "./BotWeaponProfile";
import type { BotGoal } from "./goals/BotGoal";
import { collectDirectiveGoals } from "./goals/DirectiveGoalSource";
import { ItemGoalPlanner } from "./goals/ItemGoalPlanner";
import { planLedgeSlideJump } from "./LedgeSlideJump";
import { ItemSlideApproachSequence } from "./sequences/ItemSlideApproachSequence";
import { LearnedRouteSequence } from "./sequences/LearnedRouteSequence";
import { LedgeSlideJumpSequence } from "./sequences/LedgeSlideJumpSequence";
import { RouteCrouchslideSequence } from "./sequences/RouteCrouchslideSequence";
import { RouteStrafeJumpSequence } from "./sequences/RouteStrafeJumpSequence";
import { canLunge, SlideBladeSequence } from "./sequences/SlideBladeSequence";
import { TraverseJumppadSequence } from "./sequences/TraverseJumppadSequence";
import { TraverseTeleporterSequence } from "./sequences/TraverseTeleporterSequence";
import { ValidatedJumpSequence } from "./sequences/ValidatedJumpSequence";

// ── Constants ───────────────────────────────────────────────────────────

const LOW_HEALTH_THRESHOLD = 40;
const RETREAT_HEALTH_THRESHOLD = 25;
const FIGHT_RANGE = 2000;
const PICKUP_SEEK_RANGE = 1500;
/** A bot timing an item waits this close to it, inside its pickup reach. */
const TIMED_ITEM_HOLD_RADIUS = 40;
/** How long a bot waiting at a timed item watches one way in. */
const ENTRANCE_WATCH_TICKS = 375;
const DODGE_REACT_TICKS = 30; // React to damage within last 30 ticks
/** The slide's own cooldown plus its length, in server ticks, from the start of the last one. */
const SLIDE_COOLDOWN_TICKS = Math.ceil(((PHYSICS.SLIDE_COOLDOWN + PHYSICS.SLIDE_DURATION) / 1000) * 125);
/** A lunge chance passed up is not rolled for again this soon. */
const LUNGE_REROLL_TICKS = 125;
/** Too hurt to dive in with a blade. */
const LUNGE_MIN_HEALTH = 30;
/** How often a bot with a splash weapon looks for a ledge to fight from. */
const HIGH_GROUND_SEARCH_TICKS = 250;
/** A heard enemy this close gets the gun for its distance readied, held this long. */
const READY_RANGE = 1500;
const READY_TICKS = 250;
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

// Path following
const PATH_ARRIVED_THRESHOLD = 100; // Distance to consider "arrived" at a waypoint
/** How far along its route a walking bot looks. */
const ROUTE_LOOK_AHEAD = 250;
/** Closer than this the look point says nothing about where the route goes. */
const ROUTE_LOOK_MIN_DISTANCE = 32;
type PathFollowResult =
  | { status: "moving"; input: BotInput }
  | { status: "complete" }
  | { status: "blocked"; reason: string };

const PATH_RECALC_INTERVAL = 120; // Recalculate path every ~2 seconds
const NAV_EDGE_FAILURE_COOLDOWN_TICKS = 625;

const BOT_SLIDE_COOLDOWN_TICKS = Math.ceil((PHYSICS.SLIDE_COOLDOWN / 1000) * 125);
const ROUTE_SLIDE_MIN_REMAINING_DISTANCE = 320;
const ROUTE_SLIDE_LOOKAHEAD_DISTANCE = 520;
const ROUTE_SLIDE_MAX_TURN_RADIANS = Math.PI / 4;
const ITEM_SLIDE_MIN_DISTANCE = 260;
const ITEM_SLIDE_MAX_DISTANCE = 760;
const ITEM_SLIDE_MAX_VELOCITY_ERROR_RADIANS = Math.PI / 6;
const ITEM_SLIDE_ALLY_RADIUS = 80;
const PICKUP_FAILURE_COOLDOWN_TICKS = 625;

/** RETREAT wants healing, not shopping — see ItemGoalPlannerOptions.typeFilter. */
const RETREAT_ITEM_TYPES: ReadonlySet<string> = new Set(["health"]);

const BOT_STRAFE_RETRY_TICKS = 30;
const ROUTE_STRAFE_MIN_REMAINING_DISTANCE = 640;
const ROUTE_STRAFE_ITEM_MIN_REMAINING_DISTANCE = 800;
const ROUTE_STRAFE_LOOKAHEAD_DISTANCE = 900;
const ROUTE_STRAFE_MAX_TURN_RADIANS = Math.PI / 6;
const ROUTE_STRAFE_MAX_VELOCITY_ERROR_RADIANS = Math.PI / 6;
const ROUTE_STRAFE_ALLY_LOOKAHEAD = 600;
const ROUTE_STRAFE_ALLY_RADIUS = 80;

export class StateMachineBrain extends BotBrain {
  // ── Internal state ────────────────────────────────────────────────
  private _huntYaw: number = 0;
  private _huntTimer: number = 0;

  // Slide-blade lunge: when this bot last slid, and when it may roll for a lunge again
  private _lastSlideTick = Number.NEGATIVE_INFINITY;
  private _lungeRollAfterTick = 0;
  private readonly _combatMovement = new BotCombatMovement();
  private readonly _weaponCombos = new BotWeaponCombos();
  private readonly _mood = new BotMood();
  /** Kills and deaths since the last `takeMoodEvents`, for chat. */
  private _moodEvents: MoodEvent[] = [];
  /** The gun got out for an enemy heard but not yet seen, and until when. */
  private _readyWeapon: { weapon: string; until: number } | null = null;
  private _readyRollTick = 0;
  private _highGroundSpot: Vec3 | null = null;
  private _highGroundSearchTick = 0;

  // Movement variety
  private _strafeDirection: number = 1; // 1 or -1

  // Crouchslide cooldown. Sequence phases use authoritative server ticks.
  private _slideCooldownUntilTick: number = 0;

  private _routeStrafeCooldownUntilTick: number = 0;
  private _routeStrafeSide: -1 | 1 = 1;
  // Charged weapon cadence (blade alt-fire: hold, then release to shoot)
  private _chargeWeaponId: string | null = null;
  private _chargeTargetId: string | null = null;
  private _chargeStartTick: number | null = null;
  private _chargeReleaseTick: number | null = null;

  /** Tick ADS was first held with the weapon now up, while it stays held. */
  private _adsSinceTick: number | null = null;

  // Random look-around for human-feel
  private _lookAroundTimer: number = 0;
  private _lookAroundYaw: number = 0;

  // NavGraph pathfinding
  private _navGraph: BotNavGraph | null = null;
  private _currentPath: NavPath | null = null;
  private _pathTarget: Vec3 | null = null;
  private _pathRecalcTimer: number = 0;
  private _huntPatrolTarget: Vec3 | null = null; // Separate from _pathTarget to avoid confusion
  private readonly _territory = new BotTerritory();
  private _navigationProgress: { position: Vec3; tick: number } | null = null;
  private _recovery: { target: Vec3; until: number } | null = null;
  private _ledgeProbeTick = 0;
  private _leadReactionDelayMs = 0;
  private _cancelScript = false;
  private readonly _sequenceRegistry = new BotSequenceRegistry();
  private readonly _sequenceRuntime = new BotSequenceRuntime(this._sequenceRegistry);
  private _activeSequenceStep: NavStep | null = null;
  private _lastDecisionTick: number = 0;
  private readonly _blockedNavEdges = new Map<string, number>();

  private readonly _blockedPickupIds = new Map<number, number>();
  private _activeItemSlideTarget: { pickupId: number; position: Vec3 } | null = null;

  // Scored item-goal selection (docs/research/BOT_WEIGHTS_AND_GOALS.md Phase 1).
  // Replaces "nearest pickup wins" for WHICH item to fetch; the state ladder
  // above still decides WHETHER to fetch one.
  private readonly _itemGoalPlanner: ItemGoalPlanner;
  private readonly _goalArbiterMode: GoalArbiterMode;
  private _activeItemGoal: BotGoal | null = null;
  private _mandatoryGoal: BotGoal | null = null;
  private _sitePatrol: { goalId: string; target: Vec3; expires: number; pauseUntil: number } | null = null;
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
  private _goalMemoResult: BotGoal | null = null;

  constructor(difficulty: BotDifficulty, goalArbiterMode: GoalArbiterMode = defaultGoalArbiterMode()) {
    super(difficulty);
    this._goalArbiterMode = goalArbiterMode;
    // mistakeRate finally does something: an occasional runner-up pick.
    this._itemGoalPlanner = new ItemGoalPlanner(difficulty.mistakeRate);
    this._huntYaw = Math.random() * Math.PI * 2;
    this._sequenceRegistry.register(new RouteCrouchslideSequence());
    this._sequenceRegistry.register(new ValidatedJumpSequence());
    this._sequenceRegistry.register(new ItemSlideApproachSequence());
    this._sequenceRegistry.register(new TraverseTeleporterSequence());
    this._sequenceRegistry.register(new RouteStrafeJumpSequence());
    this._sequenceRegistry.register(new TraverseJumppadSequence());
    this._sequenceRegistry.register(new LearnedRouteSequence());
    this._sequenceRegistry.register(new SlideBladeSequence());
    this._sequenceRegistry.register(new LedgeSlideJumpSequence());
  }

  // ── Main Decision Loop ────────────────────────────────────────────

  // Store last vision result for use across state methods
  private _lastVision: VisionResult | null = null;
  private _lastBotVision: BotVision | null = null;
  private _activeNavStep: NavStep["type"] | null = null;
  private _pathBlockedReason: string | null = null;
  private _suppressTraversalAutomation: boolean = false;
  override getNavigationDebug(): string | null {
    const goal = this._mandatoryGoal
      ? `order=${this._mandatoryGoal.directive?.id}`
      : this._activeItemGoal
        ? this._itemGoalPlanner.explain
        : null;
    const sequence = this._sequenceRuntime.getDebug(this._lastDecisionTick);
    if (sequence) {
      const remaining = this._currentPath ? this._currentPath.steps.length - this._currentPath.cursor : 0;
      return `${sequence} remaining=${remaining}${goal ? ` ${goal}` : ""}`;
    }
    if (this._pathBlockedReason) return `blocked=${this._pathBlockedReason}${goal ? ` ${goal}` : ""}`;
    if (!this._currentPath || !this._activeNavStep) {
      // No path to describe, but a scored goal choice is still worth surfacing.
      return goal;
    }
    const remaining = this._currentPath.steps.length - this._currentPath.cursor;
    const nav = `step=${this._activeNavStep} remaining=${remaining}`;
    return goal ? `${nav} ${goal}` : nav;
  }

  isSequenceActive(): boolean {
    return this._sequenceRuntime.isActive;
  }

  isSequenceCommitted(): boolean {
    return this._sequenceRuntime.isCommitted(this._lastDecisionTick);
  }

  decide(
    state: BotGameState,
    vision?: BotVision | null,
    visionResult?: VisionResult | null,
    navGraph?: BotNavGraph | null,
  ): BotInput {
    this._cancelScript = false;
    const input = this._decide(state, vision, visionResult, navGraph);
    return this._cancelScript ? { ...input, cancelScript: true } : input;
  }

  private _decide(
    state: BotGameState,
    vision?: BotVision | null,
    visionResult?: VisionResult | null,
    navGraph?: BotNavGraph | null,
  ): BotInput {
    this._pathRecalcTimer++;
    this._lastVision = visionResult ?? null;
    this._lastDecisionTick = state.tick;
    this._lastBotVision = vision ?? null;
    this._navGraph = navGraph ?? null;

    // Dead → just wait (BotClient handles RequestSpawn)
    this._suppressTraversalAutomation = false;
    if (state.self.isDead) {
      this.currentState = BotState.SPAWN;
      this._interruptSequence(state, "dead", true);
      this._currentPath = null; // Clear path on death
      this._huntPatrolTarget = null;
      // Drop goal commitment too — the item that was worth crossing the map for
      // at 30 HP is a different proposition after respawning at 100.
      this._itemGoalPlanner.reset();
      this._activeItemGoal = null;
      this._mandatoryGoal = null;
      this._sitePatrol = null;
      this._combatMovement.reset();
      this._weaponCombos.reset();
      this._mood.endFight();
      this._readyWeapon = null;
      this._highGroundSpot = null;
      this._territory.reset();
      this._navigationProgress = null;
      this._recovery = null;
      // Clear vision cache on death
      if (vision) vision.clearCache();
      return this._noInput(state);
    }

    const mandatory = this._selectMandatoryGoal(state);
    if (mandatory?.id !== this._mandatoryGoal?.id) {
      this._currentPath = null;
      this._pathTarget = null;
      this._interruptSequence(state, "objective_changed", true);
    }
    this._mandatoryGoal = mandatory;
    const seesEnemy = this._lastVision ? this._lastVision.visibleEnemies.length > 0 : state.getNearestEnemy() !== null;
    if (seesEnemy || state.wasRecentlyDamaged(DODGE_REACT_TICKS)) this._recovery = null;
    if (this._recovery && state.tick < this._recovery.until && !mandatory) {
      if (vec3Length(vec3Subtract(this._recovery.target, state.self.position)) > 24) {
        const input = this._moveTowardPrecise(state, this._recovery.target);
        if (!state.self.isGrounded) input.buttons |= InputButtons.CROUCH;
        return input;
      }
      this._recovery = null;
    }
    if (
      !state.directives.some(
        (order) => `objective:${order.id}` === this._sitePatrol?.goalId && order.expiresAtTick > state.tick,
      )
    ) {
      this._sitePatrol = null;
    }

    // Determine state based on priority
    const newState = this._evaluateState(state);
    const stateChanged = newState !== this.currentState;
    if (this._sequenceRuntime.isActive && stateChanged) {
      this._interruptSequence(state, `state:${newState}`);
    }

    if (this._sequenceRuntime.isActive) {
      const sequenceInput = this._tickActiveSequence(state);
      if (sequenceInput) return this._recoverStalledNavigation(state, sequenceInput);
    }

    if (stateChanged) {
      const inCombat = (s: BotState) => s === BotState.FIGHT || s === BotState.CHASE || s === BotState.DODGE;
      if (newState === BotState.FIGHT && !inCombat(this.currentState)) {
        this._mood.startFight(state.tick, this.difficulty.mistakeRate);
      } else if (!inCombat(newState)) {
        this._mood.endFight();
      }
      this.currentState = newState;
      this._currentPath = null; // Clear path on state change
      this._huntPatrolTarget = null;
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

    input = this._recoverStalledNavigation(state, input);

    // Apply feeler raycasts for wall avoidance (navigation states only)
    if (
      vision &&
      !this._suppressTraversalAutomation &&
      this.currentState !== BotState.FIGHT &&
      this.currentState !== BotState.DODGE
    ) {
      input = this._applyFeelers(input, state, vision);
    }

    const chase = this.currentState === BotState.CHASE ? this._lastVision?.chaseTarget : null;
    if (chase && state.self.health >= 50)
      input = this._keepUpperGround(state, { position: chase.lastSeenPosition }, input);

    if (this.currentState !== BotState.FIGHT && this.currentState !== BotState.DODGE) {
      this._readyForHeard(state, input);
    }

    if (!this._suppressTraversalAutomation) {
      const ledgeJump = this._tryStartLedgeSlideJump(input, state);
      if (ledgeJump) return ledgeJump;
      const itemSlideInput = this._tryStartItemSlideApproach(input, state);
      if (itemSlideInput) return itemSlideInput;
      const routeSlideInput = this._tryStartRouteCrouchslide(input, state);
      if (routeSlideInput) return routeSlideInput;
      const strafeInput = this._tryStartRouteStrafeJump(input, state);
      if (strafeInput) return strafeInput;
    }

    return input;
  }

  // ── State Evaluation ──────────────────────────────────────────────

  private _evaluateState(state: BotGameState): BotState {
    // Non-interruptible work must reach the navigation executor before combat,
    // chase or item shopping can divert it. Death is handled by decide().
    if (this._mandatoryGoal) return BotState.ITEM_RUN;
    const recentlyDamaged = state.wasRecentlyDamaged(DODGE_REACT_TICKS);

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
      if (state.self.health < this._mood.retreatHealth(RETREAT_HEALTH_THRESHOLD)) {
        return BotState.RETREAT;
      }
      return BotState.DODGE;
    }

    // Priority 2: Enemy visible → fight
    if (hasVisibleEnemy && nearestVisibleEnemy && nearestVisibleEnemy.distance < FIGHT_RANGE) {
      return BotState.FIGHT;
    }

    // Priority 2.5: Lost sight of enemy but tracking them → chase!
    // ...unless this fight's mistake is to forget them the moment they are gone
    if (this._lastVision?.chaseTarget && this._mood.mistake(state.tick) !== "forget") {
      return BotState.CHASE;
    }

    // Priority 3: Low health → retreat to find health
    if (state.self.health < this._mood.retreatHealth(LOW_HEALTH_THRESHOLD)) {
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

    // Default: Hunt for enemies
    return BotState.HUNT;
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
    if (this._sequenceRuntime.isActive || state.tick < this._lungeRollAfterTick) return null;
    if (state.tick - this._lastSlideTick < SLIDE_COOLDOWN_TICKS) return null;
    if (state.self.health < LUNGE_MIN_HEALTH) return null;
    const context = { ...this._getSequenceContext(state, null), combatTarget: enemy };
    if (!canLunge(context, enemy)) return null;
    this._lungeRollAfterTick = state.tick + LUNGE_REROLL_TICKS;
    if (Math.random() >= lungeChance(this.difficulty.dodgeSkill)) return null;
    if (!this._sequenceRuntime.start("combat_slide_blade", context)) return null;
    return this._tickActiveSequence(state);
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
        : this._weaponCombos.choose(state, enemy, this.difficulty.predictionSkill, selectedWeaponId);
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
    const strafeInput = moves.strafe;
    if (strafeInput !== 0) this._strafeDirection = strafeInput;

    // Build buttons
    let buttons = 0;
    let wantsFire = this._hasAmmoForWeapon(state, selectedWeaponId);

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
      const chargeFire = this._updateChargedProjectileFire(state, enemy, selectedWeaponId, currentProfile);

      if (chargeFire.holdAltFire && wantsFire) {
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
      const aimsDownSights = currentProfile.aimsDownSights && wantsFire;
      if (aimsDownSights) buttons |= InputButtons.ALT_FIRE;
      if (!aimsDownSights || state.self.currentWeapon !== selectedWeaponId) this._adsSinceTick = null;
      else this._adsSinceTick ??= state.tick;
      const aimReady =
        currentProfile.adsReadyTicks === 0 ||
        (this._adsSinceTick !== null && state.tick - this._adsSinceTick >= currentProfile.adsReadyTicks);

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

    // Movement direction
    let forwardZ = 0;
    if (currentProfile.isMelee) {
      forwardZ = 1; // Always rush forward with melee
    } else if (enemy.distance > CLOSE_RANGE) {
      forwardZ = 1;
    } else if (enemy.distance < MELEE_RANGE || (currentProfile.hasSplash && enemy.distance < 250)) {
      forwardZ = -1;
    }
    let strafeX = strafeInput * 0.5;

    // With a splash weapon, take a ledge above the enemy when one is close
    const ledge = currentProfile.hasSplash ? this._highGround(state, enemy) : null;
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
      state.matchState.gametypeName.toLowerCase() !== "duel" ||
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
   * A ledge to fight from, looked for every two seconds while the bot has a
   * splash weapon and is not yet above the enemy. Dropped once reached.
   */
  private _highGround(state: BotGameState, enemy: VisiblePlayer): Vec3 | null {
    const self = state.self.position;
    if (this._highGroundSpot && Math.hypot(this._highGroundSpot.x - self.x, this._highGroundSpot.z - self.z) < 48) {
      this._highGroundSpot = null;
    }
    if (state.tick >= this._highGroundSearchTick) {
      this._highGroundSearchTick = state.tick + HIGH_GROUND_SEARCH_TICKS;
      const vision = this._lastBotVision;
      this._highGroundSpot =
        vision && this._navGraph && enemy.distance <= 900 && Math.random() < this.difficulty.dodgeSkill
          ? findHighGround(this._navGraph.nodes, self, enemy.position, (from, to) => vision.canSee(from, to))
          : null;
    }
    return this._highGroundSpot;
  }

  /**
   * Out of a fight, with an enemy heard close but not seen, get out the gun for
   * the distance they were heard at, so it is ready when they come round the
   * corner. Rolled every two seconds at `predictionSkill` odds.
   */
  private _readyForHeard(state: BotGameState, input: BotInput): void {
    if (this._readyWeapon && (state.tick >= this._readyWeapon.until || !has(state, this._readyWeapon.weapon))) {
      this._readyWeapon = null;
    }
    const heard = state.heardEnemies.reduce<VisiblePlayer | null>(
      (near, enemy) => (!near || enemy.distance < near.distance ? enemy : near),
      null,
    );
    if (!this._readyWeapon && heard && heard.distance <= READY_RANGE && state.tick >= this._readyRollTick) {
      this._readyRollTick = state.tick + READY_TICKS;
      if (Math.random() < this.difficulty.predictionSkill) {
        const { slot } = selectBestWeapon(
          state.self.weapons,
          state.self.ammo,
          state.self.currentWeapon,
          heard.distance,
        );
        const weapon = slot > 0 ? state.self.weapons[slot - 1] : state.self.currentWeapon;
        if (weapon) this._readyWeapon = { weapon, until: state.tick + READY_TICKS };
      }
    }
    if (this._readyWeapon && (input.weaponSlot ?? 0) === 0) input.weaponSlot = slotFor(state, this._readyWeapon.weapon);
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

    const targetChanged = this._chargeTargetId !== enemy.playerId;
    const weaponChanged = this._chargeWeaponId !== weaponId;
    if (targetChanged || weaponChanged || this._chargeStartTick === null || this._chargeReleaseTick === null) {
      this._chargeWeaponId = weaponId;
      this._chargeTargetId = enemy.playerId;
      this._chargeStartTick = state.tick;

      const chargeSpan = Math.max(0, profile.chargeMaxTicks - profile.chargeMinTicks);
      const skillHold = 0.35 + this.difficulty.predictionSkill * 0.4;
      const jitter = (Math.random() - 0.5) * 0.15;
      const holdTicks = Math.round(profile.chargeMinTicks + chargeSpan * Math.max(0, Math.min(1, skillHold + jitter)));
      this._chargeReleaseTick = state.tick + Math.max(profile.chargeMinTicks, holdTicks);
      return { holdAltFire: true };
    }

    if (state.tick >= this._chargeReleaseTick) {
      this._clearChargedProjectileFire();
      return { holdAltFire: false };
    }

    return { holdAltFire: true };
  }

  private _clearChargedProjectileFire(): void {
    this._chargeWeaponId = null;
    this._chargeTargetId = null;
    this._chargeStartTick = null;
    this._chargeReleaseTick = null;
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
        : this._navigateTo(state, territory ?? target.predictedPosition, false);
    if (holdUpper) {
      input.moveYaw = travelYaw(input);
      input.yaw = Math.atan2(
        target.predictedPosition.x - state.self.position.x,
        target.predictedPosition.z - state.self.position.z,
      );
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

  // ── RETREAT State ─────────────────────────────────────────────────

  private _executeRetreat(state: BotGameState): BotInput {
    // Scored choice among HEALTH ONLY. Retreating is a specific intent, so the
    // candidate set is filtered rather than left open — but within health the
    // arbiter still beats "nearest": it accounts for overcap (a bubble at 98 HP
    // is worthless), route cost, and mega vs. medium.
    const healthGoal = this._selectItemGoal(state, RETREAT_ITEM_TYPES, true);
    if (healthGoal) return this._navigateTo(state, healthGoal.position, true);

    // Try NavGraph path to nearest health (cached via _navigateToItem)
    if (this._navGraph) {
      const result = this._navigateToItem(state, "health", true);
      if (result) return result;
    }

    // Try vision's cover finding
    if (this._lastVision?.nearestCover) {
      return this._navigateTo(state, this._lastVision.nearestCover, true);
    }

    // Try nearest health item from BSP knowledge
    if (this._lastBotVision) {
      const healthPos = this._lastBotVision.findNearestItem(state.self.position, "health", state.pickupActiveMask);
      if (healthPos) {
        return this._navigateTo(state, healthPos, true);
      }
    }

    // Find nearest pickup (prefer health)
    const pickup = state.getNearestPickup(PICKUP_SEEK_RANGE);
    if (pickup) {
      return this._navigateTo(state, pickup.position, true);
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
    if (this._mandatoryGoal) {
      const goal = this._mandatoryGoal;
      this._activeItemGoal = goal;
      return this._navigateGoal(state, goal, true);
    }
    // Scored choice first: value, denial, route and danger decide which item,
    // instead of the fixed weapon > health > armor > ammo ordering below (which
    // took the nearest of whichever type came first, so a 5 HP bubble could
    // outrank Red Armor). Falls through to the legacy path when disabled or
    // when nothing scores.
    const goal = this._selectItemGoal(state);
    // Only a DIRECTIVE goal holds on arrival. An item goal has to be touched,
    // and a bot that stops next to a Red Armor never picks it up.
    if (goal) {
      const territory =
        !goal.directive && goal.position.y < state.self.position.y - 48 ? this._duelTerritory(state) : null;
      return territory ? this._navigateTo(state, territory, false) : this._navigateGoal(state, goal, false);
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
        return this._navigateTo(state, reachable.pickup.position, false);
      }
    }

    // Try BSP-known item positions
    if (this._lastBotVision) {
      const weaponPos = this._lastBotVision.findNearestItem(state.self.position, "weapon", state.pickupActiveMask);
      if (weaponPos) {
        return this._navigateTo(state, weaponPos, false);
      }
    }

    // Fallback to raw state pickups
    const pickup = state.getNearestPickup(PICKUP_SEEK_RANGE);
    if (pickup) {
      return this._navigateTo(state, pickup.position, false);
    }

    // No pickups found → hunt
    return this._executeHunt(state);
  }

  // ── HUNT State ────────────────────────────────────────────────────

  private _executeHunt(state: BotGameState): BotInput {
    this._huntTimer++;

    const territory = this._duelTerritory(state);
    if (territory) return this._navigateTo(state, territory, false);

    // Prefer a scored goal over aimless patrol. Reached when the ladder falls
    // through to HUNT but the arbiter still has something worth doing — an
    // objective, or an item that did not meet _shouldSeekItems' cruder bar.
    const goal = this._selectItemGoal(state);
    if (goal) return this._navigateGoal(state, goal, false);

    // Check if we know a last enemy position to investigate
    const huntTarget = this._getHuntTarget(state);
    if (huntTarget) {
      return this._navigateTo(state, huntTarget, false);
    }

    // NavGraph patrol: pick a random nav node to walk toward
    if (this._navGraph) {
      const nodes = this._navGraph.nodes;
      if (nodes.length > 0 && (!this._huntPatrolTarget || this._pathRecalcTimer > PATH_RECALC_INTERVAL * 2)) {
        const randomNode = nodes[Math.floor(Math.random() * nodes.length)];
        this._huntPatrolTarget = randomNode.position;
        this._pathRecalcTimer = 0;
      }
      if (this._huntPatrolTarget) {
        // Check if we've arrived at patrol target
        const distToPatrol = vec3Length(vec3Subtract(this._huntPatrolTarget, state.self.position));
        if (distToPatrol < PATH_ARRIVED_THRESHOLD) {
          this._huntPatrolTarget = null; // Pick new target next tick
          this._currentPath = null;
        } else {
          return this._navigateTo(state, this._huntPatrolTarget, false);
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

  private _getFireOrigin(state: BotGameState): Vec3 {
    return {
      x: state.self.position.x,
      y: state.self.position.y + DEFAULT_VIEWHEIGHT,
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
    const radius = this._holdRadius(goal, state);
    // Planting and defusing use move_to: those orders must stay still on arrival.
    const patrol = goal.directive?.kind === "defend" || goal.directive?.kind === "hold_area";
    if (patrol && radius !== undefined && vec3Length(vec3Subtract(goal.position, state.self.position)) <= radius) {
      return this._patrolSite(state, goal, radius);
    }
    this._sitePatrol = null;
    const timed = !goal.directive && goal.respawnTick !== undefined && goal.respawnTick > state.tick;
    if (timed && radius !== undefined && vec3Length(vec3Subtract(goal.position, state.self.position)) <= radius) {
      if (state.matchState.gametypeName.toLowerCase() === "duel") {
        const patrol = this._duelTerritory(state, goal.position);
        return patrol ? this._navigateTo(state, patrol, false) : this._startRecovery(state);
      }
      return this._watchEntrances(state, goal.position);
    }
    return this._navigateTo(state, goal.position, urgent, radius);
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
      this._getNavPathOptions(state.tick),
      center,
    );
  }

  /** Recover from a route that issues commands without actually going anywhere. */
  private _recoverStalledNavigation(state: BotGameState, input: BotInput): BotInput {
    if (
      this._mandatoryGoal ||
      this._activeItemGoal?.directive ||
      this.currentState === BotState.FIGHT ||
      this.currentState === BotState.DODGE
    ) {
      this._navigationProgress = null;
      return input;
    }
    const progress = this._navigationProgress;
    const position = state.self.position;
    if (
      !progress ||
      state.tick < progress.tick ||
      Math.hypot(position.x - progress.position.x, position.z - progress.position.z) > 32 ||
      (state.self.isGrounded && Math.abs(position.y - progress.position.y) > 48)
    ) {
      this._navigationProgress = { position: { ...position }, tick: state.tick };
    } else if (state.tick - progress.tick >= 250 && (state.self.isGrounded || Math.abs(state.self.velocity.y) < 50)) {
      return this._startRecovery(state);
    }
    return input;
  }

  private _startRecovery(state: BotGameState): BotInput {
    this._cancelScript = true;
    const step = this._activeSequenceStep ?? this._currentPath?.steps[this._currentPath.cursor];
    if (step) this._cooldownNavStep(step, state.tick);
    if (this.currentState !== BotState.CHASE && this._activeItemGoal?.pickupId !== undefined)
      this._blockedPickupIds.set(this._activeItemGoal.pickupId, state.tick + PICKUP_FAILURE_COOLDOWN_TICKS);
    this._interruptSequence(state, "no_navigation_progress", true);
    this._itemGoalPlanner.reset();
    this._activeItemGoal = null;
    this._currentPath = null;
    this._pathTarget = null;
    this._huntPatrolTarget = null;
    this._territory.reset();
    this._navigationProgress = { position: { ...state.self.position }, tick: state.tick };
    const self = state.self.position;
    const away = step ? Math.atan2(self.x - step.to.position.x, self.z - step.to.position.z) : state.self.yaw + Math.PI;
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
        this._recovery = { target, until: state.tick + 125 };
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
  private _watchEntrances(state: BotGameState, item: Vec3): BotInput {
    const input = this._holdPosition(state, item);
    const graph = this._navGraph;
    const node = graph?.findNearestNode(item);
    if (!graph || !node) return input;
    const ways = graph.edges
      .filter((edge) => edge.to === node.id && edge.from !== node.id)
      .map((edge) => graph.nodes.find((n) => n.id === edge.from)?.position)
      .filter((position): position is Vec3 => position !== undefined)
      .filter((position) => vec3Length(vec3Subtract(position, state.self.position)) > 64);
    if (ways.length === 0) return input;
    const way = ways[Math.floor(state.tick / ENTRANCE_WATCH_TICKS) % ways.length];
    input.yaw = Math.atan2(way.x - state.self.position.x, way.z - state.self.position.z);
    return input;
  }

  private _patrolSite(state: BotGameState, goal: BotGoal, radius: number): BotInput {
    // These are verified walking segments, not approaches to a traversal trick.
    this._suppressTraversalAutomation = true;
    const vision = this._lastBotVision;
    if (!vision || !this._navGraph) return this._holdPosition(state, goal.position);
    const previous = this._sitePatrol;
    if (previous?.goalId === goal.id && state.tick < previous.expires) {
      if (vec3Length(vec3Subtract(previous.target, state.self.position)) <= 48) {
        if (!previous.pauseUntil) previous.pauseUntil = state.tick + 125;
        if (state.tick < previous.pauseUntil) return this._holdPosition(state, goal.position);
      } else if (vision.isWalkable(state.self.position, previous.target)) {
        return this._moveTowardPrecise(state, previous.target);
      }
    }
    // Use sampled standing surfaces, with a clear hull sweep and supported floor.
    // Straight segments inside the site's sphere cannot wander off to another site.
    const candidates = this._navGraph.nodes
      .filter((node) => node.type === "floor" || node.type === "spawn")
      .map((node) => ({ ...node.position, y: node.position.y + (node.type === "floor" ? 24 : 0) }))
      .filter(
        (position) =>
          vec3Length(vec3Subtract(position, goal.position)) <= radius &&
          vec3Length(vec3Subtract(position, state.self.position)) >= 96 &&
          Math.abs(position.y - state.self.position.y) <= 40 &&
          (!previous || vec3Length(vec3Subtract(position, previous.target)) > 48) &&
          vision.isWalkable(state.self.position, position),
      );
    if (!candidates.length) {
      this._sitePatrol = null;
      return this._holdPosition(state, goal.position);
    }
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    this._sitePatrol = { goalId: goal.id, target, expires: state.tick + 1000, pauseUntil: 0 };
    return this._moveTowardPrecise(state, target);
  }

  private _navigateTo(state: BotGameState, target: Vec3, urgent: boolean, holdRadius?: number): BotInput {
    // Arrived, and the goal is a PLACE TO BE rather than a thing to touch.
    //
    // Everything else in this brain deliberately never sends a zero direction
    // (see `_moveToward`), which means a bot is always running. That is right
    // for fetching items and wrong for objectives: Search & Destroy plants only
    // below 400 ups and arms only while you stay within 100 units of the bomb,
    // so a bot that cannot stop cannot plant, cannot arm, and cannot defuse.
    // Holding is the behaviour that makes objective modes playable at all.
    if (holdRadius !== undefined && vec3Length(vec3Subtract(target, state.self.position)) <= holdRadius) {
      return this._holdPosition(state, target);
    }

    if (!this._navGraph) {
      return this._moveToward(state, target, urgent);
    }

    // Recalculate path periodically or if target changed significantly
    const targetChanged = !this._pathTarget || vec3Length(vec3Subtract(target, this._pathTarget)) > 200;

    if (targetChanged || !this._currentPath || this._pathRecalcTimer > PATH_RECALC_INTERVAL) {
      this._currentPath = this._navGraph.findPath(state.self.position, target, this._getNavPathOptions(state.tick));
      this._pathTarget = target;
      this._pathRecalcTimer = 0;
    }

    // If path found, follow waypoints
    if (this._currentPath) {
      const result = this._followCurrentPath(state, urgent);
      if (result.status === "moving") return result.input;
      if (result.status === "blocked") {
        if (holdRadius === undefined) return this._startRecovery(state);
        this._currentPath = null;
        return this._moveToward(state, target, urgent);
      }
      // Path complete — clear it
      this._currentPath = null;
    }

    // No path found — fall back to direct movement
    return this._moveToward(state, target, urgent);
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
   * nothing.
   */
  private _selectItemGoal(
    state: BotGameState,
    typeFilter?: ReadonlySet<string>,
    ignoreDirectives = false,
  ): BotGoal | null {
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
    for (const [pickupId, retryTick] of this._blockedPickupIds) {
      if (state.tick >= retryTick) this._blockedPickupIds.delete(pickupId);
    }

    const result = this._itemGoalPlanner.select(state, {
      pickupPositions: pickupPositions ?? [],
      maxDistance: PICKUP_SEEK_RANGE,
      blockedPickupIds: new Set(this._blockedPickupIds.keys()),
      typeFilter,
      ignoreDirectives,
      // Real graph distances when the map's nav graph is loaded, so an item
      // behind a wall is gated as unreachable instead of looking close.
      navGraph: this._navGraph,
    });

    this._activeItemGoal = result.goal;
    this._goalMemoTick = state.tick;
    this._goalMemoKey = memoKey;
    this._goalMemoResult = result.goal;
    if (this._goalArbiterMode === "verbose" && result.goal) {
      console.log(`[bot] ${result.explain}`);
    }
    return result.goal;
  }

  private _navigateToItem(state: BotGameState, itemType: string, urgent: boolean): BotInput | null {
    if (!this._navGraph) return null;

    const goalPickupId = this._currentPath?.nodes[this._currentPath.nodes.length - 1]?.pickupId;
    if (
      goalPickupId !== undefined &&
      (state.pickupActiveMask[goalPickupId] === false || this._blockedPickupIds.has(goalPickupId))
    ) {
      this._currentPath = null;
      this._pathTarget = null;
      this._pathRecalcTimer = PATH_RECALC_INTERVAL + 1;
    }

    // Only recalculate item paths periodically
    if (!this._currentPath || this._pathRecalcTimer > PATH_RECALC_INTERVAL) {
      const itemPath = this._navGraph.findPathToItem(
        state.self.position,
        itemType,
        state.pickupActiveMask,
        this._getNavPathOptions(state.tick),
      );
      if (!itemPath) return null;
      this._currentPath = itemPath;
      this._pathTarget = itemPath.nodes[itemPath.nodes.length - 1]?.position ?? null;
      this._pathRecalcTimer = 0;
    }

    if (this._currentPath) {
      const result = this._followCurrentPath(state, urgent);
      if (result.status === "moving") return result.input;
      if (result.status === "blocked") return this._startRecovery(state);
      // Arrived at item — clear path
      this._currentPath = null;
    }

    return null;
  }

  private _getNavPathOptions(tick: number): NavPathOptions {
    for (const [key, retryTick] of this._blockedNavEdges) {
      if (tick >= retryTick) this._blockedNavEdges.delete(key);
    }
    for (const [pickupId, retryTick] of this._blockedPickupIds) {
      if (tick >= retryTick) this._blockedPickupIds.delete(pickupId);
    }
    return {
      blockedEdgeKeys: new Set(this._blockedNavEdges.keys()),
      blockedPickupIds: new Set(this._blockedPickupIds.keys()),
      canWalkTo: this._lastBotVision ? (from, to) => this._lastBotVision?.isWalkable(from, to) ?? true : undefined,
    };
  }

  private _cooldownNavStep(step: NavStep, tick: number): void {
    this._blockedNavEdges.set(navEdgeKey(step.from.id, step.to.id, step.type), tick + NAV_EDGE_FAILURE_COOLDOWN_TICKS);
  }

  private _getSequenceContext(
    state: BotGameState,
    step: NavStep | null = this._activeSequenceStep,
    proposedInput: BotInput | null = null,
    crouchslideReady: boolean = false,
    routeStrafeReady: boolean = false,
    routeStrafeSide: -1 | 1 = this._routeStrafeSide,
  ) {
    const opportunity =
      step?.opportunityId && this._navGraph ? this._navGraph.getMovementOpportunity(step.opportunityId) : null;
    return {
      state,
      vision: this._lastBotVision,
      visionResult: this._lastVision,
      navGraph: this._navGraph,
      navStep: step,
      movementOpportunity: opportunity,
      learnedRoute: this._navGraph?.getLearnedRoute(step?.opportunityId) ?? null,
      proposedInput,
      difficulty: this.difficulty,
      crouchslideReady,
      routeStrafeReady,
      routeStrafeSide,
      itemSlideTarget: this._activeItemSlideTarget,
      itemSlideReady: this._activeItemSlideTarget !== null,
    };
  }

  private _interruptSequence(state: BotGameState, reason: string, force: boolean = false): boolean {
    const interrupted = this._sequenceRuntime.interrupt(this._getSequenceContext(state), reason, force);
    if (interrupted) {
      this._cancelScript = true;
      this._activeSequenceStep = null;
      this._activeItemSlideTarget = null;
    }
    return interrupted;
  }

  private _tickActiveSequence(state: BotGameState): BotInput | null {
    const result: BotSequenceRuntimeTick | null = this._sequenceRuntime.tick(this._getSequenceContext(state));
    if (!result) return null;

    this._suppressTraversalAutomation = true;
    this._pathRecalcTimer = 0;
    if (result.status === "running") return result.input;
    this._cancelScript = true;

    const terminalItemTarget = this._activeItemSlideTarget;
    this._activeItemSlideTarget = null;
    if (result.sequenceId === "item_slide_approach" && terminalItemTarget) {
      if (result.status === "succeeded") {
        this._currentPath = null;
      } else if (result.reason === "pickup_missed" || result.reason === "timeout") {
        this._blockedPickupIds.set(terminalItemTarget.pickupId, state.tick + PICKUP_FAILURE_COOLDOWN_TICKS);
        this._currentPath = null;
      }
      return null;
    }

    const terminalStep = this._activeSequenceStep;
    this._activeSequenceStep = null;
    this._activeNavStep = null;
    if (result.status === "failed") {
      if (terminalStep) {
        this._pathBlockedReason = `sequence:${result.sequenceId}:${result.reason ?? "failed"}`;
        this._cooldownNavStep(terminalStep, state.tick);
        this._currentPath = null;
        return this._startRecovery(state);
      }
      return null;
    }
    return null;
  }

  private _startNavSequence(state: BotGameState, step: NavStep, sequenceId: string): PathFollowResult | null {
    const context = this._getSequenceContext(state, step);
    if (!this._sequenceRuntime.start(sequenceId, context)) return null;

    this._activeSequenceStep = step;
    const input = this._tickActiveSequence(state);
    if (this._pathBlockedReason) return { status: "blocked", reason: this._pathBlockedReason };
    return input ? { status: "moving", input } : { status: "complete" };
  }

  /** Execute one traversal-aware step from the current A* path. */
  private _followCurrentPath(state: BotGameState, urgent: boolean): PathFollowResult {
    if (!this._navGraph || !this._currentPath) return { status: "complete" };

    const step = this._navGraph.getNextStep(state.self.position, this._currentPath, PATH_ARRIVED_THRESHOLD);
    if (!step) {
      this._activeNavStep = null;
      this._pathBlockedReason = null;
      return { status: "complete" };
    }

    this._activeNavStep = step.type;
    this._pathBlockedReason = null;
    const distanceToStart = vec3Length(vec3Subtract(step.from.position, state.self.position));

    if (step.type === "teleporter") {
      const sequenceResult = this._startNavSequence(state, step, "nav_traverse_teleporter");
      if (sequenceResult) return sequenceResult;
      return { status: "blocked", reason: "teleporter:missing_trigger_metadata" };
    }

    if (step.type === "jumppad") {
      const sequenceResult = this._startNavSequence(state, step, "nav_traverse_jumppad");
      if (sequenceResult) return sequenceResult;
      return { status: "blocked", reason: "jumppad:missing_trigger_metadata" };
    }

    if (step.type === "fall") {
      const probe = this._lastBotVision?.probeDrop(step.from.position, step.to.position);
      if (probe && !probe.safe) {
        this._cooldownNavStep(step, state.tick);
        this._pathBlockedReason = `fall:${probe.reason}`;
        this._activeNavStep = null;
        this._currentPath = null;
        return { status: "blocked", reason: this._pathBlockedReason };
      }

      const boost = this._tryStartLedgeSlideJump(this._moveToward(state, step.to.position, urgent), state);
      if (boost) return { status: "moving", input: boost };

      this._suppressTraversalAutomation = true;
      const target = distanceToStart > 56 ? step.from.position : (probe?.landing ?? step.to.position);
      return { status: "moving", input: this._moveTowardPrecise(state, target) };
    }

    if (step.type === "jump") {
      const boost = this._tryStartLedgeSlideJump(this._moveToward(state, step.to.position, urgent), state);
      if (boost) return { status: "moving", input: boost };
    }

    // A learned route is a script, not a jump: run it or not at all. Falling
    // through to the blind jump below drops the bot off the ledge it was
    // meant to wall-jump from.
    if (step.type === "jump" && this._navGraph?.getLearnedRoute(step.opportunityId)) {
      const sequenceResult = this._startNavSequence(state, step, "nav_learned_route");
      if (sequenceResult) return sequenceResult;
      return { status: "blocked", reason: "learned_route:not_started" };
    }

    if (step.type === "jump" && step.validated && step.opportunityId) {
      const sequenceResult = this._startNavSequence(state, step, "nav_validated_jump");
      if (sequenceResult) return sequenceResult;
    }

    const input = this._moveToward(state, step.to.position, urgent);
    if (step.type === "jump" && state.self.isGrounded && distanceToStart < 180) {
      input.buttons |= InputButtons.JUMP;
    }

    const distanceToEnd = vec3Length(vec3Subtract(step.to.position, state.self.position));
    if (step.requiresPreciseApproach && distanceToEnd < 256) {
      this._suppressTraversalAutomation = true;
      return { status: "moving", input: this._makePrecise(input) };
    }

    this._lookAlongRoute(input, state, this._currentPath);
    return { status: "moving", input };
  }

  /**
   * Look a little way along the route rather than at the next waypoint, as a
   * player does: the view eases round corners before reaching them instead of
   * swinging at each node. Movement still heads for the waypoint.
   */
  private _lookAlongRoute(input: BotInput, state: BotGameState, path: NavPath): void {
    const self = state.self.position;
    let from = { x: self.x, z: self.z };
    let left = ROUTE_LOOK_AHEAD;
    for (let i = path.cursor; i < path.steps.length && left > 0; i++) {
      const step = path.steps[i];
      if (i > path.cursor && step.type !== "walk") break; // a jump or pad is looked at when reached
      const to = step.to.position;
      const length = Math.hypot(to.x - from.x, to.z - from.z);
      if (length >= left) {
        from = { x: from.x + ((to.x - from.x) * left) / length, z: from.z + ((to.z - from.z) * left) / length };
        break;
      }
      left -= length;
      from = { x: to.x, z: to.z };
    }
    const dx = from.x - self.x;
    const dz = from.z - self.z;
    if (Math.hypot(dx, dz) < ROUTE_LOOK_MIN_DISTANCE) return;
    const lookYaw = Math.atan2(dx, dz);
    const heading = input.yaw;
    if (Math.abs(Math.atan2(Math.sin(lookYaw - heading), Math.cos(lookYaw - heading))) > Math.PI / 2) return;
    input.moveYaw = heading;
    input.yaw = lookYaw;
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

  /** Slide only when a stable, active pickup closes a straight final walk lane. */
  private _tryStartItemSlideApproach(input: BotInput, state: BotGameState): BotInput | null {
    if (
      state.self.isDead ||
      this._sequenceRuntime.isActive ||
      (this.currentState !== BotState.ITEM_RUN && this.currentState !== BotState.RETREAT) ||
      !state.self.isGrounded ||
      state.self.isSliding
    )
      return null;

    const required = InputButtons.FORWARD | InputButtons.SPRINT;
    const disallowed =
      InputButtons.BACK | InputButtons.CROUCH | InputButtons.JUMP | InputButtons.FIRE | InputButtons.ALT_FIRE;
    if ((input.buttons & required) !== required || (input.buttons & disallowed) !== 0) return null;

    const horizontalSpeed = Math.hypot(state.self.velocity.x, state.self.velocity.z);
    if (!canInitiateSlide(horizontalSpeed, state.tick >= this._slideCooldownUntilTick)) return null;

    const path = this._currentPath;
    const step = path?.steps[path.cursor] ?? null;
    const target = path?.nodes[path.nodes.length - 1] ?? null;
    if (!path || !step || !target || target.type !== "item" || target.pickupId === undefined) return null;
    if (step.type !== "walk" || path.cursor !== path.steps.length - 1) return null;
    if (state.pickupActiveMask[target.pickupId] !== true || this._blockedPickupIds.has(target.pickupId)) return null;

    const targetDelta = vec3Subtract(target.position, state.self.position);
    const targetDistance = Math.hypot(targetDelta.x, targetDelta.z);
    const maximumDistance = Math.min(
      ITEM_SLIDE_MAX_DISTANCE,
      horizontalSpeed * PHYSICS.SLIDE_SPEED_MULT * (PHYSICS.SLIDE_DURATION / 1000) + 120,
    );
    if (targetDistance < ITEM_SLIDE_MIN_DISTANCE || targetDistance > maximumDistance || Math.abs(targetDelta.y) > 96)
      return null;

    const targetDirection = vec3Normalize({ x: targetDelta.x, y: 0, z: targetDelta.z });
    if (horizontalSpeed > 0.001) {
      const velocityDot =
        (state.self.velocity.x * targetDirection.x + state.self.velocity.z * targetDirection.z) / horizontalSpeed;
      if (Math.acos(Math.max(-1, Math.min(1, velocityDot))) > ITEM_SLIDE_MAX_VELOCITY_ERROR_RADIANS) return null;
    }

    const allyBlocksLane = state.players.some((player) => {
      if (player.relation !== "ally" || player.isDead) return false;
      const relative = vec3Subtract(player.position, state.self.position);
      const along = relative.x * targetDirection.x + relative.z * targetDirection.z;
      const lateral = Math.abs(relative.x * targetDirection.z - relative.z * targetDirection.x);
      return Math.abs(relative.y) <= 96 && along > 0 && along < targetDistance && lateral < ITEM_SLIDE_ALLY_RADIUS;
    });
    if (allyBlocksLane) return null;

    this._activeItemSlideTarget = { pickupId: target.pickupId, position: { ...target.position } };
    const context = this._getSequenceContext(state, step, input);
    if (!this._sequenceRuntime.start("item_slide_approach", context)) {
      this._activeItemSlideTarget = null;
      return null;
    }
    this._slideCooldownUntilTick = state.tick + BOT_SLIDE_COOLDOWN_TICKS;
    return this._tickActiveSequence(state);
  }

  /**
   * Optional route-speed sequence that rejects unsafe geometry and preserves
   * the state-machine fallback when authoritative slide entry is not confirmed.
   * Runs after brain decision — adjusts heading, doesn't override state.
   */
  private _tryStartLedgeSlideJump(input: BotInput, state: BotGameState): BotInput | null {
    if (
      !this._lastBotVision ||
      !state.self.isGrounded ||
      this._sequenceRuntime.isActive ||
      this.difficulty.strafeJumpSkill < 0.55 ||
      state.tick < this._ledgeProbeTick ||
      state.tick < this._slideCooldownUntilTick ||
      (input.buttons & (InputButtons.FIRE | InputButtons.ALT_FIRE)) !== 0 ||
      (input.buttons & (InputButtons.FORWARD | InputButtons.SPRINT)) !== (InputButtons.FORWARD | InputButtons.SPRINT)
    )
      return null;
    const path = this._currentPath;
    const step = path?.steps[path.cursor];
    if (!path || !step) return null;
    const next = step.type === "walk" ? path.steps[path.cursor + 1] : step;
    if (!next || (next.type !== "fall" && next.type !== "jump")) return null;
    this._ledgeProbeTick = state.tick + 31;
    const plan = planLedgeSlideJump(state.self, input, next.to.position, this._lastBotVision.collisionWorld);
    if (!plan) return null;
    const context = { ...this._getSequenceContext(state, step, input), ledgeSlidePlan: plan };
    if (!this._sequenceRuntime.start("ledge_slide_jump", context)) return null;
    this._activeSequenceStep = next;
    this._slideCooldownUntilTick = state.tick + BOT_SLIDE_COOLDOWN_TICKS;
    return this._tickActiveSequence(state);
  }

  private _tryStartRouteCrouchslide(input: BotInput, state: BotGameState): BotInput | null {
    if (state.self.isDead || this._sequenceRuntime.isActive) return null;
    const movingForward = (input.buttons & InputButtons.FORWARD) !== 0 && (input.buttons & InputButtons.BACK) === 0;
    const sprinting = (input.buttons & InputButtons.SPRINT) !== 0;
    const horizontalSpeed = Math.sqrt(state.self.velocity.x ** 2 + state.self.velocity.z ** 2);
    const cooldownExpired = state.tick >= this._slideCooldownUntilTick;

    if (
      !state.self.isGrounded ||
      !movingForward ||
      !sprinting ||
      (input.buttons & (InputButtons.FIRE | InputButtons.ALT_FIRE)) !== 0 ||
      !canInitiateSlide(horizontalSpeed, cooldownExpired)
    ) {
      return null;
    }

    const navigationSlide =
      this.currentState === BotState.HUNT ||
      this.currentState === BotState.ITEM_RUN ||
      this.currentState === BotState.RETREAT ||
      this.currentState === BotState.CHASE;
    const dodgeSlide = this.currentState === BotState.DODGE && this.difficulty.dodgeSkill >= 0.35;

    if (!navigationSlide && !dodgeSlide) return null;

    const step = this._currentPath?.steps[this._currentPath.cursor] ?? null;
    if (this._currentPath && !step) return null;
    if (step) {
      if (step.type !== "walk" || step.requiresPreciseApproach) return null;
      const remaining = vec3Length(vec3Subtract(step.to.position, state.self.position));
      if (remaining < ROUTE_SLIDE_MIN_REMAINING_DISTANCE) return null;

      const nextStep = this._currentPath?.steps[this._currentPath.cursor + 1] ?? null;
      if (remaining < ROUTE_SLIDE_LOOKAHEAD_DISTANCE && nextStep) {
        if (nextStep.type !== "walk" || nextStep.requiresPreciseApproach) return null;
        const currentDirection = vec3Normalize(vec3Subtract(step.to.position, state.self.position));
        const nextDirection = vec3Normalize(vec3Subtract(nextStep.to.position, step.to.position));
        const dot = Math.max(
          -1,
          Math.min(1, currentDirection.x * nextDirection.x + currentDirection.z * nextDirection.z),
        );
        if (Math.acos(dot) > ROUTE_SLIDE_MAX_TURN_RADIANS) return null;
      }
    }

    const context = this._getSequenceContext(state, step, input, true);
    if (!this._sequenceRuntime.start("route_crouchslide", context)) return null;
    this._slideCooldownUntilTick = state.tick + BOT_SLIDE_COOLDOWN_TICKS;
    return this._tickActiveSequence(state);
  }

  /**
   * Starts one speed-building hop only after the route planner has established
   * enough straight, unoccupied walk space. Re-running this gate on every
   * landing creates a chain without hiding route changes inside the sequence.
   */
  private _tryStartRouteStrafeJump(input: BotInput, state: BotGameState): BotInput | null {
    if (
      state.self.isDead ||
      this._sequenceRuntime.isActive ||
      state.tick < this._routeStrafeCooldownUntilTick ||
      this.difficulty.strafeJumpSkill < 0.35
    ) {
      return null;
    }

    const navigationState =
      this.currentState === BotState.HUNT ||
      this.currentState === BotState.ITEM_RUN ||
      this.currentState === BotState.RETREAT ||
      this.currentState === BotState.CHASE;
    if (!navigationState || !state.self.isGrounded || state.self.isSliding) return null;

    const required = InputButtons.FORWARD | InputButtons.SPRINT;
    const disallowed =
      InputButtons.BACK |
      InputButtons.LEFT |
      InputButtons.RIGHT |
      InputButtons.CROUCH |
      InputButtons.FIRE |
      InputButtons.ALT_FIRE;
    if ((input.buttons & required) !== required || (input.buttons & disallowed) !== 0) return null;

    const path = this._currentPath;
    const step = path?.steps[path.cursor] ?? null;
    if (!path || !step || step.type !== "walk" || step.requiresPreciseApproach) return null;

    const routeDelta = vec3Subtract(step.to.position, state.self.position);
    const remaining = Math.hypot(routeDelta.x, routeDelta.z);
    const minRemaining =
      this.currentState === BotState.ITEM_RUN && path.cursor === path.steps.length - 1
        ? ROUTE_STRAFE_ITEM_MIN_REMAINING_DISTANCE
        : ROUTE_STRAFE_MIN_REMAINING_DISTANCE;
    if (remaining < minRemaining) return null;

    const routeDirection = vec3Normalize({ x: routeDelta.x, y: 0, z: routeDelta.z });
    const horizontalSpeed = Math.hypot(state.self.velocity.x, state.self.velocity.z);
    if (horizontalSpeed < PHYSICS.SPRINT_SPEED) return null;
    if (horizontalSpeed > 0.001) {
      const velocityDotRoute =
        (state.self.velocity.x * routeDirection.x + state.self.velocity.z * routeDirection.z) / horizontalSpeed;
      const velocityError = Math.acos(Math.max(-1, Math.min(1, velocityDotRoute)));
      if (velocityError > ROUTE_STRAFE_MAX_VELOCITY_ERROR_RADIANS) return null;
    }

    const nextStep = path.steps[path.cursor + 1] ?? null;
    if (remaining < ROUTE_STRAFE_LOOKAHEAD_DISTANCE && nextStep) {
      if (nextStep.type !== "walk" || nextStep.requiresPreciseApproach) return null;
      const nextDirection = vec3Normalize(vec3Subtract(nextStep.to.position, step.to.position));
      const turnDot = Math.max(
        -1,
        Math.min(1, routeDirection.x * nextDirection.x + routeDirection.z * nextDirection.z),
      );
      if (Math.acos(turnDot) > ROUTE_STRAFE_MAX_TURN_RADIANS) return null;
    }

    const allyBlocksRoute = state.players.some((player) => {
      if (player.relation !== "ally" || player.isDead) return false;
      const relative = vec3Subtract(player.position, state.self.position);
      if (Math.abs(relative.y) > 96) return false;
      const along = relative.x * routeDirection.x + relative.z * routeDirection.z;
      if (along <= 0 || along >= Math.min(remaining, ROUTE_STRAFE_ALLY_LOOKAHEAD)) return false;
      const lateral = Math.abs(relative.x * routeDirection.z - relative.z * routeDirection.x);
      return lateral < ROUTE_STRAFE_ALLY_RADIUS;
    });
    if (allyBlocksRoute) return null;

    const context = this._getSequenceContext(state, step, input, false, true, this._routeStrafeSide);
    if (!this._sequenceRuntime.start("route_strafe_jump", context)) return null;
    this._routeStrafeSide = this._routeStrafeSide === 1 ? -1 : 1;
    this._routeStrafeCooldownUntilTick = state.tick + BOT_STRAFE_RETRY_TICKS;
    return this._tickActiveSequence(state);
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
    } else if (leftBlocked && !rightBlocked) {
      yawAdjust = 0.2; // Gentle right
    } else if (rightBlocked && !leftBlocked) {
      yawAdjust = -0.2; // Gentle left
    }

    if (yawAdjust !== 0) {
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

  private _shouldSeekItems(state: BotGameState): boolean {
    // Seek items if:
    // - Low on ammo for current weapon
    // - Missing key weapons
    // - Health below 50
    // - Low armor
    if (state.self.health < 50) return true;
    if (state.self.armor < 25) return true;

    // Check ammo
    const currentAmmo = state.self.ammo[state.self.currentWeapon];
    if (currentAmmo !== undefined && currentAmmo < 3) return true;

    return false;
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

    return bestTarget;
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
