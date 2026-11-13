/**
 * BotNavGraph — Smart Waypoint Network
 *
 * Provides intelligent map navigation via a waypoint graph with A* pathfinding.
 *
 * Architecture (4 layers):
 *   Layer 0: Per-tick feelers (immediate wall avoidance — in StateMachineBrain)
 *   Layer 1: Waypoint nodes (where can the bot stand)
 *   Layer 2: Edge connections (how to get between nodes)
 *   Layer 3: A* pathfinding (optimal routes)
 *
 * Node sources:
 *   - Item/weapon pickup positions from BSP
 *   - Player spawn points from BSP
 *   - Floor-grid sampling (fills navigation gaps)
 *
 * Edge types:
 *   - Walk: flat path clear, height diff < 40
 *   - Jump:  height diff 40-80, horizontal clear
 *   - Fall:  height diff > 80, high→low only
 *
 * One instance per map, shared by all bots.
 */

import type { CollisionWorld } from "../../../engine/network/systems/collision/CollisionWorld";
import {
  type FloodPosition,
  type FloodVec3,
  type FloodWorld,
  settle,
  walkFlood,
} from "../../../shared/collision/WalkFlood";
import type { Vec3 } from "../shared/bsp/BspDataLoader";
import { vec3Distance } from "./BotGameState";
import {
  BOT_MOVEMENT_ANALYZER_FINGERPRINT,
  BotMovementAnalyzer,
  type MovementAnalysisSummary,
  type MovementOpportunity,
  type MovementRejection,
} from "./BotMovementAnalyzer";
import type { BotVision, MapKnowledgeData } from "./BotVision";
import type { LearnedRoute } from "./LearnedRoutes";

// ── Nav Types ───────────────────────────────────────────────────────

export type NavNodeType = "item" | "spawn" | "floor" | "jumppad" | "teleporter";

export interface NavNode {
  id: number;
  position: Vec3;
  type: NavNodeType;
  /** BSP classname for items (e.g. 'item_health_mega', 'weapon_rocketlauncher') */
  classname?: string;
  /** Stable PickupEntry.id used by the replicated active mask. */
  pickupId?: number;
}

export type NavEdgeType = "walk" | "jump" | "fall" | "jumppad" | "teleporter";

/** Authored trigger data required to execute and verify a non-local traversal. */
export interface NavTriggerMetadata {
  id: number;
  min: Vec3;
  max: Vec3;
  dest: Vec3;
  destYaw?: number;
}

export interface NavEdge {
  from: number; // NavNode id
  to: number; // NavNode id
  type: NavEdgeType;
  cost: number;
  opportunityId?: string;
  requiredSpeed?: number;
  expectedTicks?: number;
  successMargin?: number;
  validated?: boolean;
  trigger?: NavTriggerMetadata;
  /**
   * A walk edge the straight line cannot take (round a doorway, down a
   * ledge): the corners of the way the walk flood found, as node positions
   * (1 above the floor). Routes run through them.
   */
  via?: Vec3[];
}

export interface NavStep {
  from: NavNode;
  to: NavNode;
  type: NavEdgeType;
  cost: number;
  horizontalDistance: number;
  heightDelta: number;
  /** Trigger entrances, drops, and final item approaches need tighter steering. */
  requiresPreciseApproach: boolean;
  opportunityId?: string;
  requiredSpeed?: number;
  expectedTicks?: number;
  successMargin?: number;
  validated?: boolean;
  trigger?: NavTriggerMetadata;
  /**
   * The graph edge this step is part of, when an edge's `via` corners split
   * it into several steps: a failure on any of them is the edge's.
   */
  edge?: { from: number; to: number };
}

// ── Path Result ─────────────────────────────────────────────────────

export interface NavPath {
  /** Ordered list of nodes from start to goal */
  nodes: NavNode[];
  /** Traversal-aware transitions between each pair of nodes. */
  steps: NavStep[];
  /** Total traversal cost */
  totalCost: number;
  /** Mutable per-path progress; paths are owned by one bot. */
  cursor: number;
}

export interface NavGraphStaticData {
  nodes: NavNode[];
  edges: NavEdge[];
  opportunities?: MovementOpportunity[];
  movementAnalysis?: MovementAnalysisSummary;
}

export interface NavPathOptions {
  blockedEdgeKeys?: ReadonlySet<string>;
  blockedPickupIds?: ReadonlySet<number>;
  /**
   * Can a player at `from` walk straight to `to` (a node's standing origin)?
   * When given, a route starts from the nearest node the player can walk to,
   * not merely the nearest: a bot knocked onto a barricade must not start its
   * route at a node on the far side of a wall.
   */
  canWalkTo?: (from: Vec3, to: Vec3) => boolean;
}

export function navEdgeKey(from: number, to: number, type: NavEdgeType): string {
  return `${from}->${to}:${type}`;
}
// ── Constants ───────────────────────────────────────────────────────

/** Max distance between nodes to test for edges */
const MAX_EDGE_DISTANCE = 1500;

/** Max height diff for walk edges */
const WALK_HEIGHT_MAX = 40;

/** Max height diff for jump edges */
const JUMP_HEIGHT_MAX = 80;

/** Cost multiplier for jump edges */
const JUMP_COST_MULT = 1.3;

/** Cost multiplier for fall edges (falling is fast!) */
const FALL_COST_MULT = 0.8;

/** Grid spacing for floor sampling (units) */
const FLOOR_GRID_SPACING = 256;

/** Raycast height for floor sampling (cast downward from this height) */
const FLOOR_SAMPLE_HEIGHT = 500;
/**
 * Standing surfaces sampled per grid column.
 *
 * More than one because maps have storeys; bounded because a column through a
 * stack of crates is not a stack of useful nav nodes.
 */
const FLOOR_SAMPLES_PER_COLUMN = 4;
/** Drop this far below a surface before looking for the next one down. */
const FLOOR_COLUMN_STEP = 8;
/** How far outside the known node band a surface can be and still count. */
const FLOOR_BAND_HEADROOM = 128;

/**
 * Floor and item nodes sit on the surface, but walk tests sweep the player
 * hull, which reaches 24 units below its origin. Swept from the surface it
 * starts inside the floor and nothing is ever clear, so the test sweeps from
 * standing height instead. Spawn points are already stored at standing height.
 */
const WALK_TEST_LIFT = 24;
const STANDS_ON_SURFACE: ReadonlySet<NavNodeType> = new Set(["floor", "item"]);

/** Min distance between any two nodes (dedup threshold) */
const MIN_NODE_DISTANCE = 64;

/** Nearest nodes checked for a clear walk when choosing where a route starts. */
const START_CANDIDATES = 8;

/** Edge ids of learned routes carry this prefix. */
const LEARNED_PREFIX = "learned:";
/** A learned route lands on an existing node this close, or gets a node of its own. */
const LEARNED_LANDING_SNAP = 96;
/** A learned landing node links to same-floor nodes this close, horizontally... */
const LEARNED_LANDING_LINK = 256;
/** ...and this close in height. */
const LEARNED_LANDING_STEP = 32;
/** Marks the walk links of a learned landing node, so reloading routes drops them. */
const LEARNED_LINK = `${LEARNED_PREFIX}link`;

/** Learned route cost: its ticks as distance at this speed. */
const LEARNED_COST_SPEED = 320;

