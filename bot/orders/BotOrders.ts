/**
 * The bot's side of the gametype's orders (AgentDirective: an S&D site to
 * hold, a bomb to plant or defuse, ground to guard): the mandatory goal they
 * set, the walk to it and round it watching the ways in, and the leash that
 * brings a guard back from a fight that drew it away.
 */

import { DEFAULT_VIEWHEIGHT } from "../../../../engine/physics/PlayerPhysicsConstants";
import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "../../../../shared/server/simulation/physics/constants";
import { scaledBodyHeight } from "../../shared/BodyScale";
import { selectWeightProfile } from "../../shared/bot/WeightProfiles";
import type { BotInput } from "../BotBrain";
import { type GoalArbiterMode, InputButtons } from "../BotConfig";
import type { BotGameState, Vec3 } from "../BotGameState";
import { vec3Length, vec3Subtract } from "../BotGameState";
import type { BotLife } from "../BotLife";
import type { BotNavGraph } from "../BotNavGraph";
import type { BotVision } from "../BotVision";
import type { BotGoal } from "../goals/BotGoal";
import { collectDirectiveGoals } from "../goals/DirectiveGoalSource";
import type { InputClaims } from "../InputClaims";
import type { BotNavigator } from "../navigation/BotNavigator";

/** A bot timing an item waits this close to it, inside its pickup reach. */
const TIMED_ITEM_HOLD_RADIUS = 40;
const HOLD_SWEEP_RATE = 0.9;
/** A held watch sweeps this far either side of the way in, radians, at this rate. */
const HOLD_SWEEP = 0.3;
/** A guard picks its next patrol point once this close to the last, units. */
const GUARD_POINT_REACHED = 56;
/** With nowhere to walk, a guard strafes and turns the way back this often, ticks. */
const GUARD_STRAFE_TICKS = 90;
/** Patrol points are kept within this of a guard's radius, units, however large the order. */
const GUARD_MIN_RADIUS = 96;
const GUARD_MAX_RADIUS = 420;
/** Guard patrol points lie this far out from the spot, as shares of the order's radius. */
const GUARD_RINGS = [0.45, 0.85] as const;
/** Directions round the spot a guard tries for patrol points. */
const GUARD_DIRECTIONS = 10;
/** Eye height for a guard's check that a patrol point sees the way in. */
const GUARD_EYE = 40;
/** How long a bot waiting at a timed item watches one way in. */
const ENTRANCE_WATCH_TICKS = 375;

/** What following orders needs of the brain. */
export interface OrdersHost {
  readonly life: BotLife;
  readonly nav: BotNavigator;
  readonly navGraph: BotNavGraph | null;
  readonly vision: BotVision | null;
  readonly claims: InputClaims;
  readonly bodyScale: number;
  readonly goalArbiterMode: GoalArbiterMode;
  /** Where a Duel bot keeps to, or null outside Duel. */
  duelTerritory(state: BotGameState, center?: Vec3): Vec3 | null;
  startRecovery(state: BotGameState, stuck?: boolean, blockedHeading?: number): BotInput;
}

export class BotOrders {
  constructor(private readonly host: OrdersHost) {}

  selectMandatoryGoal(state: BotGameState): BotGoal | null {
    if (this.host.goalArbiterMode === "legacy") return null;
    const weights = selectWeightProfile(state.matchState.gametypeName, state.getOwnRole(), state.matchState.roundState);
    if (weights.objectivePush <= 0) return null;
    const goals = collectDirectiveGoals(state).filter(
      (goal) => goal.directive?.interrupt === "never" && Number.isFinite(goal.directive.priority),
    );
    goals.sort((a, b) => (b.directive?.priority ?? 0) - (a.directive?.priority ?? 0) || a.id.localeCompare(b.id));
    return goals[0] ?? null;
  }

  /**
   * How close to a goal the bot stops and waits: a directive's own radius, or
   * beside a timed item that is not back yet. Undefined for goals to touch.
   */
  holdRadius(goal: BotGoal, state: BotGameState): number | undefined {
    if (goal.directive) return goal.radius;
    if (goal.respawnTick !== undefined && goal.respawnTick > state.tick) return TIMED_ITEM_HOLD_RADIUS;
    return undefined;
  }

