/**
 * What a bot carries through one life: its route, its goals and its plans of
 * the moment. StateMachineBrain makes a new one when the bot dies, so nothing
 * here reaches the next life, a field added later included.
 */

import type { Vec3 } from "./BotGameState";
import type { NavPath } from "./BotNavGraph";
import type { BotGoal } from "./goals/BotGoal";
import type { RouteLine } from "./RouteLine";

export class BotLife {
  /** The route being followed. */
  currentPath: NavPath | null = null;
  /** Where HUNT is patrolling to, apart from a route's own target. */
  huntPatrolTarget: Vec3 | null = null;
  /** The item goal the bot has committed to. */
  activeItemGoal: BotGoal | null = null;
  /** The gametype order being carried out. */
  mandatoryGoal: BotGoal | null = null;
  /** A spot held at an objective, while its order lasts. */
  sitePatrol: { goalId: string; target: Vec3; expires: number; pauseUntil: number } | null = null;
  /** The item goal the bot has been beside, and since when. */
  itemCircle: { goalId: string; sinceTick: number } | null = null;
  /** Side chosen round a wall ahead (+1 right, -1 left), and until when. */
  feelerSide: { sign: number; untilTick: number } | null = null;
  /** A way out of an enemy's sight being taken (see StateMachineBrain._escapePoint). */
  escape: { point: Vec3; untilTick: number } | null = null;
  /** Where the view looks while running, relative to the way the bot runs, and until when. */
  look: {
    off: number;
    untilTick: number;
    spot?: { pickupId: number; position: Vec3; sinceTick: number };
  } | null = null;
  /**
   * The line through the walking stretch of the current route (RouteLine),
   * for the path it was built on from step `fromStep`, and the stretch of it
   * the bot is on.
   */
  routeLine: { path: NavPath; fromStep: number; line: RouteLine; stretch: number } | null = null;
  /** The gun got out for an enemy heard but not yet seen, and until when. */
  readyWeapon: { weapon: string; until: number } | null = null;
  /** The high ground the bot is keeping. */
  highGroundSpot: Vec3 | null = null;
  /** Where the bot was when it last made progress on its route, and when. */
  navigationProgress: { position: Vec3; tick: number } | null = null;
  /** A short move to get back on the graph, and until when. */
  recovery: { target: Vec3; until: number } | null = null;
  /** Blocked in a fight: the open way the bot runs, and until when. */
  unstick: { yaw: number; untilTick: number } | null = null;
}