/** A target this close to a node is that node's own (an item's), not one to snap. */
const OWN_NODE_RADIUS = 32;

/** A route's goal snaps to a reachable node this close to the target. */
const GOAL_SNAP_RADIUS = 256;

/** Same-height node pairs at least this far apart that walking cannot link get a jump test. */
const GAP_JUMP_MIN = 64;

/** A teleporter exit that carries the player further than this lands at a node of its own. */
const TELEPORT_CARRY = 64;

/** A landed origin is this far above the feet; nodes sit 1 unit above the surface. */
const JUMPPAD_LANDING_FEET = 24;

/** Node pairs this close horizontally are linked by a walk flood when the straight sweep fails. */
const WALK_FLOOD_RADIUS = 400;
/** Flooded when the rise is at most the horizontal distance plus this (stairs top out near 45°). */
const WALK_FLOOD_RISE_SLACK = 32;
/** Walk flood step and visited-cell size. */
const WALK_FLOOD_STEP = 32;
/**
 * A step may drop this far: down stairs and off ledges, short of fall damage
 * (`sv_falldamage_min` defaults to 256). The flood is one-way, so a drop never
 * implies the climb back.
 */
const WALK_FLOOD_MAX_DROP = 255;
/** Cap on positions per node's flood. */
const WALK_FLOOD_MAX_STATES = 4000;
/** The flood reaches a node when it stands this close to the node's standing origin. */
const WALK_FLOOD_ARRIVAL = 32;
const WALK_FLOOD_ARRIVAL_HEIGHT = 24;

// Keeping off walls
/** Rays cast round a point to measure its clearance. */
const CLEARANCE_RAYS = 16;
/** Clearance a floor node is moved to have, from the hull's side, where the room allows. */
const NODE_CLEARANCE = 48;
/** Furthest a floor node moves off a wall, and the steps it tries. */
const NODE_PUSH_MAX = 64;
const NODE_PUSH_STEP = 16;
/** A moved node stays on its floor: the surface under it within this. */
const NODE_PUSH_FLOOR_STEP = 8;
/** Walk edges are sampled this often for their clearance. */
const EDGE_CLEARANCE_STEP = 32;
/** Clearance under this along a walk edge costs extra, from the hull's side. */
const EDGE_CLEARANCE = 48;
/** Extra cost per unit of edge run touching a wall; scales down to 0 at EDGE_CLEARANCE. */
const EDGE_WALL_COST = 0.6;
/** Half the player hull's width. */
const HULL_HALF = 16;
/** Clearance is measured this far above the walk origin, above steps. */
const CLEARANCE_LIFT = 16;

/**
 * Gap from the player hull to the nearest wall around `origin`, and the
 * direction away from the walls closer than `want`, out to `want` + the hull.
 */
export function wallClearance(
  world: CollisionWorld,
  origin: Vec3,
  want: number,
  rays = CLEARANCE_RAYS,
): { gap: number; away: { x: number; z: number } } {
  const reach = want + HULL_HALF;
  const at = { x: origin.x, y: origin.y + CLEARANCE_LIFT, z: origin.z };
  let nearest = reach;
  let awayX = 0;
  let awayZ = 0;
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2;
    const dx = Math.sin(angle);
    const dz = Math.cos(angle);
    const distance = world.trace(at, { x: at.x + dx * reach, y: at.y, z: at.z + dz * reach }).fraction * reach;
    nearest = Math.min(nearest, distance);
    awayX -= dx * (reach - distance);
    awayZ -= dz * (reach - distance);
  }
  const length = Math.hypot(awayX, awayZ);
  return {
    gap: Math.max(0, nearest - HULL_HALF),
    away: length > 1e-6 ? { x: awayX / length, z: awayZ / length } : { x: 0, z: 0 },
  };
}

/** Id of a corner waypoint a walk edge's `via` adds to a path; not a graph node. */
export const VIA_NODE_ID = -1;

/** Teleporters are effectively instant, but keep a small cost so A* stays stable. */
const TELEPORT_COST = 32;

/** Jump pads cost roughly their flight commitment, cheaper than walking the same distance. */
const JUMPPAD_COST_MULT = 0.45;

export const BOT_NAV_GRAPH_SCHEMA_VERSION = 3;
export const BOT_NAV_TRIGGER_RESOLVER_VERSION = 1;

/** Bump this when edge generation or movement assumptions change. */
export const BOT_NAV_MOVEMENT_FINGERPRINT = [
  `edge:${MAX_EDGE_DISTANCE}`,
  `walk:${WALK_HEIGHT_MAX}`,
  `jump:${JUMP_HEIGHT_MAX}:${JUMP_COST_MULT}`,
  `fall:${FALL_COST_MULT}`,
  `grid:${FLOOR_GRID_SPACING}:${FLOOR_SAMPLE_HEIGHT}:${MIN_NODE_DISTANCE}`,
  // Column sampling. Part of the fingerprint because a cache built by the old
  // single-trace version is a grid of roofs and must be rebuilt, not reused.
  `column:${FLOOR_SAMPLES_PER_COLUMN}:${FLOOR_COLUMN_STEP}:${FLOOR_BAND_HEADROOM}`,
  `trigger:${BOT_NAV_TRIGGER_RESOLVER_VERSION}:${TELEPORT_COST}:${JUMPPAD_COST_MULT}`,
  // Caches built before walk tests swept from standing height have almost no walk edges.
  `walk-origin:${WALK_TEST_LIFT}`,
  `walk-flood:${WALK_FLOOD_RADIUS}:${WALK_FLOOD_RISE_SLACK}:${WALK_FLOOD_STEP}:${WALK_FLOOD_MAX_DROP}:${WALK_FLOOD_MAX_STATES}:${WALK_FLOOD_ARRIVAL}:${WALK_FLOOD_ARRIVAL_HEIGHT}`,
  // Walk sweeps must be wholly clear with floor beneath that rises a step at a
  // time; caches with lenient sweeps hold edges into walls and up ledges.
  "walk-strict:3",
  // Flood walks keep the corners of the way they found.
  "walk-via:1",
  // Jump pad destination nodes moved from the aim point to the simulated landing.
  "jumppad-landing:2",
  "teleport-carry:1",
  `gap-jump:${GAP_JUMP_MIN}`,
  `clearance:${CLEARANCE_RAYS}:${NODE_CLEARANCE}:${NODE_PUSH_MAX}:${NODE_PUSH_STEP}:${EDGE_CLEARANCE_STEP}:${EDGE_CLEARANCE}:${EDGE_WALL_COST}:${CLEARANCE_LIFT}`,
  BOT_MOVEMENT_ANALYZER_FINGERPRINT,
].join("|");
// ── BotNavGraph ─────────────────────────────────────────────────────
function emptyMovementAnalysis(): MovementAnalysisSummary {
  return {
    candidateCount: 0,
    rolloutCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    budgetExhausted: false,
    rejectionCounts: {},
  };
}

/**
 * Walk floods from nodes, run once per node on first use. `distance(a, b)` is
 * how far the flood from `a` walked to stand at `b`, or null if it never did.
 */
class WalkReach {
  private readonly origins = new Map<number, FloodVec3 | null>();
  private readonly floods = new Map<number, Map<string, FloodPosition[]>>();

  constructor(private readonly world: FloodWorld) {}

