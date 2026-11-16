/**
 * The roaming states: CHASE after an enemy lost from sight, RETREAT toward
 * health or a way out, ITEM_RUN for the item planner's goal, and HUNT for
 * the last place an enemy was seen or a patrol of the map.
 */

import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "../../../../shared/server/simulation/physics/constants";
import { selectGametypeHabits } from "../../shared/bot/WeightProfiles";
import { wrapAngle } from "../BotAimController";
import type { BotInput } from "../BotBrain";
import { travelYaw } from "../BotBrain";
import type { BotDifficulty } from "../BotConfig";
import { InputButtons } from "../BotConfig";
import type { BotGameState, Vec3, VisiblePlayer } from "../BotGameState";
import { vec3Length, vec3Normalize, vec3Subtract } from "../BotGameState";
import type { BotLife } from "../BotLife";
import type { BotNavGraph } from "../BotNavGraph";
import type { BotVision, EnemyTrack, VisionResult } from "../BotVision";
import { selectBestWeapon } from "../BotWeaponProfile";
import type { BotGoal, ItemGoalChoice } from "../goals/BotGoal";
import type { RoamPick } from "../goals/RoamChoice";
import type { BotNavigator } from "../navigation/BotNavigator";
import { PATH_ARRIVED_THRESHOLD, PATH_RECALC_INTERVAL } from "../navigation/BotNavigator";

/** A chased enemy seen this recently is watched for rather than the route ahead. */
const CHASE_WATCH_TICKS = Math.round(1.5 * TICK_RATE);
/** Furthest the view turns from where the bot runs to watch a lost enemy. */
const CHASE_WATCH_MAX_OFF_TRAVEL = (110 * Math.PI) / 180;
/** Reached when this close, units; given up after ESCAPE_HOLD_TICKS. */
const ESCAPE_REACHED = 64;
/** An escape point lies this far away, units. */
const ESCAPE_MIN = 192;
const ESCAPE_MAX = 900;
/** ... and no more toward the threat than this (cosine). */
const ESCAPE_MAX_TOWARD = 0.2;
/** Nearest candidate nodes checked for sight and route cost. */
const ESCAPE_CANDIDATES = 24;
const ESCAPE_HOLD_TICKS = 375;
/** With no way out found, look again after this long. */
const ESCAPE_RETRY_TICKS = 60;
export const PICKUP_SEEK_RANGE = 1500;
const HUNT_DIRECTION_CHANGE_INTERVAL = 180; // Change hunt direction every ~3 sec at 60Hz

/** RETREAT wants healing, not shopping — see ItemGoalPlannerOptions.typeFilter. */
const RETREAT_ITEM_TYPES: ReadonlySet<string> = new Set(["health"]);

/** What roaming needs of the brain. */
export interface RoamHost {
  readonly life: BotLife;
  readonly nav: BotNavigator;
  readonly navGraph: BotNavGraph | null;
  readonly vision: BotVision | null;
  readonly visionResult: VisionResult | null;
  readonly difficulty: BotDifficulty;
  /** A point on the territory to make for, in a mode that keeps one (GametypeHabits), or null. */
  territoryPoint(state: BotGameState, center?: Vec3): Vec3 | null;
  keepUpperGround(state: BotGameState, enemy: Pick<VisiblePlayer, "position">, input: BotInput): BotInput;
  fireOrigin(state: BotGameState): Vec3;
  moveToward(state: BotGameState, target: Vec3, urgent: boolean): BotInput;
  selectItemGoal(
    state: BotGameState,
    typeFilter?: ReadonlySet<string>,
    ignoreDirectives?: boolean,
  ): ItemGoalChoice | null;
  navigateToItem(state: BotGameState, itemType: string, urgent: boolean): BotInput | null;
  navigateGoal(state: BotGameState, goal: BotGoal, urgent: boolean): BotInput;
  /** Where to hunt: the freshest enemy sighting, or a teammate's call. */
  huntTarget(state: BotGameState): Vec3 | null;
  /** What roaming goes for by score, with scoredGoals; undefined without (goals/RoamChoice.ts). */
  roamPick(state: BotGameState): RoamPick | null | undefined;
}

export class BotRoam {
  constructor(private readonly host: RoamHost) {
    this.huntYaw = Math.random() * Math.PI * 2;
  }

  huntYaw: number = 0;

  huntTimer: number = 0;

  escapeRetryTick = 0;

  lookAroundTimer: number = 0;

  lookAroundYaw: number = 0;