  navigateGoal(state: BotGameState, goal: BotGoal, urgent: boolean): BotInput {
    const waypoint = this.host.nav.nextWaypoint(state, goal);
    if (waypoint) return this.host.nav.navigateTo(state, waypoint, urgent);
    const radius = this.holdRadius(goal, state);
    // Planting and defusing use move_to: those orders must stay still on arrival.
    // Escorting patrols round the player escorted, as it moves.
    const patrol =
      goal.directive?.kind === "defend" || goal.directive?.kind === "hold_area" || goal.directive?.kind === "escort";
    if (patrol && radius !== undefined && vec3Length(vec3Subtract(goal.position, state.self.position)) <= radius) {
      return this.guardPatrol(state, goal.id, goal.position, radius, goal.directive?.watch ?? null);
    }
    this.host.life.sitePatrol = null;
    const timed = !goal.directive && goal.respawnTick !== undefined && goal.respawnTick > state.tick;
    if (timed && radius !== undefined && vec3Length(vec3Subtract(goal.position, state.self.position)) <= radius) {
      if (state.matchState.gametypeName.toLowerCase() === "duel") {
        const patrol = this.host.duelTerritory(state, goal.position);
        return patrol ? this.host.nav.navigateTo(state, patrol, false) : this.host.startRecovery(state);
      }
      return this.watchEntrances(state, goal.position);
    }
    return this.host.nav.navigateTo(state, goal.position, urgent, radius);
  }

  /** Waiting for an item: on the move round it, watching the ways in. */
  watchEntrances(state: BotGameState, item: Vec3): BotInput {
    return this.guardPatrol(state, `item:${item.x},${item.z}`, item, TIMED_ITEM_HOLD_RADIUS, null);
  }

  /**
   * Guarding: on the move round `center`, never standing. The guard runs
   * between walkable points within `radius`, choosing ones that see the way
   * in, and keeps its view on that way in (or on the ways into the spot) while
   * it runs, as a player strafes about a doorway instead of standing in it.
   * With nowhere to run, it strafes side to side facing the way in.
   */
  guardPatrol(state: BotGameState, goalId: string, center: Vec3, radius: number, watch: Vec3 | null): BotInput {
    // A walk round the spot, steered but not swapped for a slide or a hop.
    this.host.claims.hold("movement", "guard patrol", "corrections");
    const self = state.self.position;
    const look = watch ?? this.entranceToWatch(state, center);
    const lookYaw = look ? Math.atan2(look.x - self.x, look.z - self.z) : state.self.yaw;
    const sweep = Math.sin((state.tick / TICK_RATE) * HOLD_SWEEP_RATE) * HOLD_SWEEP;
    const pitch = look
      ? -Math.atan2(
          look.y - (self.y + scaledBodyHeight(DEFAULT_VIEWHEIGHT, this.host.bodyScale)),
          Math.hypot(look.x - self.x, look.z - self.z),
        )
      : 0;

    const previous = this.host.life.sitePatrol;
    let target =
      previous?.goalId === goalId &&
      state.tick < previous.expires &&
      vec3Length(vec3Subtract(previous.target, self)) > GUARD_POINT_REACHED
        ? previous.target
        : null;
    if (!target) {
      target = this.guardPoint(state, center, radius, look, previous?.goalId === goalId ? previous.target : null);
      this.host.life.sitePatrol = target
        ? { goalId, target, expires: state.tick + 4 * TICK_RATE, pauseUntil: 0 }
        : null;
    }
    if (!target) {
      // Strafe across the way in, turning back every so often, toward the side with room
      const room = (sign: number) => {
        const a = lookYaw + sign * (Math.PI / 2);
        const world = this.host.vision?.collisionWorld;
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
  guardPoint(state: BotGameState, center: Vec3, radius: number, look: Vec3 | null, last: Vec3 | null): Vec3 | null {
    const vision = this.host.vision;
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
  entranceToWatch(state: BotGameState, spot: Vec3): Vec3 | null {
    const graph = this.host.navGraph;
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
  leashOrder(state: BotGameState): { center: Vec3; leash: number } | null {
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
  applyLeash(state: BotGameState, input: BotInput): BotInput {
    const order = this.leashOrder(state);
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
}