  distance(from: NavNode, to: NavNode): number | null {
    return this.reach(from, to)?.distance ?? null;
  }

  /** The shortest walk the flood found from `from` to `to`: its length and the standing origins along it, start first. */
  reach(from: NavNode, to: NavNode): { distance: number; way: FloodVec3[] } | null {
    const goal = this.origin(to);
    if (!goal || !this.origin(from)) return null;
    const cells = this.flood(from);
    const cx = Math.round(goal.x / WALK_FLOOD_STEP);
    const cz = Math.round(goal.z / WALK_FLOOD_STEP);
    let best: FloodPosition | null = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const p of cells.get(`${cx + dx},${cz + dz}`) ?? []) {
          if (Math.hypot(p.x - goal.x, p.z - goal.z) > WALK_FLOOD_ARRIVAL) continue;
          if (Math.abs(p.y - goal.y) > WALK_FLOOD_ARRIVAL_HEIGHT) continue;
          if (best === null || p.distance < best.distance) best = p;
        }
      }
    }
    if (!best) return null;
    const way: FloodVec3[] = [];
    for (let p: FloodPosition | undefined = best; p; p = p.previous) way.unshift({ x: p.x, y: p.y, z: p.z });
    return { distance: best.distance, way };
  }

  /** Standing origin of a node: its position lowered onto the floor beneath. */
  private origin(node: NavNode): FloodVec3 | null {
    let origin = this.origins.get(node.id);
    if (origin === undefined) {
      origin = settle(this.world, walkOrigin(node), WALK_FLOOD_MAX_DROP + WALK_TEST_LIFT);
      this.origins.set(node.id, origin);
    }
    return origin;
  }

  private flood(node: NavNode): Map<string, FloodPosition[]> {
    let cells = this.floods.get(node.id);
    if (cells) return cells;
    cells = new Map();
    const start = this.origin(node);
    if (start) {
      const reached = walkFlood(this.world, start, {
        step: WALK_FLOOD_STEP,
        cell: WALK_FLOOD_STEP,
        maxDrop: WALK_FLOOD_MAX_DROP,
        radius: WALK_FLOOD_RADIUS + WALK_FLOOD_ARRIVAL,
        maxStates: WALK_FLOOD_MAX_STATES,
      });
      for (const p of reached) {
        const k = `${Math.round(p.x / WALK_FLOOD_STEP)},${Math.round(p.z / WALK_FLOOD_STEP)}`;
        const list = cells.get(k);
        if (list) list.push(p);
        else cells.set(k, [p]);
      }
    }
    this.floods.set(node.id, cells);
    return cells;
  }
}

/** Where a walk test sweeps the player hull from for this node. */
function walkOrigin(node: NavNode): Vec3 {
  if (!STANDS_ON_SURFACE.has(node.type)) return node.position;
  return { x: node.position.x, y: node.position.y + WALK_TEST_LIFT, z: node.position.z };
}

/** Off the next walk segment's line by more than this, a bot has not reached it. */
const PASSED_LATERAL = 64;
/** Above or below a waypoint by more than this, a bot has not passed it. */
const PASSED_HEIGHT = 48;

/**
 * A bot that slid or ran past a walk waypoint without coming within the
 * arrival radius is already on the next walk segment: past the waypoint, and
 * beyond it along the next segment close to that segment's line. Turning back
 * to touch the waypoint is what a spectator sees as the bot losing its way.
 */
function passedWalkWaypoint(botPos: Vec3, step: NavStep, next: NavStep | undefined): boolean {
  if (!next || step.type !== "walk" || next.type !== "walk" || step.requiresPreciseApproach) return false;
  if (step.to.type === "item" || Math.abs(botPos.y - step.to.position.y) > PASSED_HEIGHT) return false;
  const corner = step.to.position;
  const dx = next.to.position.x - corner.x;
  const dz = next.to.position.z - corner.z;
  const length = Math.hypot(dx, dz);
  if (length < 1) return false;
  const bx = botPos.x - corner.x;
  const bz = botPos.z - corner.z;
  // Past the corner along the segment it is on, too: on a switchback the bot
  // can stand beside the next segment's line before reaching the corner.
  if (bx * (corner.x - step.from.position.x) + bz * (corner.z - step.from.position.z) <= 0) return false;
  const along = (bx * dx + bz * dz) / length;
  const lateral = Math.abs(bx * dz - bz * dx) / length;
  return along > 0 && along < length && lateral <= PASSED_LATERAL;
}

export class BotNavGraph {
  private _nodes: NavNode[] = [];

  private _edges: NavEdge[] = [];
  private _adjacency: Map<number, NavEdge[]> = new Map();
  private _triggerLinks: Array<{
    from: number;
    to: number;
    type: "jumppad" | "teleporter";
    trigger: NavTriggerMetadata;
  }> = [];
  private _mapName: string;

  private _movementOpportunities: MovementOpportunity[] = [];
  private _learnedRoutes = new Map<string, LearnedRoute>();
  /** Nodes the graph had before any learned landing nodes were added. */
  private _baseNodeCount: number | null = null;
  private _movementRejections: MovementRejection[] = [];
  private _movementAnalysis: MovementAnalysisSummary = emptyMovementAnalysis();
  constructor(mapName: string) {
    this._mapName = mapName;
  }

  // ── Accessors ───────────────────────────────────────────────────

  get nodes(): ReadonlyArray<NavNode> {
    return this._nodes;
  }
  get edges(): ReadonlyArray<NavEdge> {
    return this._edges;
  }
  get nodeCount(): number {
    return this._nodes.length;
  }
  get edgeCount(): number {
    return this._edges.length;
  }

  // ── Graph Building ──────────────────────────────────────────────
  get mapName(): string {
    return this._mapName;
  }

  /** The learned route an edge's `opportunityId` names, if it names one. */
  getLearnedRoute(id: string | undefined): LearnedRoute | null {
    if (!id?.startsWith(LEARNED_PREFIX)) return null;
    return this._learnedRoutes.get(id.slice(LEARNED_PREFIX.length)) ?? null;
  }