  chase(state: BotGameState): BotInput {
    const target = this.host.visionResult?.chaseTarget;
    if (!target) {
      // No target to chase — fall back to hunt
      return this.hunt(state);
    }

    // Move toward predicted (extrapolated) position using navGraph if available
    const holdUpper =
      selectGametypeHabits(state.matchState.gametypeName).keepsTerritory &&
      target.lastSeenPosition.y < state.self.position.y - 64 &&
      state.self.health >= 50;
    const territory = holdUpper ? this.host.territoryPoint(state) : null;
    const input =
      holdUpper && !territory
        ? this.host.keepUpperGround(
            state,
            { position: target.predictedPosition },
            this.host.moveToward(state, { ...target.predictedPosition, y: state.self.position.y }, false),
          )
        : this.host.nav.navigateTo(state, territory ?? target.predictedPosition, false);
    if (holdUpper) {
      input.moveYaw = travelYaw(input);
      input.yaw = Math.atan2(
        target.predictedPosition.x - state.self.position.x,
        target.predictedPosition.z - state.self.position.z,
      );
    } else {
      this.watchLostEnemy(state, target, input);
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
  watchLostEnemy(state: BotGameState, target: EnemyTrack, input: BotInput): void {
    if (target.source !== "visual" || state.tick - target.lastSeenTick > CHASE_WATCH_TICKS) return;
    const delta = vec3Subtract(target.predictedPosition, this.host.fireOrigin(state));
    const horizontal = Math.hypot(delta.x, delta.z);
    if (horizontal < 1) return;
    const watchYaw = Math.atan2(delta.x, delta.z);
    const moveYaw = travelYaw(input);
    if (Math.abs(wrapAngle(watchYaw - moveYaw)) > CHASE_WATCH_MAX_OFF_TRAVEL) return;
    input.moveYaw = moveYaw;
    input.yaw = watchYaw;
    input.pitch = -Math.atan2(delta.y, horizontal);
  }

  /**
   * A way out of a known enemy's sight: the nearest route node, within reach,
   * that the enemy cannot see from where it was last known and that does not
   * lie toward it. Reached once and dropped; null with no enemy or no node.
   */
  escapePoint(state: BotGameState): Vec3 | null {
    const graph = this.host.navGraph;
    const vision = this.host.vision;
    if (!graph || !vision) return null;
    const threat = this.host.visionResult?.visibleEnemies[0]?.player.position ?? this.host.huntTarget(state);
    if (!threat) return null;
    const self = state.self.position;
    if (this.host.life.escape && state.tick < this.host.life.escape.untilTick) {
      if (vec3Length(vec3Subtract(this.host.life.escape.point, self)) > ESCAPE_REACHED)
        return this.host.life.escape.point;
      this.host.life.escape = null;
      return null;
    }
    if (state.tick < this.escapeRetryTick) return null;
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
    this.host.life.escape = best ? { point: best.point, untilTick: state.tick + ESCAPE_HOLD_TICKS } : null;
    if (!best) this.escapeRetryTick = state.tick + ESCAPE_RETRY_TICKS;
    return best?.point ?? null;
  }

  retreat(state: BotGameState): BotInput {
    // First out of the enemy's sight, then to health.
    if (this.host.visionResult?.visibleEnemies.length) {
      const wayOut = this.escapePoint(state);
      if (wayOut) return this.host.nav.navigateTo(state, wayOut, true);
    } else this.host.life.escape = null;

    // Scored choice among HEALTH ONLY. Retreating is a specific intent, so the
    // candidate set is filtered rather than left open — but within health the
    // arbiter still beats "nearest": it accounts for overcap (a bubble at 98 HP
    // is worthless), route cost, and mega vs. medium.
    const healthGoal = this.host.selectItemGoal(state, RETREAT_ITEM_TYPES, true)?.goal;
    if (healthGoal) return this.host.nav.navigateTo(state, healthGoal.position, true);

    // Try NavGraph path to nearest health (cached via _navigateToItem)
    if (this.host.navGraph) {
      const result = this.host.navigateToItem(state, "health", true);
      if (result) return result;
    }

    // Try vision's cover finding
    if (this.host.visionResult?.nearestCover) {
      return this.host.nav.navigateTo(state, this.host.visionResult.nearestCover, true);
    }

    // Try nearest health item from BSP knowledge
    if (this.host.vision) {
      const healthPos = this.host.vision.findNearestItem(state.self.position, "health", state.pickupActiveMask);
      if (healthPos) {
        return this.host.nav.navigateTo(state, healthPos, true);
      }
    }

    // Find nearest pickup (prefer health)
    const pickup = state.getNearestPickup(PICKUP_SEEK_RANGE);
    if (pickup) {
      return this.host.nav.navigateTo(state, pickup.position, true);
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
    return this.hunt(state);
  }

  itemRun(state: BotGameState): BotInput {
    if (this.host.life.mandatoryGoal) {
      const goal = this.host.life.mandatoryGoal;
      this.host.life.activeItemGoal = goal;
      return this.host.navigateGoal(state, goal, true);
    }
    // Scored choice first: value, denial, route and danger decide which item,
    // instead of the fixed weapon > health > armor > ammo ordering below (which
    // took the nearest of whichever type came first, so a 5 HP bubble could
    // outrank Red Armor). Falls through to the legacy path when disabled or
    // when nothing scores.
    const choice = this.host.selectItemGoal(state);
    // Only a DIRECTIVE goal holds on arrival. An item goal has to be touched,
    // and a bot that stops next to a Red Armor never picks it up.
    if (choice) {
      const goal = choice.goal;
      // An item worth having just off the way there is taken first.
      if (choice.stopover && !goal.directive) return this.host.navigateGoal(state, choice.stopover, false);
      const territory =
        !goal.directive && goal.position.y < state.self.position.y - 48 ? this.host.territoryPoint(state) : null;
      return territory ? this.host.nav.navigateTo(state, territory, false) : this.host.navigateGoal(state, goal, false);
    }

    // Try NavGraph path to nearest item (weapon > health > armor > ammo)
    // Uses cached _navigateToItem to avoid A* every tick
    if (this.host.navGraph) {
      for (const itemType of ["weapon", "health", "armor", "ammo"]) {
        const result = this.host.navigateToItem(state, itemType, false);
        if (result) return result;
      }
    }

    // Prefer vision-verified reachable pickups
    if (this.host.visionResult) {
      const reachable = this.host.visionResult.pickups.find((p) => p.isReachable);
      if (reachable) {
        return this.host.nav.navigateTo(state, reachable.pickup.position, false);
      }
    }

    // Try BSP-known item positions
    if (this.host.vision) {
      const weaponPos = this.host.vision.findNearestItem(state.self.position, "weapon", state.pickupActiveMask);
      if (weaponPos) {
        return this.host.nav.navigateTo(state, weaponPos, false);
      }
    }

    // Fallback to raw state pickups
    const pickup = state.getNearestPickup(PICKUP_SEEK_RANGE);
    if (pickup) {
      return this.host.nav.navigateTo(state, pickup.position, false);
    }

    // No pickups found → hunt
    return this.hunt(state);
  }

  hunt(state: BotGameState): BotInput {
    this.huntTimer++;

    // By score, with scoredGoals: the territory, the arbiter's goal or the
    // sighting, whichever is worth most; patrol when none is worth anything.
    const pick = this.host.roamPick(state);
    if (pick !== undefined) {
      const goal = pick === "item" ? this.host.selectItemGoal(state)?.goal : null;
      if (goal) return this.host.navigateGoal(state, goal, false);
      const target =
        pick === "hold" ? this.host.territoryPoint(state) : pick === "hunt" ? this.host.huntTarget(state) : null;
      if (target) return this.host.nav.navigateTo(state, target, false);
      return this.patrol(state);
    }

    const territory = this.host.territoryPoint(state);
    if (territory) return this.host.nav.navigateTo(state, territory, false);

    // Prefer a scored goal over aimless patrol. Reached when the ladder falls
    // through to HUNT but the arbiter still has something worth doing — an
    // objective, or an item that did not meet _shouldSeekItems' cruder bar.
    const goal = this.host.selectItemGoal(state)?.goal;
    if (goal) return this.host.navigateGoal(state, goal, false);

    // Check if we know a last enemy position to investigate
    const huntTarget = this.host.huntTarget(state);
    if (huntTarget) {
      return this.host.nav.navigateTo(state, huntTarget, false);
    }
    return this.patrol(state);
  }

  /** Nowhere to be: a random nav node to walk toward, else a run with a turn now and then. */
  private patrol(state: BotGameState): BotInput {
    // NavGraph patrol: pick a random nav node to walk toward
    if (this.host.navGraph) {
      const nodes = this.host.navGraph.nodes;
      if (
        nodes.length > 0 &&
        (!this.host.life.huntPatrolTarget || this.host.nav.pathRecalcTimer > PATH_RECALC_INTERVAL * 2)
      ) {
        const randomNode = nodes[Math.floor(Math.random() * nodes.length)];
        this.host.life.huntPatrolTarget = randomNode.position;
        this.host.nav.pathRecalcTimer = 0;
      }
      if (this.host.life.huntPatrolTarget) {
        // Check if we've arrived at patrol target
        const distToPatrol = vec3Length(vec3Subtract(this.host.life.huntPatrolTarget, state.self.position));
        if (distToPatrol < PATH_ARRIVED_THRESHOLD) {
          this.host.life.huntPatrolTarget = null; // Pick new target next tick
          this.host.life.currentPath = null;
        } else {
          return this.host.nav.navigateTo(state, this.host.life.huntPatrolTarget, false);
        }
      }
    }

    // Fallback: random patrol — change direction periodically
    if (this.huntTimer > HUNT_DIRECTION_CHANGE_INTERVAL) {
      this.huntYaw += (Math.random() - 0.5) * Math.PI;
      this.huntTimer = 0;
    }

    // Look around randomly (human-feel)
    this.updateLookAround();

    const buttons = InputButtons.FORWARD | InputButtons.SPRINT;

    return {
      direction: { x: 0, y: 0, z: 1 },
      pitch: 0,
      yaw: this.huntYaw + this.lookAroundYaw,
      buttons,
      weaponSlot: 0,
    };
  }

  updateLookAround(): void {
    this.lookAroundTimer++;
    const interval = this.host.difficulty.lookAroundInterval * 60; // Convert seconds to ticks
    if (this.lookAroundTimer > interval) {
      this.lookAroundYaw = (Math.random() - 0.5) * 0.5; // Small random look
      this.lookAroundTimer = 0;
    }
  }
}