  /**
   * Add routes learned from demos (see LearnedRoutes.ts) as `jump` edges:
   * from the node a player stands at the route's start, to the node at its
   * landing, or a new node there when none is near. With `canWalk`, start and
   * landing nodes are ones walkable from the route's ends, a new landing node
   * links only to nodes it can walk to, and a route whose new landing links to
   * none is left out. Replaces any learned routes added before, so loading
   * twice does not duplicate edges.
   */
  addLearnedRoutes(routes: readonly LearnedRoute[], canWalk?: (from: Vec3, to: Vec3) => boolean): number {
    this._edges = this._edges.filter((edge) => !edge.opportunityId?.startsWith(LEARNED_PREFIX));
    this._learnedRoutes.clear();
    // Landing nodes from an earlier call go too; they sit after the graph's own.
    if (this._baseNodeCount === null) this._baseNodeCount = this._nodes.length;
    else this._nodes.length = this._baseNodeCount;
    let added = 0;
    for (const route of routes) {
      const from = this._findStandingNode(route.start, canWalk);
      if (!from) continue;
      let to = this._findStandingNode(route.landing, canWalk);
      const toOrigin = to && (STANDS_ON_SURFACE.has(to.type) ? walkOrigin(to) : to.position);
      if (!to || !toOrigin || vec3Distance(toOrigin, route.landing) > LEARNED_LANDING_SNAP) {
        const landing: NavNode = {
          id: this._nodes.length,
          type: "floor",
          position: { x: route.landing.x, y: route.landing.y - WALK_TEST_LIFT, z: route.landing.z },
        };
        // A player stood here, so it is floor: link it to the nodes on the
        // same floor around it that it can walk to, or a route would arrive
        // at a dead end. A link through a wall or over a rail stood the bot
        // against it.
        const links: NavEdge[] = [];
        for (const node of this._nodes) {
          if (!STANDS_ON_SURFACE.has(node.type)) continue;
          const reach = Math.hypot(node.position.x - landing.position.x, node.position.z - landing.position.z);
          if (reach > LEARNED_LANDING_LINK || Math.abs(node.position.y - landing.position.y) > LEARNED_LANDING_STEP) {
            continue;
          }
          if (canWalk && !canWalk(walkOrigin(landing), walkOrigin(node))) continue;
          const cost = vec3Distance(node.position, landing.position);
          links.push({ from: landing.id, to: node.id, type: "walk", cost, opportunityId: LEARNED_LINK });
          links.push({ from: node.id, to: landing.id, type: "walk", cost, opportunityId: LEARNED_LINK });
        }
        if (links.length === 0) continue;
        this._nodes.push(landing);
        this._edges.push(...links);
        to = landing;
      }
      if (to.id === from.id) continue;
      this._learnedRoutes.set(route.id, route);
      this._edges.push({
        from: from.id,
        to: to.id,
        type: "jump",
        // Time in the air and on the run-up, as distance at running speed.
        cost: (route.ticks / 125) * LEARNED_COST_SPEED,
        opportunityId: `${LEARNED_PREFIX}${route.id}`,
        expectedTicks: route.ticks,
        validated: true,
      });
      added++;
    }
    this._buildAdjacency();
    this._distanceMatrix = null;
    return added;
  }

  getMovementOpportunity(id: string): MovementOpportunity | null {
    return this._movementOpportunities.find((opportunity) => opportunity.id === id) ?? null;
  }
  get movementOpportunities(): ReadonlyArray<MovementOpportunity> {
    return this._movementOpportunities;
  }
  get movementRejections(): ReadonlyArray<MovementRejection> {
    return this._movementRejections;
  }
  get movementAnalysis(): Readonly<MovementAnalysisSummary> {
    return this._movementAnalysis;
  }
  /**
   * Build the waypoint graph from map knowledge + collision probing.
   * Call once per map load.
   */
  buildFromVision(vision: BotVision): void {
    const startTime = Date.now();
    const knowledge = vision.mapKnowledge;

    console.log(`[NavGraph] Building nav graph for "${this._mapName}"...`);

    this._nodes = [];
    this._baseNodeCount = null;
    this._edges = [];
    this._adjacency.clear();
    this._triggerLinks = [];

    // Step 1: Extract nodes from known positions
    this._extractNodes(knowledge, vision);

    this._movementOpportunities = [];
    this._movementRejections = [];
    this._movementAnalysis = emptyMovementAnalysis();
    // Step 2: Probe edges between nearby nodes
    this._probeEdges(vision);

    // Step 3: Build adjacency list
    this._buildAdjacency();

    const elapsed = Date.now() - startTime;
    console.log(`[NavGraph] Built: ${this._nodes.length} nodes, ${this._edges.length} edges (${elapsed}ms)`);

    // Debug: type breakdown
    const typeCounts = new Map<string, number>();
    for (const node of this._nodes) {
      typeCounts.set(node.type, (typeCounts.get(node.type) || 0) + 1);
    }
    const edgeTypeCounts = new Map<string, number>();
    for (const edge of this._edges) {
      edgeTypeCounts.set(edge.type, (edgeTypeCounts.get(edge.type) || 0) + 1);
    }

    console.log(`[NavGraph] Nodes: ${[...typeCounts.entries()].map(([t, c]) => `${t}=${c}`).join(", ")}`);
    console.log(`[NavGraph] Edges: ${[...edgeTypeCounts.entries()].map(([t, c]) => `${t}=${c}`).join(", ")}`);
    console.log(
      `[NavGraph] Movement analysis: candidates=${this._movementAnalysis.candidateCount}, ` +
        `rollouts=${this._movementAnalysis.rolloutCount}, accepted=${this._movementAnalysis.acceptedCount}, ` +
        `rejected=${this._movementAnalysis.rejectedCount}, budget=${this._movementAnalysis.budgetExhausted ? "exhausted" : "ok"}`,
    );
  }

  /** Export immutable graph geometry for the versioned disk cache. */
  exportStaticData(): NavGraphStaticData {
    return {
      nodes: this._nodes.map((node) => ({ ...node, position: { ...node.position } })),
      edges: this._edges.map((edge) => ({ ...edge, trigger: this._cloneTrigger(edge.trigger) })),
      opportunities: this._movementOpportunities.map((opportunity) => this._cloneOpportunity(opportunity)),
      movementAnalysis: { ...this._movementAnalysis, rejectionCounts: { ...this._movementAnalysis.rejectionCounts } },
    };
  }

  /** Restore already-validated static graph geometry without BSP probing. */
  loadStaticData(data: NavGraphStaticData): void {
    const nodes = data.nodes.map((node) => ({ ...node, position: { ...node.position } }));
    const edges = data.edges.map((edge) => ({ ...edge, trigger: this._cloneTrigger(edge.trigger) }));
    const opportunities = (data.opportunities ?? []).map((opportunity) => this._cloneOpportunity(opportunity));
    const sourceAnalysis = data.movementAnalysis ?? emptyMovementAnalysis();
    const movementAnalysis = {
      ...sourceAnalysis,
      rejectionCounts: { ...sourceAnalysis.rejectionCounts },
    };
    if (nodes.some((node, index) => node.id !== index)) {
      throw new Error("Nav cache nodes must have contiguous ids");
    }

    const validEdgeTypes = new Set<NavEdgeType>(["walk", "jump", "fall", "jumppad", "teleporter"]);
    for (const edge of edges) {
      if (
        !nodes[edge.from] ||
        !nodes[edge.to] ||
        !validEdgeTypes.has(edge.type) ||
        !Number.isFinite(edge.cost) ||
        edge.cost < 0 ||
        ((edge.type === "teleporter" || edge.type === "jumppad") && !edge.trigger)
      ) {
        throw new Error("Nav cache contains an invalid edge");
      }
    }

    this._nodes = nodes;
    this._baseNodeCount = null;
    this._edges = edges;
    this._triggerLinks = [];
    this._movementOpportunities = opportunities;
    this._movementRejections = [];
    this._movementAnalysis = movementAnalysis;
    this._buildAdjacency();
  }

  describePath(path: NavPath): string {
    if (path.steps.length === 0) return `path nodes=${path.nodes.length} cost=${path.totalCost.toFixed(1)} complete`;
    const steps = path.steps.map((step) => `${step.type}:${step.from.id}->${step.to.id}`).join(" ");
    return `path nodes=${path.nodes.length} steps=${path.steps.length} cost=${path.totalCost.toFixed(1)} ${steps}`;
  }

  // ── A* Pathfinding ──────────────────────────────────────────────

  /**
   * Find the shortest path between two positions.
   * Returns null if no path exists.
   */
  findPath(from: Vec3, to: Vec3, options: NavPathOptions = {}): NavPath | null {
    const startNode = this._findStandingNode(from, options.canWalkTo);
    if (!startNode) return null;
    const goalNode = this._findReachableNodeNear(startNode, to) ?? this.findNearestNode(to);
    if (!goalNode) return null;
    if (startNode.id === goalNode.id) {
      return { nodes: [startNode], steps: [], totalCost: 0, cursor: 0 };
    }

    return this._astar(startNode.id, goalNode.id, options);
  }

  /**
   * Find shortest path to nearest item of a given type.
   * Searches all item nodes and returns path to the closest one.
   */
  findPathToItem(
    from: Vec3,
    itemType: string,
    activeMask: readonly boolean[] = [],
    options: NavPathOptions = {},
  ): NavPath | null {
    const startNode = this._findStandingNode(from, options.canWalkTo);
    if (!startNode) return null;

    // Find all matching item nodes
    const targets = this._nodes.filter((n) => {
      if (n.type !== "item" || !n.classname) return false;
      if (n.pickupId !== undefined && options.blockedPickupIds?.has(n.pickupId)) return false;
      if (n.pickupId !== undefined && activeMask.length > n.pickupId && !activeMask[n.pickupId]) return false;
      return this._matchesItemType(n.classname, itemType);
    });

    if (targets.length === 0) return null;

    // Find path to each target, return cheapest
    let bestPath: NavPath | null = null;
    for (const target of targets) {
      const path = this._astar(startNode.id, target.id, options);
      if (path && (!bestPath || path.totalCost < bestPath.totalCost)) {
        bestPath = path;
      }
    }

    return bestPath;
  }

  /**
   * Find the nearest NavNode to a world position.
   */
  findNearestNode(pos: Vec3): NavNode | null {
    let best: NavNode | null = null;
    let bestDist = Infinity;

    for (const node of this._nodes) {
      const dist = vec3Distance(pos, node.position);
      if (dist < bestDist) {
        bestDist = dist;
        best = node;
      }
    }

    return best;
  }

  /**
   * The node a player at `pos` is standing at. Height counts double: the
   * nearest node by straight distance is often on a ledge just overhead, which
   * a route cannot start from.
   */
  private _findStandingNode(pos: Vec3, canWalkTo?: NavPathOptions["canWalkTo"]): NavNode | null {
    const standingOrigin = (node: NavNode): Vec3 =>
      STANDS_ON_SURFACE.has(node.type) ? walkOrigin(node) : node.position;
    const score = (origin: Vec3) => Math.hypot(pos.x - origin.x, pos.z - origin.z) + 2 * Math.abs(pos.y - origin.y);
    if (!canWalkTo) {
      let best: NavNode | null = null;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const node of this._nodes) {
        const value = score(standingOrigin(node));
        if (value < bestScore) {
          bestScore = value;
          best = node;
        }
      }
      return best;
    }
    const scored = this._nodes.map((node) => {
      const origin = standingOrigin(node);
      return {
        node,
        origin,
        score: score(origin),
      };
    });
    scored.sort((a, b) => a.score - b.score);
    for (const candidate of scored.slice(0, START_CANDIDATES)) {
      if (canWalkTo(pos, candidate.origin)) return candidate.node;
    }
    return scored[0]?.node ?? null;
  }

  /**
   * The node nearest `target` that a route from `start` can reach, within
   * `GOAL_SNAP_RADIUS`. Objectives are often marked in the air (a bomb site's
   * indicator floats over its floor) and the plain nearest node can be on a
   * ledge beside it that nothing walks to; the floor under it is the goal.
   */
  private _findReachableNodeNear(start: NavNode, target: Vec3): NavNode | null {
    const costs = this._ensureDistanceMatrix()[start.id];
    if (!costs) return null;
    let best: NavNode | null = null;
    let bestDist = GOAL_SNAP_RADIUS;
    for (const node of this._nodes) {
      if (!Number.isFinite(costs[node.id])) continue;
      const dist = vec3Distance(target, node.position);
      if (dist <= bestDist) {
        bestDist = dist;
        best = node;
      }
    }
    return best;
  }

  /** Return the next traversal transition that has not yet been completed. */
  getNextStep(botPos: Vec3, path: NavPath, arrivedThreshold: number = 100): NavStep | null {
    while (path.cursor < path.steps.length) {
      const step = path.steps[path.cursor];
      const stepThreshold =
        step.to.type === "item"
          ? Math.min(arrivedThreshold, 32)
          : step.type === "fall"
            ? Math.min(arrivedThreshold, 48)
            : arrivedThreshold;
      if (
        vec3Distance(botPos, step.to.position) > stepThreshold &&
        !passedWalkWaypoint(botPos, step, path.steps[path.cursor + 1])
      )
        break;
      path.cursor++;
    }
    return path.steps[path.cursor] ?? null;
  }

  /**
   * Get the next waypoint to walk toward on a path.
   * Skips nodes the bot has already passed.
   *
   * @param botPos Bot's current position
   * @param path Previously computed path
   * @param arrivedThreshold Distance to consider "arrived" at a node
   * @returns Next node to walk toward, or null if path complete
   */
  getNextWaypoint(botPos: Vec3, path: NavPath, arrivedThreshold: number = 100): NavNode | null {
    const step = this.getNextStep(botPos, path, arrivedThreshold);
    return step?.to ?? null;
  }

  // ── Private: Node Extraction ────────────────────────────────────

  private _extractNodes(knowledge: MapKnowledgeData, vision: BotVision): void {
    let nextId = 0;

    const addNode = (position: Vec3, type: NavNodeType, classname?: string, pickupId?: number): NavNode => {
      const existing = this._findNearbyNode(position, MIN_NODE_DISTANCE);
      if (existing) return existing;
      const node: NavNode = {
        id: nextId++,
        position: { ...position },
        type,
        classname,
        pickupId,
      };
      this._nodes.push(node);
      return node;
    };

    // 1. Item pickup positions
    for (const item of knowledge.pickupPositions) {
      addNode(item.position, "item", item.classname, item.id);
    }

    // 2. Spawn points
    for (const sp of knowledge.spawnPoints) {
      addNode(sp, "spawn");
    }

    // 3. Trigger volumes. Source nodes sit at trigger AABB centers. A
    // teleporter's destination node sits at its exit. A jump pad gets one
    // destination node per place its flight can land, found by flying it:
    // its target is the aim point of the throw, usually in mid-air, and a pad
    // that throws straight up lands wherever the player steers.
    const flights = new BotMovementAnalyzer(vision.collisionWorld);
    for (const trigger of knowledge.triggerVolumes ?? []) {
      const type = trigger.type === "push" ? "jumppad" : "teleporter";
      const source = addNode(this._triggerCenter(trigger), type, `trigger_${trigger.type}`);
      const landings = trigger.type === "push" ? flights.simulateJumppadLandings(trigger) : [];
      if (trigger.type === "teleport") {
        // An exit that carries the player across a gap lands somewhere else.
        const landing = flights.simulateTeleportLanding(trigger);
        if (landing && Math.hypot(landing.x - trigger.dest.x, landing.z - trigger.dest.z) > TELEPORT_CARRY) {
          landings.push(landing);
        }
      }
      const destinations = landings.length
        ? landings.map((landing) => ({ x: landing.x, y: landing.y - JUMPPAD_LANDING_FEET + 1, z: landing.z }))
        : [trigger.dest];
      for (const destination of destinations) {
        const dest = addNode(destination, type, `trigger_${trigger.type}_dest`);
        if (dest.id === source.id) continue;
        this._triggerLinks.push({
          from: source.id,
          to: dest.id,
          type,
          trigger: {
            id: trigger.id,
            min: { ...trigger.min },
            max: { ...trigger.max },
            dest: { ...trigger.dest },
            destYaw: trigger.destYaw,
          },
        });
      }
    }

    // 4. Floor grid sampling (fills gaps)
    this._sampleFloorGrid(vision, nextId);
  }

  /**
   * Sample a floor grid to find walkable positions in corridors and rooms that
   * hold no items or spawns.
   *
   * Traces the WHOLE column rather than stopping at the first surface. That is
   * the difference between a floor grid and a roof grid: a single downward
   * trace from above the map hits the ceiling, so on wbomb2 this produced 318
   * candidate "floor" points with a median height of 545 in a map whose
   * playable band is 28-384 — four survived, and the graph was left with no
   * connective tissue between rooms at all.
   *
   * Sampling every storey also fixes multi-level maps generally: a walkway over
   * a room is a floor, and so is the room under it.
   */
  private _sampleFloorGrid(vision: BotVision, startId: number): void {
    if (this._nodes.length === 0) return;

    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;

    for (const node of this._nodes) {
      minX = Math.min(minX, node.position.x);
      maxX = Math.max(maxX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxY = Math.max(maxY, node.position.y);
      minZ = Math.min(minZ, node.position.z);
      maxZ = Math.max(maxZ, node.position.z);
    }

    const pad = FLOOR_GRID_SPACING;
    minX -= pad;
    maxX += pad;
    minZ -= pad;
    maxZ += pad;

    // Vertical band worth standing in. Anything above the highest known node by
    // more than a jump is roof, not floor — nothing reaches it and sampling it
    // only adds nodes that connect to nothing.
    const ceiling = maxY + FLOOR_BAND_HEADROOM;
    const floorLimit = minY - FLOOR_BAND_HEADROOM;

    let nextId = startId;
    const collision = vision.collisionWorld;

    for (let x = minX; x <= maxX; x += FLOOR_GRID_SPACING) {
      for (let z = minZ; z <= maxZ; z += FLOOR_GRID_SPACING) {
        let y = maxY + FLOOR_SAMPLE_HEIGHT;
        let found = 0;

        // Walk down the column, surface by surface. Each hit is a candidate
        // standing position; the trace then resumes just below it so the next
        // storey down is reachable rather than shadowed by the one above.
        while (found < FLOOR_SAMPLES_PER_COLUMN && y > floorLimit) {
          const hit = collision.trace({ x, y, z }, { x, y: floorLimit, z });
          if (!hit.hit || !hit.hitPoint) break;

          const surfaceY = hit.hitPoint.y;
          // Resume below this surface regardless of whether we keep it, or a
          // rejected candidate would trap the loop on the same hit forever.
          y = surfaceY - FLOOR_COLUMN_STEP;

          if (surfaceY > ceiling) continue;
          const sampled: Vec3 = { x: hit.hitPoint.x, y: surfaceY + 1, z: hit.hitPoint.z };
          if (vision.isInsideSolid(sampled)) continue;
          const floorPos = this._awayFromWalls(vision, sampled);
          if (this._isTooCloseToExisting(floorPos)) continue;

          this._nodes.push({ id: nextId++, position: floorPos, type: "floor" });
          found++;
        }
      }
    }
  }

  // ── Private: Edge Probing ───────────────────────────────────────

  private _probeEdges(vision: BotVision): void {
    const nodeCount = this._nodes.length;
    const movementAnalyzer = new BotMovementAnalyzer(vision.collisionWorld);
    const walks = new WalkReach(vision.collisionWorld);

    for (let i = 0; i < nodeCount; i++) {
      for (let j = i + 1; j < nodeCount; j++) {
        const a = this._nodes[i];
        const b = this._nodes[j];

        const dist = vec3Distance(a.position, b.position);
        if (dist > MAX_EDGE_DISTANCE) continue;

        const heightDiff = Math.abs(a.position.y - b.position.y);
        const horizontalDist = Math.sqrt((a.position.x - b.position.x) ** 2 + (a.position.z - b.position.z) ** 2);

        // Walk edge: low height diff + path clear
        if (heightDiff < WALK_HEIGHT_MAX && vision.isWalkable(walkOrigin(a), walkOrigin(b))) {
          const cost = dist + this._wallCost(vision.collisionWorld, walkOrigin(a), walkOrigin(b));
          this._edges.push({ from: a.id, to: b.id, type: "walk", cost });
          this._edges.push({ from: b.id, to: a.id, type: "walk", cost });
          continue;
        }

        // Neighbours the straight sweep cannot connect: stairs and ramps that
        // climb more than a step between grid nodes, a crate in the way, a
        // doorway off the line. A short walk flood from each node finds them,
        // each way on its own, because a staircase that can be walked down
        // can be walked up but a ledge cannot.
        const walked = new Set<NavNode>();
        if (horizontalDist <= WALK_FLOOD_RADIUS && heightDiff <= horizontalDist + WALK_FLOOD_RISE_SLACK) {
          for (const [from, to] of [
            [a, b],
            [b, a],
          ] as const) {
            const reach = walks.reach(from, to);
            if (!reach) continue;
            const via = this._corners(vision, reach.way);
            this._edges.push({
              from: from.id,
              to: to.id,
              type: "walk",
              cost: reach.distance,
              ...(via.length > 0 ? { via } : {}),
            });
            walked.add(from);
          }
        }

        // Jumps: up or down a ledge walking cannot climb, and across a gap at
        // about the same height (a pit, a hole in the floor) that walking
        // cannot cross. Each direction is simulated on its own; a gap jump
        // only where walking does not already go.
        const gap = heightDiff < WALK_HEIGHT_MAX && horizontalDist >= GAP_JUMP_MIN && walked.size < 2;
        if (heightDiff < WALK_HEIGHT_MAX && !gap) continue;
        if (heightDiff < JUMP_HEIGHT_MAX && horizontalDist < 400) {
          if (vision.canSee(a.position, b.position)) {
            for (const [from, to] of [
              [a, b],
              [b, a],
            ] as const) {
              if (gap && walked.has(from)) continue;
              const result = movementAnalyzer.analyzeJump(from.id, from.position, to.id, to.position);
              const opportunity = result.opportunity;
              if (!opportunity) continue;
              this._edges.push({
                from: from.id,
                to: to.id,
                type: "jump",
                cost: dist * JUMP_COST_MULT,
                opportunityId: opportunity.id,
                requiredSpeed: opportunity.takeoff.minSpeed,
                expectedTicks: opportunity.expectedTicks,
                successMargin: opportunity.successMargin,
                validated: true,
              });
            }
          }
          continue;
        }

        // Fall edge: large height diff, one-way high→low
        if (heightDiff >= JUMP_HEIGHT_MAX) {
          const higher = a.position.y > b.position.y ? a : b;
          const lower = a.position.y > b.position.y ? b : a;

          // Check LOS between nodes (can see = can fall)
          if (vision.canSee(higher.position, lower.position)) {
            const cost = dist * FALL_COST_MULT;
            this._edges.push({ from: higher.id, to: lower.id, type: "fall", cost });
          }
        }
      }
    }
    this._movementOpportunities = movementAnalyzer.accepted.map((opportunity) => this._cloneOpportunity(opportunity));
    this._movementRejections = movementAnalyzer.rejected.map((rejection) => ({ ...rejection }));
    this._movementAnalysis = movementAnalyzer.analysisSummary;
    this._addTriggerEdges();
  }

  // ── Private: Trigger Edges ─────────────────────────────────────

  private _addTriggerEdges(): void {
    for (const link of this._triggerLinks) {
      const from = this._nodes[link.from];
      const to = this._nodes[link.to];
      if (!from || !to || from.id === to.id) continue;

      const dist = vec3Distance(from.position, to.position);
      const cost = link.type === "teleporter" ? TELEPORT_COST : Math.max(TELEPORT_COST, dist * JUMPPAD_COST_MULT);
      this._edges.push({
        from: from.id,
        to: to.id,
        type: link.type,
        cost,
        trigger: this._cloneTrigger(link.trigger),
      });
    }
  }

  // ── Private: Adjacency List ─────────────────────────────────────

  private _buildAdjacency(): void {
    this._adjacency.clear();
    for (const node of this._nodes) {
      this._adjacency.set(node.id, []);
    }
    for (const edge of this._edges) {
      this._adjacency.get(edge.from)!.push(edge);
    }
    // Any structural change invalidates cached distances.
    this._distanceMatrix = null;
  }

  // ── All-pairs travel cost ───────────────────────────────────────

  /**
   * Exact graph distance between every pair of nodes, lazily computed.
   *
   * Goal scoring needs a travel estimate for EVERY candidate every decision,
   * and running A* per candidate is the one thing that would make the goal
   * arbiter too expensive (docs/research/BOT_WEIGHTS_AND_GOALS.md §7.4). The
   * design anticipated landmark distances, but the graphs turned out small
   * enough — 34-58 strategic nodes on shipped maps — that all-pairs is both
   * exact and cheaper to reason about: ~58 Dijkstra runs over ~82 edges.
   *
   * Deliberately NOT persisted in the nav cache. At this size recomputing costs
   * microseconds, so storing it would buy nothing and add a schema version to
   * invalidate.
   */
  private _distanceMatrix: Float64Array[] | null = null;

  private _ensureDistanceMatrix(): Float64Array[] {
    if (this._distanceMatrix) return this._distanceMatrix;

    const count = this._nodes.length;
    const matrix: Float64Array[] = [];
    for (let source = 0; source < count; source++) {
      matrix.push(this._dijkstraFrom(source, count));
    }
    this._distanceMatrix = matrix;
    return matrix;
  }

  /** Single-source shortest costs. Unreachable nodes stay Infinity. */
  private _dijkstraFrom(source: number, count: number): Float64Array {
    const dist = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
    const visited = new Uint8Array(count);
    dist[source] = 0;

    // Linear scan for the next node: at tens of nodes this beats a heap, and
    // it keeps the implementation obvious.
    for (;;) {
      let best = -1;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < count; i++) {
        if (!visited[i] && dist[i] < bestDist) {
          bestDist = dist[i];
          best = i;
        }
      }
      if (best < 0) break;
      visited[best] = 1;

      for (const edge of this._adjacency.get(best) ?? []) {
        const next = dist[best] + edge.cost;
        if (next < dist[edge.to]) dist[edge.to] = next;
      }
    }
    return dist;
  }

  /**
   * Estimated travel cost between two world positions, or `null` when no route
   * exists.
   *
   * The null is the important part. Goal scoring previously used a Euclidean
   * estimate that could never fail, so the arbiter's `unreachable` gate could
   * never fire and a bot could commit to an item on the far side of a wall.
   * Graph distance answers reachability honestly, including across disconnected
   * components.
   */
  estimateTravelCost(from: Vec3, to: Vec3): number | null {
    if (this._nodes.length === 0) return null;
    // The same start a route would use (see findPath).
    // Items have a node of their own at the item; only a target without one
    // (an objective marker) snaps to a reachable node nearby.
    const start = this._findStandingNode(from);
    const nearest = this.findNearestNode(to);
    if (!start || !nearest) return null;
    const goal =
      vec3Distance(nearest.position, to) <= OWN_NODE_RADIUS
        ? nearest
        : (this._findReachableNodeNear(start, to) ?? nearest);

    const approach = vec3Distance(from, start.position);
    const arrival = vec3Distance(goal.position, to);
    if (start.id === goal.id) return approach + arrival;

    const matrix = this._ensureDistanceMatrix();
    const graphCost = matrix[start.id]?.[goal.id];
    if (graphCost === undefined || !Number.isFinite(graphCost)) return null;

    // Snap distances at both ends: the bot is rarely standing exactly on a node,
    // and the item is rarely exactly on one either.
    return approach + graphCost + arrival;
  }

  // ── Private: A* ─────────────────────────────────────────────────

  private _astar(startId: number, goalId: number, options: NavPathOptions = {}): NavPath | null {
    const goalNode = this._nodes[goalId];
    if (!goalNode) return null;

    // Open set: priority queue (simple array sorted by fScore)
    const cameByEdge = new Map<number, NavEdge>();
    const openSet = new Set<number>([startId]);
    const cameFrom = new Map<number, number>();

    const gScore = new Map<number, number>();
    gScore.set(startId, 0);

    const fScore = new Map<number, number>();
    fScore.set(startId, this._heuristic(this._nodes[startId], goalNode));

    while (openSet.size > 0) {
      // Find node in openSet with lowest fScore
      let current = -1;
      let lowestF = Infinity;
      for (const id of openSet) {
        const f = fScore.get(id) ?? Infinity;
        if (f < lowestF) {
          lowestF = f;
          current = id;
        }
      }

      if (current === goalId) {
        // Reconstruct path
        return this._reconstructPath(cameFrom, cameByEdge, current, gScore.get(current) ?? 0);
      }

      openSet.delete(current);
      const neighbors = this._adjacency.get(current) || [];

      for (const edge of neighbors) {
        if (options.blockedEdgeKeys?.has(navEdgeKey(edge.from, edge.to, edge.type))) continue;
        const tentativeG = (gScore.get(current) ?? Infinity) + edge.cost;
        const currentG = gScore.get(edge.to) ?? Infinity;

        if (tentativeG < currentG) {
          cameByEdge.set(edge.to, edge);
          cameFrom.set(edge.to, current);
          gScore.set(edge.to, tentativeG);
          fScore.set(edge.to, tentativeG + this._heuristic(this._nodes[edge.to], goalNode));
          openSet.add(edge.to);
        }
      }
    }

    return null; // No path found
  }

  private _heuristic(_node: NavNode, _goal: NavNode): number {
    // Trigger edges can be much cheaper than Euclidean distance. Dijkstra's
    // zero heuristic remains admissible until a trigger-aware heuristic exists.
    return 0;
  }

  private _reconstructPath(
    cameFrom: Map<number, number>,
    cameByEdge: Map<number, NavEdge>,
    current: number,
    totalCost: number,
  ): NavPath {
    const nodeIds: number[] = [current];
    while (cameFrom.has(current)) {
      current = cameFrom.get(current)!;
      nodeIds.unshift(current);
    }

    const nodes = nodeIds.map((id) => this._nodes[id]);
    const steps: NavStep[] = [];
    for (let index = 1; index < nodeIds.length; index++) {
      const edge = cameByEdge.get(nodeIds[index]);
      if (!edge) throw new Error("A* path reconstruction lost edge metadata");
      let from = nodes[index - 1];
      const to = nodes[index];
      // A walk round corners: a plain walk step to each corner first, all
      // belonging to the edge, the last one carrying the edge's cost.
      for (const corner of edge.via ?? []) {
        const waypoint: NavNode = { id: VIA_NODE_ID, position: { ...corner }, type: "floor" };
        steps.push({
          from,
          to: waypoint,
          type: "walk",
          cost: 0,
          horizontalDistance: Math.hypot(corner.x - from.position.x, corner.z - from.position.z),
          heightDelta: corner.y - from.position.y,
          requiresPreciseApproach: false,
          edge: { from: edge.from, to: edge.to },
        });
        from = waypoint;
      }
      const dx = to.position.x - from.position.x;
      const dz = to.position.z - from.position.z;
      steps.push({
        ...(edge.via ? { edge: { from: edge.from, to: edge.to } } : {}),
        from,
        to,
        type: edge.type,
        cost: edge.cost,
        horizontalDistance: Math.hypot(dx, dz),
        heightDelta: to.position.y - from.position.y,
        opportunityId: edge.opportunityId,
        requiredSpeed: edge.requiredSpeed,
        expectedTicks: edge.expectedTicks,
        successMargin: edge.successMargin,
        validated: edge.validated,
        trigger: this._cloneTrigger(edge.trigger),
        requiresPreciseApproach:
          edge.type === "teleporter" || edge.type === "jumppad" || edge.type === "fall" || to.type === "item",
      });
    }
    return { nodes, steps, totalCost, cursor: 0 };
  }

  // ── Private: Utilities ──────────────────────────────────────────

  /**
   * The corners of a walk the flood found, as node positions: the string
   * pulled through its standing origins with the walk test, so each stretch
   * between corners is one a bot can run straight. Empty when the walk is
   * straight already.
   */
  private _corners(vision: BotVision, way: readonly FloodVec3[]): Vec3[] {
    if (way.length < 3) return [];
    const corners: Vec3[] = [];
    let from = 0;
    while (from < way.length - 1) {
      let next = from + 1;
      for (let far = way.length - 1; far > from + 1; far--) {
        if (vision.isWalkable(way[from], way[far])) {
          next = far;
          break;
        }
      }
      if (next < way.length - 1) {
        const p = way[next];
        corners.push({ x: p.x, y: p.y - WALK_TEST_LIFT + 1, z: p.z });
      }
      from = next;
    }
    return corners;
  }

  /**
   * A floor sample moved off the walls near it, as far as NODE_PUSH_MAX, so a
   * route through it runs down the room rather than along its side. The move
   * stays on the same floor and walkable from the sample; a sample in a
   * corridor narrower than twice NODE_CLEARANCE settles where it is clearest.
   */
  private _awayFromWalls(vision: BotVision, sampled: Vec3): Vec3 {
    const world = vision.collisionWorld;
    const origin = { x: sampled.x, y: sampled.y + WALK_TEST_LIFT, z: sampled.z };
    const start = wallClearance(world, origin, NODE_CLEARANCE);
    if (start.gap >= NODE_CLEARANCE || (start.away.x === 0 && start.away.z === 0)) return sampled;
    let best = sampled;
    let bestGap = start.gap;
    for (let push = NODE_PUSH_STEP; push <= NODE_PUSH_MAX; push += NODE_PUSH_STEP) {
      const x = sampled.x + start.away.x * push;
      const z = sampled.z + start.away.z * push;
      const floor = world.trace({ x, y: origin.y, z }, { x, y: sampled.y - NODE_PUSH_FLOOR_STEP - 1, z });
      if (!floor.hit || !floor.hitPoint) break;
      if (Math.abs(floor.hitPoint.y + 1 - sampled.y) > NODE_PUSH_FLOOR_STEP) break;
      const moved: Vec3 = { x, y: floor.hitPoint.y + 1, z };
      if (
        vision.isInsideSolid(moved) ||
        !vision.isWalkable(origin, walkOrigin({ id: -1, type: "floor", position: moved }))
      )
        break;
      const gap = wallClearance(world, walkOrigin({ id: -1, type: "floor", position: moved }), NODE_CLEARANCE).gap;
      if (gap > bestGap) {
        best = moved;
        bestGap = gap;
      }
      if (gap >= NODE_CLEARANCE) break;
    }
    return best;
  }

  /**
   * Extra route cost for the stretches of a straight walk where the hull
   * would pass close to a wall, so A* takes the middle of a room and the
   * outside of a corner when it costs little more. Never so much that a
   * narrow door stops being a route.
   */
  private _wallCost(world: CollisionWorld, from: Vec3, to: Vec3): number {
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    const samples = Math.max(1, Math.round(length / EDGE_CLEARANCE_STEP));
    let cost = 0;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const at = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t };
      const gap = wallClearance(world, at, EDGE_CLEARANCE, 8).gap;
      cost += (length / (samples + 1)) * EDGE_WALL_COST * Math.max(0, 1 - gap / EDGE_CLEARANCE);
    }
    return cost;
  }

  private _isTooCloseToExisting(pos: Vec3): boolean {
    return this._findNearbyNode(pos, MIN_NODE_DISTANCE) !== null;
  }

  private _findNearbyNode(pos: Vec3, radius: number): NavNode | null {
    for (const node of this._nodes) {
      if (vec3Distance(pos, node.position) < radius) {
        return node;
      }
    }
    return null;
  }

  private _triggerCenter(trigger: MapKnowledgeData["triggerVolumes"][number]): Vec3 {
    return {
      x: (trigger.min.x + trigger.max.x) / 2,
      y: (trigger.min.y + trigger.max.y) / 2,
      z: (trigger.min.z + trigger.max.z) / 2,
    };
  }

  private _cloneTrigger(trigger: NavTriggerMetadata | undefined): NavTriggerMetadata | undefined {
    if (!trigger) return undefined;
    return {
      ...trigger,
      min: { ...trigger.min },
      max: { ...trigger.max },
      dest: { ...trigger.dest },
    };
  }

  private _cloneOpportunity(opportunity: MovementOpportunity): MovementOpportunity {
    return {
      ...opportunity,
      takeoff: {
        ...opportunity.takeoff,

        position: { ...opportunity.takeoff.position },
        yawRange: [...opportunity.takeoff.yawRange],
      },
      landing: {
        ...opportunity.landing,
        position: { ...opportunity.landing.position },
        surfaceNormal: { ...opportunity.landing.surfaceNormal },
      },
      inputPlan: {
        ...opportunity.inputPlan,
        direction: { ...opportunity.inputPlan.direction },
      },
      risk: { ...opportunity.risk },
    };
  }

  private _matchesItemType(classname: string, type: string): boolean {
    switch (type) {
      case "health":
        return classname.includes("health");
      case "armor":
        return classname.includes("armor");
      case "weapon":
        return classname.startsWith("weapon_");
      case "ammo":
        return classname.startsWith("ammo_");
      default:
        return classname === type;
    }
  }
}
