/**
 * Search & Destroy — round-based bomb and defuse, Warsow Bomb compatible.
 *
 * One team carries a bomb to one of two sites and arms it; the other stops
 * them, or defuses it. No respawns inside a round. First to the score limit
 * with a two-round lead takes the match.
 *
 * The design, the map survey and the Warsow source it is ported from are in
 * docs/research/Search_And_Destroy.md. Two things are worth knowing here:
 *
 * - **The rules are not in this file.** `BombModel` owns the bomb and
 *   `MatchState` owns the round loop, both of them shared and independently
 *   tested. This class is the wiring: it reads the map, builds the bomb's view
 *   of the world each tick, and turns bomb events into round results.
 *
 * - **Bots are a separate process** and cannot import any of this. The mode
 *   steers them through `getAgentDirectives`, which returns plain data. If
 *   Search & Destroy ever needs code in `bot/`, the design has failed.
 */

import type { WorldState } from "@engine/server/core/WorldState";
import type { Entity } from "@engine/server/ecs/Entity";
import type { EntityId, PlayerId } from "@engine/server/ecs/types";
import { EntityType } from "@engine/server/ecs/types";
import type {
  AgentDirective,
  AgentDirectiveContext,
  BombExplosionEvent,
  ItemSpawnRules,
  LoadoutChoice,
  MatchConfig,
  ObjectiveSnapshot,
  PlayerStats,
  SpawnStrategyType,
  TeamId,
  WeaponLoadout,
} from "@shared/server/gametype";
import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "@shared/server/simulation/physics/constants";
import type { Vec3 } from "@shared/server/simulation/types";
import { log } from "../../../../engine/core/Log";
import { PLAYER_ORIGIN_HEIGHT } from "../../../../engine/physics/PlayerPhysicsConstants";
import type { BombSite, Vec3Like } from "../../../../shared/bsp/BombSiteTable";
import { extractBombSites, isBombMap, isInsideBombSite, spawnCentroid } from "../../../../shared/bsp/BombSiteTable";
import { BrushModelState, extractBrushModels } from "../../../../shared/bsp/BrushModelState";
import type { CollisionWorld } from "../../../../shared/collision/CollisionWorld";
import { rngFrom } from "../../../../shared/DeterministicRng";
import type { BombEvent, BombPlayerView } from "../../../../shared/server/gametype/BombModel";
import { BombModel } from "../../../../shared/server/gametype/BombModel";
import { clientKeyDisplayId, toClientKey } from "../../ClientEntityKey";
import { type MapMode, WEAPON_PICKUP_CLASSNAMES } from "../../shared/bsp/PickupTable";
import { debugLog } from "../DebugLog";
import {
  BaseGametype,
  type GameResult,
  type GametypeMapContext,
  type GametypeTickContext,
  type RoundOutcome,
} from "./BaseGametype";
import { PlayerLoadouts } from "./PlayerLoadouts";
import { siteCall } from "./SndCalls";
import { type Hold, holdsAt, type Lane, type LaneFile, lanesInto, loadLanes } from "./SndLanes";

// ── Match shape ──────────────────────────────────────────────────────
//
// Warsow ships 60 s rounds and a limit of 16. We keep 90 s and 10: the round
// length was chosen against the traversal times measured on the real maps, and
// a shorter match suits a game with no economy to build across a half. Both are
// one config field away from Warsow's values if a playtest disagrees.

const ROUND_TIME_SECONDS = 90;
const ROUNDS_PER_HALF = 9;
const ROUNDS_TO_WIN = 10;
const LEAD_REQUIRED = 2;
/**
 * "Get ready" freeze before each round. Long enough to read the map, agree a
 * site, and for the loadout you picked last round to be in your hands.
 */
const FREEZE_SECONDS = 10;
/**
 * The intermission after a round is decided.
 *
 * Covers the detonation finishing and the result being read. The client holds
 * its banner back until the explosion has played, so this is one phase rather
 * than the two Warsow uses (FINISHED then POST).
 */
const ROUND_END_SECONDS = 5;
/**
 * Friendly fire is on, so a mis-timed rocket at the start of a round can end a
 * teammate's whole round before they have moved. Warsow's `g_bomb_spawnprotection`.
 */
const TEAM_SPAWN_PROTECTION_SECONDS = 3;

// ── Directive tuning ─────────────────────────────────────────────────

/** Re-issued every snapshot while they apply; this is just the staleness bound. */
const DIRECTIVE_TICKS = 250;
/** How close to a site counts as being there. */
const SITE_ARRIVAL_RADIUS = 384;
/** Retaking an armed bomb outranks everything else a bot might want. */
const PRIORITY_DEFUSE = 0.95;
/** Arming is the win condition; only self-preservation should outweigh it. */
const PRIORITY_ARM = 0.9;
/** Fetching the bomb matters, but not more than not dying on the way. */
const PRIORITY_FETCH = 0.7;
/** Staying with the carrier: useful, but not at the cost of your own life. */
const PRIORITY_ESCORT = 0.55;
/** The coach's parts, switchable per team for head-to-head tests. */
export const COACH_PARTS = ["lanes", "cover", "defence", "memory", "crossfire", "holds"] as const;
export type CoachPart = (typeof COACH_PARTS)[number];
/** Bots in the carrier's group, the carrier with them. */
const MAIN_GROUP = 3;
/** How close to its staging point a group counts as staged. */
const STAGING_RADIUS = 250;
/** Groups go in this long after the attack plan is made, staged or not. */
const STAGING_DEADLINE_TICKS = 25 * TICK_RATE;
/** Once the carrier's group is staged, the others are waited for this long at most. */
const STAGING_WAIT_TICKS = 8 * TICK_RATE;
/** Attackers covering a dropped bomb while one fetches it, and defenders guarding it. */
const BOMB_COVER_COUNT = 2;
const BOMB_COVER_RADIUS = 350;
const BOMB_GUARD_RADIUS = 600;
/** A defender sees the carrier this far off, line of sight permitting. */
const SPOT_RANGE = 2500;
/** Eye height above a player's origin, for spotting traces. */
const EYE_HEIGHT = 40;
/** Spotting is traced this often, ticks. */
const SPOT_EVERY_TICKS = 10;
/** Rotators stay rotated this long after the carrier was last seen. */
const ROTATE_TICKS = 20 * TICK_RATE;
/** Defenders regroup outside an armed site while more than this is left on the fuse. */
const RETAKE_GO_TICKS = 14 * TICK_RATE;
/** Defenders regroup about this far from the armed bomb… */
const REGROUP_BACK = 900;
/** …and not within this of where the attack lanes stage. */
const REGROUP_CLEAR = 500;
/** How close to a regroup point a defender counts as there. */
const REGROUP_RADIUS = 300;
/** Attackers after a plant hold this far from the bomb towards each way in. */
const CROSSFIRE_SHARE = 0.55;
/** Holding a site pre-plant is a default, not an order. */
const PRIORITY_HOLD = 0.5;
/** How close to a hold a player counts as on it. */
const HOLD_RADIUS = 96;

/** Within this of the planted bomb you can arm or defuse it. */
const ARM_RADIUS = 64;
const DEFUSE_RADIUS = 64;
/**
 * How close the carrier is told to get to the site.
 *
 * Tighter than the site radius on purpose: a bot that stops at the edge of the
 * zone plants at the edge, where the bomb is easy to reach and easy to shoot.
 */
const PLANT_ARRIVAL_RADIUS = 96;

/**
 * A surface this flat counts as plantable ground (Warsow traces one unit down
 * and requires `normal.z >= 0.90`; our up axis is Y). Steep enough to exclude
 * ramps — deliberately, since it removes real plant spots.
 */
const PLANTABLE_NORMAL_Y = 0.9;
/**
 * How far to trace down from the player's ORIGIN to find the floor.
 *
 * The origin sits `PLAYER_ORIGIN_HEIGHT` (24) above the feet, so a trace has to
 * cover that before it reaches anything. It was 8 — which stopped sixteen units
 * short of the ground on every single call, reported airborne, and made
 * planting impossible for everyone. The extra margin below the feet covers
 * standing on a slight downslope.
 */
const GROUND_TRACE_DISTANCE = PLAYER_ORIGIN_HEIGHT + 8;

/** Simulation rate, for converting bomb timers to the seconds the HUD wants. */
const TICKS_PER_SECOND = TICK_RATE;

/**
 * The two CTF spawn sets, by the team id `SpawnPointTable` maps them to.
 *
 * Named for the ENTITY they come from rather than for a role, because the role
 * changes at the half and the entity never does.
 */
const ALPHA_TEAM: TeamId = "udon";
const BETA_TEAM: TeamId = "soba";

// ── Detonation ───────────────────────────────────────────────────────
//
// Warsow's numbers: 30 candidate points, ~20 of them fire, spread over 1.5 s
// within 512 units of the site. Only used on maps with no authored explosions,
// which is three of the six.

const EXPLOSION_CANDIDATES = 30;
const EXPLOSION_AVERAGE = 20;
const EXPLOSION_PROBABILITY = EXPLOSION_AVERAGE / EXPLOSION_CANDIDATES;
const EXPLOSION_MAX_DIST = 512;
const EXPLOSION_MAX_DELAY = 1.5;
const EXPLOSION_ORIGIN_LIFT = 96;
const EXPLOSION_FALLBACK_RADIUS = 300;
/** Snapshots the schedule keeps being sent for, against a dropped packet. */
const EXPLOSION_REPEAT_TICKS = TICKS_PER_SECOND;
/**
 * Damage at the centre of one blast, falling off to nothing at its radius.
 *
 * Chosen to gib: a player at the site is caught by several blasts of a chain,
 * and anything over a rocket's direct hit at the centre finishes them in one.
 * Players further out are hurt, and a wall between them and a blast saves them.
 */
const BLAST_DAMAGE = 250;
/** Height above a player's origin the second line-of-sight trace aims at. */
const BLAST_SIGHT_LIFT = 24;

// ── Scoring ──────────────────────────────────────────────────────────
//
// Warsow's bomb formula, plus objective points it defines and never awards.

/** A kill is worth half of what a hundred damage is. */
const FRAG_POINTS = 0.5;
/** 100 damage = 1 point. */
const DAMAGE_POINTS = 0.01;
/** Arming the bomb: about a good gunfight. */
const PLANT_POINTS = 2;
/** Defusing: more, because it is harder and it saves the round. */
const DEFUSE_POINTS = 3;

export class SearchAndDestroy extends BaseGametype {
  readonly name = "Search & Destroy";
  readonly maxPlayers = 10;
  readonly teamBased = true;
  override readonly mapMode: MapMode = { names: ["bomb", "snd"], kind: "team" };
  override readonly timeouts = true;

  private readonly bomb = new BombModel();
  private sites: BombSite[] = [];
  /** Where the bomb starts each round, by attacking team. */
  private bombSpawns = new Map<TeamId, Vec3Like>();
  private collision: CollisionWorld | null = null;
  /**
   * Attacking team, cached from the tick context.
   *
   * `getAgentDirectives` needs the round role but runs from snapshot building,
   * which has no `GametypeTickContext`. Rather than grow the shared bot-facing
   * context with a field only one mode uses, the tick — which always runs
   * first — leaves it here.
   */
  private attackers: TeamId | null = null;
  /** Latest tick, so the objective snapshot can report a live fuse. */
  private tick = 0;
  /** Current round, 0 during warmup. Gates everything the mode publishes. */
  private round = 0;
  /** Entity id → player id, rebuilt each tick alongside the bomb's world view. */
  private playerByEntity = new Map<number, PlayerId>();
  /** The detonation schedule, held for a few snapshots after it fires. */
  private explosion: BombExplosionEvent | null = null;
  private explosionUntilTick = 0;
  /** Blasts of the detonation still to go off, each at the tick it lands. */
  private pendingBlasts: { tick: number; at: Vec3Like; radius: number }[] = [];
  private brushModels = new BrushModelState([]);
  private pendingStructures: { tick: number; modelIndex: number }[] = [];
  /** Stable site assignments, rebalanced when the living roster changes. */
  private siteByDefender = new Map<number, number>();
  /** The map's lanes into the sites (config/bot-lanes), or null. */
  private lanes: LaneFile | null = null;
  /** Per team, the coach's parts it plays without (a test switch; all on by default). */
  private readonly coachOff = new Map<string, ReadonlySet<CoachPart>>();
  /**
   * The attack this round: which lane each attacker group takes, who is in
   * which group, and whether the groups have been sent in.
   */
  private attackPlan: {
    siteId: number;
    carrier: number;
    groupOf: Map<number, number>;
    lanes: Lane[];
    go: boolean;
    madeAtTick: number;
    /** When the carrier's group reached its staging point, or null. */
    carrierStagedAt: number | null;
    attackers: number;
  } | null = null;
  /** Whether an entity is a person's player (GameServer sets it); bots only otherwise. */
  private isPerson: (entityId: number) => boolean = () => false;
  /** Per attacking team, this match: rounds attacked at each site and plants made there. */
  private readonly siteRecord = new Map<string, Map<number, { attacks: number; plants: number }>>();
  /** Per defending team, this match: rounds each site was attacked. */
  private readonly siteHits = new Map<string, Map<number, number>>();
  /** A person's call for the attack site this round. */
  private calledSite: number | null = null;
  /** Where defenders last saw the carrier heading (its nearest site), this round. */
  private spotted: { siteId: number; tick: number } | null = null;
  /** Living attackers by entity id, for spreading them over ways in; and every living player's position. */
  private livingAttackers: number[] = [];
  private readonly positions = new Map<number, Vec3Like>();
  /** One defender a site who stays whatever is spotted. */
  private readonly anchors = new Set<number>();
  /** Defenders' holds this tick, by entity id: see `planDefence`. */
  private readonly holdOf = new Map<number, Hold>();
  /** The retake goes in: enough defenders regrouped, or the fuse is short. */
  private retakeGo = false;
  /** The bomb has been carried this round: a drop after that is a fight's, not the round's start. */
  private bombCarried = false;
  /** The groups were sent in this round: a new carrier does not stage again. */
  private attackSent = false;
  /** Attackers covering a dropped bomb, and defenders guarding it. */
  private bombCover = new Set<number>();
  private bombGuard = new Set<number>();
  /** The one attacker doing the job that needs exactly one person. */
  private bombWorkerId: number | null = null;
  /** Site the attack is committed to. */
  private targetSiteId: number | null = null;
  /** Per site id, where a player stands in it: see `standingSpot`. */
  private readonly standingSpots = new Map<number, Vec3Like>();
  /** A selected kit is granted on the next spawn. */
  private loadouts = new PlayerLoadouts();

  // ========================================================================
  // Configuration
  // ========================================================================

  getMatchConfig(): MatchConfig {
    return {
      warmupTimeout: 120,
      // In a round mode this is the FREEZE, not a 3-2-1: it runs before every
      // round, and players are spawned and held for its duration.
      countdownDuration: FREEZE_SECONDS,
      // Rounds to win, not frags. The lead requirement makes 10-9 not a win.
      scoreLimit: ROUNDS_TO_WIN,
      // ROUND length, not match length — the match ends on rounds won.
      timeLimit: ROUND_TIME_SECONDS,
      postGameDuration: 15,
      // No respawn inside a round; these only apply to warmup.
      respawnDelay: 2,
      maxRespawnDelay: 4,
      selfDamage: 1.0,
      roundEndDuration: ROUND_END_SECONDS,
      teamSpawnProtection: TEAM_SPAWN_PROTECTION_SECONDS,
      roundBased: true,
      loadouts: "respawn",
      roundsPerHalf: ROUNDS_PER_HALF,
      leadRequired: LEAD_REQUIRED,
    };
  }

  /**
   * The player's chosen kit: blade, one primary, one secondary.
   *
   * Warsow Bomb is a pure loadout mode — it zeroes every item mask. Ours
   * takes only the weapons off the map: the kit decides what you can fight
   * with, and the map's ammo, armor and health decide how long. An empty rocket
   * launcher is a reason to go somewhere dangerous.
   */
  getSpawnLoadout(playerId?: PlayerId): WeaponLoadout {
    return this.loadouts.spawnKit(playerId);
  }

  /**
   * Remember the next spawn kit. Live rounds do not respawn dead players;
   * their selected kit is granted when the next round spawns them.
   */
  override setPlayerLoadout(playerId: PlayerId, choice: LoadoutChoice): boolean {
    this.loadouts.choose(playerId, choice);
    return true;
  }

  /** True once this player has chosen. Gates spawning. */
  override hasChosenLoadout(playerId: PlayerId): boolean {
    return this.loadouts.has(playerId);
  }

  /** The kit that will be in force next round — for the HUD's confirmation. */
  getPendingLoadout(playerId: PlayerId): LoadoutChoice {
    return this.loadouts.next(playerId);
  }

  /**
   * One of each item per round, and no second chances.
   *
   * Item timing is a skill in a continuous mode; in a 90 s round it is not, and
   * a Red Armor on a 25 s timer would just be a coin flip on who spawned nearer.
   * Taking it once, and denying it, is the decision instead. The per-item times
   * below are inert under `round` — they stay accurate so switching the mode
   * back needs no other change.
   *
   * `alternating` is the other option worth playtesting: an item taken this
   * round is gone next round too, which turns a greedy pickup into a denial
   * that reaches into the following round. It is off because it makes rounds
   * alternately rich and poor, and because the second half inherits the first
   * half's depleted map — which quietly breaks the mirror the side swap exists
   * to provide.
   */
  getItemSpawnRules(): ItemSpawnRules {
    return {
      spawnFromBsp: true,
      respawnMode: "round",
      // No Quad. Every one of the six bomb maps carries exactly one, and in a
      // round with no respawns it is not a prize to fight over — it is a round
      // decided by who spawned nearer. The usual counterplay (die, come back,
      // wait the thirty seconds out) does not exist here, so 4x damage against
      // a team that cannot replace its losses ends the round on a timer nobody
      // contested. Remove `item_quad` from this list to try it.
      // No map weapons either: the kit is the arsenal (Loadout.ts).
      excludeClassnames: ["item_quad", ...WEAPON_PICKUP_CLASSNAMES],
      weaponRespawnTime: 20,
      ammoRespawnTime: 15,
      armorRespawnTime: 20,
      healthRespawnTime: 15,
      megaHealthRespawnTime: 40,
    };
  }

  getSpawnStrategy(): SpawnStrategyType {
    return "team";
  }

  /**
   * Attackers spawn in BETA's area, defenders in ALPHA's — whichever side is
   * which this half.
   *
   * Straight from Warsow's `GT_SelectSpawnPoint`, which crosses the sets
   * against the team labels. `INITIAL_ATTACKERS = TEAM_ALPHA` names the alpha
   * TEAM as the attackers but spawns them on `team_CTF_betaspawn`; reading the
   * constant and stopping there puts both teams in the wrong half of the map,
   * which is exactly what happened.
   *
   * The map data agrees: on wbomb2 the alpha spawns average ~3400 units from
   * the two sites and beta's ~3800, so alpha is the side that starts nearer the
   * ground it has to hold.
   */
  override resolveSpawnTeam(teamId: string): string {
    if (this.attackers === null) return teamId;
    return teamId === this.attackers ? BETA_TEAM : ALPHA_TEAM;
  }

  // ========================================================================
  // Map
  // ========================================================================

  /**
   * Read the bombsites and work out where the bomb starts for each side.
   *
   * A map without sites is a manifest bug — it is tagged for a mode it cannot
   * host. We log it loudly and carry on: the round loop still works, the bomb
   * simply never becomes plantable, which is a legible failure rather than a
   * crash at map load.
   */
  override onMapLoad(context: GametypeMapContext): void {
    this.collision = context.collision;
    this.lanes = context.mapName ? loadLanes(context.mapName) : null;
    this.brushModels = new BrushModelState(extractBrushModels(context.entities, context.models));
    this.pendingStructures = [];
    this.sites = [];
    this.standingSpots.clear();
    this.bombSpawns.clear();

    if (!isBombMap(context.entities)) {
      console.warn(`[S&D] Map has no bombsites — it is tagged for a mode it cannot host`);
      return;
    }

    this.sites = extractBombSites(context.entities, context.models);
    debugLog("setup", () => `[S&D] ${this.sites.length} bombsites: ${this.sites.map((s) => s.label).join(", ")}`);

    // The bomb starts where the ATTACKERS spawn, dropped to the floor. That is
    // beta's area every round, because attackers use beta's spawn set whichever
    // team they are (see `resolveSpawnTeam`). No entity marks it —
    // `team_CTF_*flag` was measured and rejected as inconsistently placed, and
    // absent on wbomb6 (design doc 5.6).
    for (const team of ["udon", "soba"] as const) {
      const points = context.teamSpawnPoints.get(team);
      const centre = points && points.length > 0 ? spawnCentroid(points) : null;
      if (!centre) {
        console.warn(`[S&D] No spawn points for ${team} — bomb will start at the world origin`);
        continue;
      }
      this.bombSpawns.set(team, this.dropToFloor(centre));
    }
  }

  // ========================================================================
  // Round
  // ========================================================================

  /**
   * Set up the round during its freeze.
   *
   * Placing the bomb on the attacking team's side is also what makes the
   * half-swap work: the bomb follows the ROLE, not the team, so at the swap it
   * simply appears on the other side of the map with nothing else to change.
   */
  override onRoundStart(_state: WorldState, context: GametypeTickContext): void {
    this.attackers = context.attackingTeam;
    this.round = context.round;
    this.pendingBlasts = [];
    this.pendingStructures = [];
    this.brushModels.reset();
    this.collision?.brushModels?.reset();
    this.siteByDefender.clear();
    this.targetSiteId = null;
    this.recordRound();
    this.calledSite = null;
    this.spotted = null;
    this.anchors.clear();
    this.holdOf.clear();
    this.retakeGo = false;
    this.attackPlan = null;
    this.attackSent = false;
    this.bombCarried = false;
    this.bombCover.clear();
    this.bombGuard.clear();
    this.bomb.reset(this.bombSpawns.get(BETA_TEAM) ?? { x: 0, y: 0, z: 0 });
  }

  /**
   * Advance the bomb and report any round it decides.
   *
   * Only ends a live round; the controller enforces that too.
   */
  override onTick(state: WorldState, context: GametypeTickContext): RoundOutcome | null {
    this.attackers = context.attackingTeam;
    this.tick = context.tick as number;
    this.round = context.round;
    this.updateStructures();
    if (!context.live) {
      this.fireBlasts(state, context);
      return null;
    }

    const players = this.collectPlayers(state, context);
    const events = this.bomb.update(context.tick as number, players, this.sites, context.attackingTeam);
    this.logBombEvents(events);

    // Team assignments, settled once per tick before any per-player directive
    // is asked for. Order matters: this must see the bomb AFTER it moved.
    this.assignRoles(players, context);

    const fromBomb = this.outcomeFromEvents(events, context);
    if (fromBomb) return fromBomb;

    return this.outcomeFromElimination(players, context);
  }

  /**
   * The round timer ran out.
   *
   * Returning null means "the round continues", which is the whole point of the
   * armed case: once the bomb is ticking the round clock is irrelevant and the
   * bomb's own timer takes over as the pacing device. Otherwise the attackers
   * failed to arm, and that is a defensive win.
   */
  override onRoundTimeExpired(_state: WorldState): RoundOutcome | null {
    if (this.bomb.isArmed) return null;
    return {
      winner: this.attackers === "udon" ? "soba" : "udon",
      reason: "time expired, bomb not armed",
      resultKey: "timeout",
    };
  }

  /**
   * The bomb, for the client to draw.
   *
   * Everything time-based is converted to seconds here rather than shipping
   * ticks: the client has no tick rate to divide by, and a HUD that has to know
   * the simulation rate is a HUD that breaks when the rate changes.
   */
  override getObjectiveState(): ObjectiveSnapshot | null {
    // Nothing before the first round. `BombModel` starts life "dropped" at the
    // world origin, so publishing unconditionally put a spinning bomb at 0,0,0
    // through the whole warmup, with both site markers up and the HUD saying
    // TAKE THE BOMB — which reads as a broken round rather than as a warmup.
    //
    // Warmup in this mode is the same free-fight duel and FFA get: teams and
    // team spawns, no objective, no scoring. The mode's furniture arrives when
    // the mode does.
    if (this.round <= 0) return null;

    const fuseTicks = this.bomb.ticksUntilDetonation(this.tick);
    const beepTicks = this.bomb.beepIntervalTicks(this.tick);
    return {
      kind: "bomb",
      disabledModels: this.brushModels.snapshot(),
      phase: this.bomb.phase,
      x: this.bomb.position.x,
      y: this.bomb.position.y,
      z: this.bomb.position.z,
      siteId: this.bomb.siteId,
      carrier: this.bomb.carrierId === null ? null : toClientKey(this.bomb.carrierId as EntityId),
      progress: this.bomb.progress,
      advancing: this.bomb.progressAdvancing,
      worker: this.bomb.workerId === null ? null : toClientKey(this.bomb.workerId as EntityId),
      fuse: fuseTicks === null ? null : fuseTicks / TICKS_PER_SECOND,
      beepInterval: beepTicks === null ? null : beepTicks / TICKS_PER_SECOND,
      sites: this.sites.map((site) => ({
        id: site.id,
        label: site.label,
        x: site.position.x,
        y: site.position.y,
        z: site.position.z,
      })),
    };
  }

  /**
   * The detonation, for as long as it is worth repeating.
   *
   * Repeated across several snapshots rather than sent once, because a dropped
   * packet would otherwise cost the client the entire explosion — and this is
   * the one moment of the mode that the whole intermission exists to show.
   */
  override getExplosion(): BombExplosionEvent | null {
    return this.explosion && this.tick <= this.explosionUntilTick ? this.explosion : null;
  }

  /**
   * Where the blasts go.
   *
   * Authored points win where a mapper provided them: wbomb1 has eight per
   * site with staggered delays, which reads as a chain reaction tearing
   * through the room. Half the shipped maps have none, so the fallback traces
   * outward from the site and keeps whatever the geometry allows — the same
   * split Warsow makes, and the reason its source nags mappers to author them.
   */
  private buildExplosion(siteId: number | null): BombExplosionEvent {
    const site = this.sites.find((s) => s.id === siteId);
    const origin = site?.position ?? this.bomb.position;

    if (site && site.explosions.length > 0) {
      return {
        points: site.explosions.map((point) => ({
          x: point.position.x,
          y: point.position.y,
          z: point.position.z,
          radius: point.radius,
          delay: point.delay,
        })),
      };
    }

    // Deterministic: seeded from the tick and the site, so a re-simulated demo
    // produces the same explosion rather than a different one each replay.
    const rng = rngFrom(this.tick, siteId ?? 0, 0);
    const points: BombExplosionEvent["points"] = [];
    const from = { x: origin.x, y: origin.y + EXPLOSION_ORIGIN_LIFT, z: origin.z };

    for (let i = 0; i < EXPLOSION_CANDIDATES; i++) {
      if (rng() >= EXPLOSION_PROBABILITY) continue;

      // A direction with a non-negative vertical component, so blasts climb
      // through the room rather than burying themselves in the floor.
      const dir = { x: rng() * 2 - 1, y: rng(), z: rng() * 2 - 1 };
      const length = Math.hypot(dir.x, dir.y, dir.z) || 1;
      const reach = EXPLOSION_MAX_DIST / length;
      const end = { x: from.x + dir.x * reach, y: from.y + dir.y * reach, z: from.z + dir.z * reach };

      // Stop at the first wall, then pick a point somewhere along the way —
      // an explosion inside geometry is invisible, which is the whole failure.
      const fraction = this.collision ? Math.min(1, this.collision.trace(from, end).fraction) : 1;
      const t = rng() * fraction;
      points.push({
        x: from.x + (end.x - from.x) * t,
        y: from.y + (end.y - from.y) * t,
        z: from.z + (end.z - from.z) * t,
        radius: EXPLOSION_FALLBACK_RADIUS,
        delay: rng() * EXPLOSION_MAX_DELAY,
      });
    }

    // Always at least one, at the bomb itself. A silent detonation would read
    // as a bug on a map where every trace happened to fail.
    if (points.length === 0) {
      points.push({ x: origin.x, y: origin.y, z: origin.z, radius: EXPLOSION_FALLBACK_RADIUS, delay: 0 });
    }
    return { points };
  }

  /**
   * Line the blasts up with the client's: each lands `delay` seconds after the
   * detonation, which is when every client plays it.
   */
  private scheduleBlasts(explosion: BombExplosionEvent): void {
    this.pendingBlasts = explosion.points.map((point) => ({
      tick: this.tick + Math.round(Math.max(0, point.delay) * TICKS_PER_SECOND),
      at: { x: point.x, y: point.y, z: point.z },
      radius: point.radius,
    }));
  }

  /**
   * Hurt whoever is caught by the blasts that are due.
   *
   * Only outside a live round. A detonation ends the round on its own tick, so
   * every blast lands in the intermission, where a death changes neither the
   * result nor anyone's score; this check keeps it that way should that order
   * ever change.
   *
   * Q3's splash rule: damage falls off with distance from the blast, and a
   * blast does nothing through a wall. Two sight lines, origin and chest, so a
   * low railing does not shelter someone standing behind it.
   */
  private fireBlasts(state: WorldState, context: GametypeTickContext): void {
    if (this.pendingBlasts.length === 0) return;
    const now = context.tick as number;
    const due = this.pendingBlasts.filter((blast) => blast.tick <= now);
    if (due.length === 0) return;
    this.pendingBlasts = this.pendingBlasts.filter((blast) => blast.tick > now);

    for (const entity of state.entitiesByType(EntityType.Player)) {
      if (entity.ownerId === undefined || !entity.health || entity.health.dead) continue;
      const position = entity.transform?.position;
      if (!position) continue;

      for (const blast of due) {
        const dx = position.x - blast.at.x;
        const dy = position.y - blast.at.y;
        const dz = position.z - blast.at.z;
        const distance = Math.hypot(dx, dy, dz);
        if (distance >= blast.radius) continue;
        const damage = Math.round(BLAST_DAMAGE * (1 - distance / blast.radius));
        if (damage < 1 || !this.blastReaches(blast.at, position)) continue;
        context.blast(entity.id as EntityId, damage, { x: dx, y: dy, z: dz });
      }
    }
  }

  private blastReaches(from: Vec3Like, to: Vec3Like): boolean {
    if (!this.collision) return true;
    if (this.collision.trace(from, to).fraction >= 1) return true;
    const chest = { x: to.x, y: to.y + BLAST_SIGHT_LIFT, z: to.z };
    return this.collision.trace(from, chest).fraction >= 1;
  }

  /**
   * What the round is currently about. The plant is the pivot: before it the
   * attackers hold the initiative, after it the roles invert and the HUD should
   * say so.
   */
  override getRoundState(): string | null {
    if (this.round <= 0) return null;
    return this.bomb.isArmed ? "post_plant" : "pre_plant";
  }

  /** Bomb state for the HUD and for round-end reporting. */
  get bombState(): {
    phase: string;
    position: Vec3Like;
    siteId: number | null;
    carrierId: number | null;
    progress: number;
  } {
    return {
      phase: this.bomb.phase,
      position: this.bomb.position,
      siteId: this.bomb.siteId,
      carrierId: this.bomb.carrierId,
      progress: this.bomb.progress,
    };
  }

  /**
   * Say what the bomb did.
   *
   * The round outcome alone cannot distinguish "the attackers never found the
   * bomb" from "they carried it to a site and died on the plant", and those are
   * completely different problems. One line per event, and there are at most a
   * handful per round.
   */
  private logBombEvents(events: readonly BombEvent[]): void {
    for (const event of events) {
      const who = event.entityId === undefined ? "" : ` by entity ${event.entityId}`;
      const site = event.siteId === null || event.siteId === undefined ? "" : ` at site ${event.siteId}`;
      console.log(`[S&D] bomb ${event.kind}${who}${site}`);
    }
  }

  /** A round ended on the bomb: a defuse, or a detonation. */
  private outcomeFromEvents(events: readonly BombEvent[], context: GametypeTickContext): RoundOutcome | null {
    for (const event of events) {
      // Credit the work before deciding the round: a defuse both ends the
      // round and earns the defuser their points, and returning first would
      // skip the second.
      if (event.kind === "armed" || event.kind === "defused") {
        const playerId = event.entityId === undefined ? undefined : this.playerByEntity.get(event.entityId);
        if (playerId !== undefined) context.credit(playerId, event.kind === "armed" ? "plant" : "defuse");
      }

      switch (event.kind) {
        case "detonated":
          this.scheduleStructures(this.bomb.siteId);
          this.explosion = this.buildExplosion(this.bomb.siteId);
          this.explosionUntilTick = (this.tick as number) + EXPLOSION_REPEAT_TICKS;
          this.scheduleBlasts(this.explosion);
          return {
            winner: context.attackingTeam,
            reason: "bomb detonated",
            resultKey: "detonated",
            focus: { ...this.bomb.position },
          };
        case "defused":
          return {
            winner: context.defendingTeam,
            reason: "bomb defused",
            resultKey: "defused",
            focus: { ...this.bomb.position },
          };
        default:
          break;
      }
    }
    return null;
  }

  /**
   * A round ended on bodies.
   *
   * Asymmetric, and deliberately so (Warsow `checkPlayersAlive`): killing every
   * defender wins outright, because nothing can stop the plant. Killing every
   * attacker only wins if the bomb is NOT armed — otherwise the defenders still
   * have to walk over and defuse it, which is the tensest thing in the mode.
   */
  private outcomeFromElimination(
    players: readonly BombPlayerView[],
    context: GametypeTickContext,
  ): RoundOutcome | null {
    let attackersAlive = 0;
    let defendersAlive = 0;
    for (const player of players) {
      if (!player.alive) continue;
      if (player.team === context.attackingTeam) attackersAlive++;
      else if (player.team === context.defendingTeam) defendersAlive++;
    }

    // Nobody has joined yet — an empty round is not a won round.
    if (attackersAlive === 0 && defendersAlive === 0) return null;

    if (defendersAlive === 0) {
      return { winner: context.attackingTeam, reason: "defenders eliminated", resultKey: "eliminated" };
    }
    if (attackersAlive === 0 && !this.bomb.isArmed) {
      return { winner: context.defendingTeam, reason: "attackers eliminated", resultKey: "eliminated" };
    }
    return null;
  }

  /** The world as the bomb rules need to see it. */
  private collectPlayers(state: WorldState, context: GametypeTickContext): BombPlayerView[] {
    const views: BombPlayerView[] = [];
    this.playerByEntity.clear();

    for (const entity of state.entitiesByType(EntityType.Player)) {
      if (entity.ownerId === undefined) continue;
      const position = entity.transform?.position;
      if (!position) continue;

      // Full velocity, not the horizontal component: Warsow compares the whole
      // vector, so falling fast is also too fast to plant.
      const velocity = entity.physics?.velocity;
      const speed = velocity ? Math.hypot(velocity.x, velocity.y, velocity.z) : 0;

      this.playerByEntity.set(entity.id as number, entity.ownerId as PlayerId);
      const isCarrier = this.bomb.carrierId === (entity.id as number);
      views.push({
        entityId: entity.id as number,
        team: context.teamOf(entity.ownerId as PlayerId),
        position,
        speed,
        alive: !entity.health?.dead,
        // Only the carrier's value is ever read, and only while they are slow
        // enough to plant — so the trace is skipped for everyone else rather
        // than run once per player per tick.
        onPlantableGround: isCarrier && speed <= 400 ? this.isPlantableGround(position) : false,
        // Likewise traced only for the carrier: nobody else can put the bomb
        // down, so nobody else's floor is ever asked for.
        groundPosition: isCarrier ? this.dropToFloor(position) : position,
      });
    }

    return views;
  }

  // ========================================================================
  // Directives — how the mode talks to bots
  // ========================================================================

  /**
   * Work out who does what this tick, once for the whole team.
   *
   * `getAgentDirectives` is called per player, so anything requiring a TEAM
   * decision — who fetches the bomb, which defender covers which site — has to
   * be settled before it runs or each player would decide independently and
   * they would all decide the same thing. Every attacker running at the bomb is
   * the failure mode this exists to prevent.
   *
   * Assignment is by proximity where proximity is what matters, and by a stable
   * roster order where spread is what matters. Never randomly: a random split
   * can put every defender on the same site, which is the one outcome the split
   * exists to rule out.
   */
  private assignRoles(players: readonly BombPlayerView[], context: GametypeTickContext): void {
    const attackers: BombPlayerView[] = [];
    const defenders: BombPlayerView[] = [];
    for (const player of players) {
      if (!player.alive) continue;
      if (player.team === context.attackingTeam) attackers.push(player);
      else if (player.team === context.defendingTeam) defenders.push(player);
    }

    // Stable order, so an assignment does not shuffle between ticks and leave
    // bots swapping sites forever. Entity id is arbitrary but constant.
    defenders.sort((a, b) => a.entityId - b.entityId);

    const living = new Set(defenders.map((player) => player.entityId));
    for (const id of this.siteByDefender.keys()) {
      if (!living.has(id)) this.siteByDefender.delete(id);
    }
    if (this.sites.length > 0) {
      const counts = new Map(this.sites.map((site) => [site.id, 0]));
      for (const siteId of this.siteByDefender.values()) counts.set(siteId, (counts.get(siteId) ?? 0) + 1);
      for (const defender of defenders) {
        if (this.siteByDefender.has(defender.entityId)) continue;
        // Fewest defenders first; on a tie, the site this attack has hit more.
        const hits = this.coaches(context.defendingTeam, "defence")
          ? this.siteHits.get(context.defendingTeam)
          : undefined;
        const site = this.sites.reduce((best, candidate) => {
          const c = counts.get(candidate.id) ?? 0;
          const b = counts.get(best.id) ?? 0;
          if (c !== b) return c < b ? candidate : best;
          return (hits?.get(candidate.id) ?? 0) > (hits?.get(best.id) ?? 0) ? candidate : best;
        });
        this.siteByDefender.set(defender.entityId, site.id);
        counts.set(site.id, (counts.get(site.id) ?? 0) + 1);
      }
      // Move only surplus defenders when casualties leave an uneven split.
      // Unaffected assignments remain stable rather than rotating every tick.
      while (true) {
        const ordered = [...this.sites].sort((a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0));
        const least = ordered[0].id;
        const most = ordered[ordered.length - 1].id;
        if ((counts.get(most) ?? 0) - (counts.get(least) ?? 0) <= 1) break;
        const transfer = [...defenders].reverse().find((player) => this.siteByDefender.get(player.entityId) === most);
        if (!transfer) break;
        this.siteByDefender.set(transfer.entityId, least);
        counts.set(most, (counts.get(most) ?? 0) - 1);
        counts.set(least, (counts.get(least) ?? 0) + 1);
      }
    }

    // The one attacker nearest the bomb does the job that needs exactly one
    // person: collecting it, or standing on it to arm. Everybody else is then
    // free to cover, rather than stacking on the same 64 units of floor.
    this.bombWorkerId = this.nearestTo(attackers, this.bomb.position);

    // Which site the attack commits to, once a round: nearest the bomb as the
    // round starts. Chosen again every tick, it followed the carrier and
    // flipped sites on the way.
    this.targetSiteId ??= this.chooseSite(context.attackingTeam);
    this.livingAttackers = attackers.map((a) => a.entityId).sort((a, b) => a - b);
    this.positions.clear();
    for (const p of [...attackers, ...defenders]) this.positions.set(p.entityId, p.position);
    this.planAttack(attackers, context.attackingTeam);
    this.planBombCover(attackers, defenders, context);
    this.planDefence(attackers, defenders, context);
  }

  /**
   * Play a team without the coach: no lanes, staging or bomb cover, as a
   * test switch for head-to-head runs (`bot:ab` arm option `"coach": false`).
   */
  setTeamCoach(team: string, on: boolean | readonly CoachPart[]): void {
    if (on === true) this.coachOff.delete(team);
    else this.coachOff.set(team, new Set(COACH_PARTS.filter((part) => on === false || !on.includes(part))));
  }

  /** Whether `team` plays this part of the coach. */
  private coaches(team: string, part: CoachPart): boolean {
    return !this.coachOff.get(team)?.has(part);
  }

  /** GameServer tells the mode which players are people's. */
  override setPersonCheck(check: (entityId: number) => boolean): void {
    this.isPerson = check;
  }

  /**
   * A team chat line. A site call ("a", "go b", ...) from the attacking team
   * sets this round's target, from the defending team sends the rotators.
   */
  override onTeamChat(_entityId: number, team: string, text: string): void {
    const label = siteCall(text);
    const site = label ? this.sites.find((s) => s.label.toUpperCase() === label) : undefined;
    if (!site || this.bomb.phase === "planted" || this.bomb.isArmed) return;
    if (team === this.attackers) {
      this.calledSite = site.id;
      if (this.targetSiteId !== site.id) {
        this.targetSiteId = site.id;
        this.attackPlan = null;
      }
    } else this.spotted = { siteId: site.id, tick: this.tick };
  }

  /**
   * The site to attack this round: a person's call, else the one with the
   * best record against this defence this match (plants per attack, with an
   * optimism that tries a site not yet tried), with a little chance so the
   * attack cannot be read from the last round alone.
   */
  private chooseSite(attackingTeam: string): number | null {
    if (this.calledSite !== null) return this.calledSite;
    if (this.sites.length === 0) return null;
    if (!this.coaches(attackingTeam, "memory")) return this.nearestSite(this.bomb.position)?.id ?? null;
    const record = this.siteRecord.get(attackingTeam);
    const total = [...(record?.values() ?? [])].reduce((sum, r) => sum + r.attacks, 0);
    let best = this.sites[0].id;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const site of this.sites) {
      const r = record?.get(site.id) ?? { attacks: 0, plants: 0 };
      const score =
        (r.plants + 1) / (r.attacks + 2) +
        0.4 * Math.sqrt(Math.log(total + 1) / (r.attacks + 1)) +
        0.15 * Math.random();
      if (score > bestScore) {
        bestScore = score;
        best = site.id;
      }
    }
    return best;
  }

  /** At a round's start, before the reset: what the last round's attack did, for chooseSite and the defence split. */
  private recordRound(): void {
    const site = this.targetSiteId;
    const attackers = this.attackers;
    if (site === null || attackers === null) return;
    const defenders = (["udon", "soba"] as const).find((t) => t !== attackers);
    const planted =
      this.bomb.phase === "planted" ||
      this.bomb.isArmed ||
      this.bomb.phase === "detonated" ||
      this.bomb.phase === "defused";
    const at = planted ? (this.bomb.siteId ?? site) : site;
    const record = this.siteRecord.get(attackers) ?? new Map<number, { attacks: number; plants: number }>();
    const entry = record.get(at) ?? { attacks: 0, plants: 0 };
    entry.attacks++;
    if (planted) entry.plants++;
    record.set(at, entry);
    this.siteRecord.set(attackers, record);
    if (defenders) {
      const hits = this.siteHits.get(defenders) ?? new Map<number, number>();
      hits.set(at, (hits.get(at) ?? 0) + 1);
      this.siteHits.set(defenders, hits);
    }
  }

  /**
   * Defence: one anchor a site who never leaves it; the carrier seen by a
   * defender (line of sight, as a person would see and call it) sends the
   * other defenders to the site nearest the carrier; and an armed bomb is
   * retaken together.
   */
  private planDefence(
    attackers: readonly BombPlayerView[],
    defenders: readonly BombPlayerView[],
    context: GametypeTickContext,
  ): void {
    this.anchors.clear();
    this.holdOf.clear();
    if (!this.coaches(context.defendingTeam, "defence")) return;
    for (const site of this.sites) {
      const assigned = defenders
        .filter((d) => this.siteByDefender.get(d.entityId) === site.id)
        .sort((a, b) => a.entityId - b.entityId);
      if (assigned.length > 0) this.anchors.add(assigned[0].entityId);
    }
    // Holds: the defenders bound for a site take its holds in turn, the anchor
    // the best; any more than there are holds keep to the site.
    if (this.coaches(context.defendingTeam, "holds")) {
      for (const site of this.sites) {
        const holds = holdsAt(this.lanes, site.id, "defend");
        const bound = defenders
          .filter((d) => this.defendSiteOf(d.entityId) === site.id)
          .sort(
            (a, b) =>
              Number(this.anchors.has(b.entityId)) - Number(this.anchors.has(a.entityId)) || a.entityId - b.entityId,
          );
        bound.slice(0, holds.length).forEach((d, i) => {
          this.holdOf.set(d.entityId, holds[i]);
        });
      }
    }
    const carrier = attackers.find((a) => a.entityId === this.bomb.carrierId);
    if (carrier && this.tick % SPOT_EVERY_TICKS === 0 && this.collision) {
      const eye = (p: Vec3Like): Vec3 => ({ x: p.x, y: p.y + EYE_HEIGHT, z: p.z });
      const seen = defenders.some(
        (d) =>
          Math.hypot(d.position.x - carrier.position.x, d.position.z - carrier.position.z) <= SPOT_RANGE &&
          (this.collision?.trace(eye(d.position), eye(carrier.position)).fraction ?? 0) >= 1,
      );
      const near = seen ? this.nearestSite(carrier.position) : null;
      if (near) this.spotted = { siteId: near.id, tick: this.tick };
    }
    if (this.bomb.isArmed && !this.retakeGo) {
      const fuse = this.bomb.ticksUntilDetonation(this.tick) ?? 0;
      const points = this.regroupPoints();
      const there = defenders.filter((d) =>
        points.some((p) => Math.hypot(d.position.x - p.x, d.position.z - p.z) <= REGROUP_RADIUS),
      ).length;
      if (fuse <= RETAKE_GO_TICKS || points.length === 0 || there >= Math.min(2, defenders.length))
        this.retakeGo = true;
    }
  }

  /** The site a defender is bound for: its own, or the spotted carrier's while rotating. */
  private defendSiteOf(entityId: number): number | null {
    const rotate =
      this.spotted !== null && !this.anchors.has(entityId) && this.tick - this.spotted.tick <= ROTATE_TICKS;
    return rotate && this.spotted ? this.spotted.siteId : (this.siteByDefender.get(entityId) ?? null);
  }

  /**
   * Where defenders gather before retaking the armed site: on each defend
   * lane, the waypoint about REGROUP_BACK from the bomb, and none near where
   * the attack lanes stage. At the defend lanes' staging points they gathered
   * where the attackers had come in and were holding (snd6: the same points).
   */
  private regroupPoints(): readonly Vec3Like[] {
    const site = this.bomb.siteId;
    if (site === null) return [];
    const bomb = this.bomb.position;
    const away = (p: Vec3Like) => Math.hypot(p.x - bomb.x, p.z - bomb.z);
    const attackStaging = lanesInto(this.lanes, site, "attack").map((l) => l.staging);
    const points: Vec3Like[] = [];
    for (const lane of lanesInto(this.lanes, site, "defend")) {
      const candidates = [...lane.via, lane.staging].filter((p) =>
        attackStaging.every((a) => Math.hypot(a.x - p.x, a.z - p.z) >= REGROUP_CLEAR),
      );
      if (candidates.length === 0) continue;
      points.push(
        candidates.reduce((best, p) =>
          Math.abs(away(p) - REGROUP_BACK) < Math.abs(away(best) - REGROUP_BACK) ? p : best,
        ),
      );
    }
    return points;
  }

  /** The ways defenders come into the armed site, for the attackers' crossfire: the defend lanes' staging points. */
  private waysIn(): readonly Vec3Like[] {
    const site = this.bomb.siteId;
    return site === null ? [] : lanesInto(this.lanes, site, "defend").map((l) => l.staging);
  }

  private positionOf(entityId: number | null): Vec3Like | null {
    return entityId === null ? null : (this.positions.get(entityId) ?? null);
  }

  /** The point a player regroups at: the nearest regroup point. */
  private nearestPoint(points: readonly Vec3Like[], from: Vec3Like | null): Vec3Like | null {
    if (points.length === 0) return null;
    if (!from) return points[0];
    return points.reduce((best, p) =>
      Math.hypot(p.x - from.x, p.z - from.z) < Math.hypot(best.x - from.x, best.z - from.z) ? p : best,
    );
  }

  /**
   * The attack plan while the bomb is carried: groups of two on separate
   * lanes into the target site, each waiting at its staging point until the
   * carrier's group and one more are staged (or the others have had
   * STAGING_WAIT_TICKS to catch up), the deadline passes or an attacker falls.
   * Group 0 is the carrier and the attacker nearest them, on the shortest
   * lane. People are not grouped, and a person carrying goes when they like.
   */
  private planAttack(attackers: readonly BombPlayerView[], attackingTeam: string): void {
    // One way in is no reason to split: the team goes together, as without a plan.
    const carrier = this.bomb.carrierId;
    const site = this.targetSiteId;
    const lanes = site === null ? [] : lanesInto(this.lanes, site, "attack");
    if (carrier === null || site === null || lanes.length < 2 || !this.coaches(attackingTeam, "lanes")) {
      this.attackPlan = null;
      return;
    }
    let plan = this.attackPlan;
    if (!plan || plan.siteId !== site || plan.carrier !== carrier) {
      const carrierView = attackers.find((a) => a.entityId === carrier);
      // People are not told to wait: only bots go in groups.
      const others = attackers.filter((a) => a.entityId !== carrier && !this.isPerson(a.entityId));
      const partner = carrierView ? this.nearestTo(others, carrierView.position) : null;
      const rest = others.filter((a) => a.entityId !== partner).sort((a, b) => a.entityId - b.entityId);
      const groupOf = new Map<number, number>([[carrier, 0]]);
      if (partner !== null) groupOf.set(partner, 0);
      // The carrier's group takes MAIN_GROUP bots; the rest flank in pairs.
      const main = rest.slice(0, Math.max(0, MAIN_GROUP - (partner === null ? 1 : 2)));
      for (const a of main) groupOf.set(a.entityId, 0);
      rest.slice(main.length).forEach((a, i) => {
        groupOf.set(a.entityId, 1 + Math.floor(i / 2));
      });
      plan = {
        siteId: site,
        carrier,
        groupOf,
        lanes: [...lanes],
        // A person carrying the bomb goes when they like; the bots go with them.
        go: this.attackSent || this.isPerson(carrier),
        madeAtTick: plan?.madeAtTick ?? this.tick,
        carrierStagedAt: plan?.carrierStagedAt ?? null,
        attackers: plan?.attackers ?? attackers.length,
      };
      this.attackPlan = plan;
    }
    if (plan.go) return;
    const staged = new Map<number, boolean>();
    for (const a of attackers) {
      const group = plan.groupOf.get(a.entityId);
      if (group === undefined) continue;
      const stage = this.laneFor(plan, group).staging;
      const near = Math.hypot(a.position.x - stage.x, a.position.z - stage.z) <= STAGING_RADIUS;
      staged.set(group, (staged.get(group) ?? false) || near);
    }
    // Go with the carrier's group and one more, or once the others have had
    // STAGING_WAIT_TICKS to catch up: waiting for the farthest lane gave the
    // defence the time, and a 90 s round ran out.
    if (staged.get(0)) plan.carrierStagedAt ??= this.tick;
    const another = [...staged].some(([group, there]) => group > 0 && there);
    const carrierReady =
      plan.carrierStagedAt !== null && (another || this.tick - plan.carrierStagedAt > STAGING_WAIT_TICKS);
    const late = this.tick - plan.madeAtTick > STAGING_DEADLINE_TICKS;
    const contact = attackers.length < plan.attackers;
    if (carrierReady || late || contact) {
      plan.go = true;
      this.attackSent = true;
    }
  }

  private laneFor(plan: NonNullable<SearchAndDestroy["attackPlan"]>, group: number): Lane {
    return plan.lanes[group % plan.lanes.length];
  }

  /** Who covers a dropped bomb while it is fetched, and who guards it, by nearness. */
  private planBombCover(
    attackers: readonly BombPlayerView[],
    defenders: readonly BombPlayerView[],
    context: GametypeTickContext,
  ): void {
    this.bombCover.clear();
    this.bombGuard.clear();
    if (this.bomb.phase === "carried") this.bombCarried = true;
    // At the round's start the bomb lies at the attackers' spawn: nothing to cover or guard.
    if (this.bomb.phase !== "dropped" || !this.bombCarried) return;
    const byDistance = (list: readonly BombPlayerView[]) =>
      [...list].sort(
        (a, b) =>
          Math.hypot(a.position.x - this.bomb.position.x, a.position.z - this.bomb.position.z) -
          Math.hypot(b.position.x - this.bomb.position.x, b.position.z - this.bomb.position.z),
      );
    if (this.coaches(context.attackingTeam, "cover")) {
      for (const a of byDistance(attackers.filter((p) => p.entityId !== this.bombWorkerId)).slice(
        0,
        BOMB_COVER_COUNT,
      )) {
        this.bombCover.add(a.entityId);
      }
    }
    if (this.coaches(context.defendingTeam, "cover")) {
      for (const d of byDistance(defenders).slice(0, BOMB_COVER_COUNT)) this.bombGuard.add(d.entityId);
    }
  }

  /** Entity id of whoever in `candidates` is nearest `point`, or null. */
  private nearestTo(candidates: readonly BombPlayerView[], point: Vec3Like): number | null {
    let best: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const dx = candidate.position.x - point.x;
      const dy = candidate.position.y - point.y;
      const dz = candidate.position.z - point.z;
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate.entityId;
      }
    }
    return best;
  }

  /**
   * Orders for one agent.
   *
   * The whole mode's bot intelligence is this function plus the weight profiles
   * — no S&D code runs inside the bot process. Two things it does that a naive
   * emitter would not, and that decide whether bots look like a team:
   *
   * - **Jobs that need one person go to one person.** Fetching the bomb and
   *   standing on it to arm are assigned to the nearest attacker; the rest are
   *   told to cover the ground around it. Otherwise five bots pile onto the
   *   same spot and nobody watches the door.
   * - **Defenders are split across sites deterministically.** Emitting both
   *   sites and hoping the bots choose differently does not spread them — they
   *   run the same arbitration on the same inputs and reach the same answer.
   *
   * Priorities encode the mode's hierarchy (defuse > arm > fetch > hold); the
   * bot still weighs them against staying alive and against being able to get
   * there, which is the arbitration the goal framework exists to do.
   */
  override getAgentDirectives(context: AgentDirectiveContext, _state: WorldState): readonly AgentDirective[] {
    if (!context.alive || !context.teamId || context.teamId === "spectator") return [];
    // Both of these silently disarm every bot on the server, and neither is
    // visible from the outside: a bot with no orders looks like a bot that
    // decided to stand still. Rate-limited, so a genuinely broken map says so
    // once every few seconds rather than once per player per snapshot.
    if (this.sites.length === 0 || this.attackers === null) {
      log.warnRateLimited(
        "SnD",
        `no directives issued — sites=${this.sites.length} attackers=${this.attackers ?? "unset"} round=${this.round}`,
      );
      return [];
    }

    const attacking = context.teamId === this.attackers;
    const expiresAtTick = context.tick + DIRECTIVE_TICKS;
    const bomb = this.bomb.position;
    const me = this.entityIdOf(context.entityId);

    // A placed bomb identifies the attacked site before its arming meter is
    // complete. Defenders rotate now, rather than holding the other site until
    // the fuse starts. Proximity only defuses once the bomb is actually armed.
    if (!attacking && this.bomb.phase === "planted") {
      return [
        this.directive("snd_contest_plant", "move_to", bomb, DEFUSE_RADIUS, PRIORITY_DEFUSE, expiresAtTick, "never"),
      ];
    }

    // ── Armed: the round has inverted ──────────────────────────────
    if (this.bomb.isArmed) {
      if (!attacking) {
        // Regroup outside first, while the fuse allows: retaking one by one
        // feeds the attackers a kill at a time.
        if (!this.retakeGo) {
          const point = this.nearestPoint(this.regroupPoints(), this.positionOf(me));
          if (point) {
            return [
              this.directive(
                "snd_regroup",
                "move_to",
                point,
                REGROUP_RADIUS / 2,
                PRIORITY_DEFUSE,
                expiresAtTick,
                "enemy_visible",
              ),
            ];
          }
        }
        // The retake. The only order in the mode a bot should die for: with the
        // bomb ticking there is nothing left to preserve itself for.
        return [this.directive("snd_defuse", "move_to", bomb, DEFUSE_RADIUS, PRIORITY_DEFUSE, expiresAtTick, "never")];
      }
      // Crossfire: each attacker holds part way from the bomb towards one of
      // the ways defenders come in, rather than all on the bomb.
      const holds = this.bomb.siteId === null ? [] : holdsAt(this.lanes, this.bomb.siteId, "attack");
      if (holds.length > 0 && me !== null && this.coaches(context.teamId, "holds")) {
        const order = Math.max(0, this.livingAttackers.indexOf(me));
        if (order < holds.length) {
          const hold = holds[order];
          return [
            this.directive(
              `snd_hold_armed_${order}`,
              "hold_area",
              hold.at,
              HOLD_RADIUS,
              PRIORITY_ARM,
              expiresAtTick,
              "enemy_visible",
              undefined,
              hold.watch,
            ),
          ];
        }
      }
      const ways = this.waysIn();
      if (ways.length > 0 && me !== null && this.coaches(context.teamId, "crossfire")) {
        const order = this.livingAttackers.indexOf(me);
        const way = ways[(order < 0 ? 0 : order) % ways.length];
        const spot = {
          x: bomb.x + (way.x - bomb.x) * CROSSFIRE_SHARE,
          y: bomb.y + (way.y - bomb.y) * CROSSFIRE_SHARE,
          z: bomb.z + (way.z - bomb.z) * CROSSFIRE_SHARE,
        };
        return [
          this.directive(
            `snd_hold_armed_${order % ways.length}`,
            "hold_area",
            spot,
            200,
            PRIORITY_ARM,
            expiresAtTick,
            "enemy_visible",
          ),
        ];
      }
      // Attackers won the plant; now they are the ones holding ground. Spread
      // around the bomb rather than onto it — the bomb needs no attending.
      return [
        this.directive(
          "snd_hold_armed",
          "hold_area",
          bomb,
          SITE_ARRIVAL_RADIUS,
          PRIORITY_ARM,
          expiresAtTick,
          "enemy_visible",
        ),
      ];
    }

    // ── Defenders, pre-plant ───────────────────────────────────────
    if (!attacking) {
      const directives: AgentDirective[] = [];

      // A dropped bomb is bait: the attackers have to come for it. The two
      // defenders nearest it hold the ground round it rather than their site.
      if (me !== null && this.bombGuard.has(me)) {
        return [
          this.directive(
            "snd_guard_bomb",
            "hold_area",
            bomb,
            BOMB_GUARD_RADIUS,
            PRIORITY_HOLD + 0.05,
            expiresAtTick,
            "enemy_visible",
          ),
        ];
      }

      const siteId = me === null ? null : this.defendSiteOf(me);
      const site = this.sites.find((s) => s.id === siteId) ?? this.sites[0];
      const hold = me === null ? undefined : this.holdOf.get(me);
      if (hold) {
        return [
          this.directive(
            `snd_defend_site_${site.id}`,
            "defend",
            hold.at,
            HOLD_RADIUS,
            PRIORITY_HOLD,
            expiresAtTick,
            "enemy_visible",
            undefined,
            hold.watch,
          ),
        ];
      }
      directives.push(
        this.directive(
          // Keyed by SITE, not by player: the id must be stable for goal
          // commitment, and a player-keyed id would be unique per bot for no
          // benefit. A defender reassigned to the other site gets a new id,
          // which is exactly when re-committing is correct.
          `snd_defend_site_${site.id}`,
          "defend",
          this.standingSpot(site),
          SITE_ARRIVAL_RADIUS,
          PRIORITY_HOLD,
          expiresAtTick,
          "enemy_visible",
        ),
      );

      return directives;
    }

    // ── Attackers, pre-plant ───────────────────────────────────────
    const isWorker = me !== null && me === this.bombWorkerId;
    const phase = this.bomb.phase;

    if (phase === "planted") {
      // One arms; the rest cover. Arming needs a body within 100 units and no
      // more bodies make it faster, so a second attacker standing there is a
      // second attacker not watching an entrance.
      return isWorker
        ? [this.directive("snd_arm", "move_to", bomb, ARM_RADIUS, PRIORITY_ARM, expiresAtTick, "never")]
        : [
            this.directive(
              "snd_cover_plant",
              "hold_area",
              bomb,
              SITE_ARRIVAL_RADIUS,
              PRIORITY_HOLD,
              expiresAtTick,
              "enemy_visible",
            ),
          ];
    }

    if (phase === "dropped") {
      const target = this.sites.find((s) => s.id === this.targetSiteId) ?? this.sites[0];
      // Cover the spot while one fetches: whoever killed the carrier may be
      // waiting there for the next to come.
      if (!isWorker && me !== null && this.bombCover.has(me)) {
        return [
          this.directive(
            "snd_cover_bomb",
            "hold_area",
            bomb,
            BOMB_COVER_RADIUS,
            PRIORITY_HOLD + 0.05,
            expiresAtTick,
            "enemy_visible",
          ),
        ];
      }
      return isWorker
        ? [
            this.directive(
              "snd_fetch_bomb",
              "move_to",
              bomb,
              ARM_RADIUS,
              PRIORITY_FETCH,
              expiresAtTick,
              "enemy_visible",
            ),
          ]
        : [
            // Not "wait for the bomb" — push the site now, so it is taken by
            // the time the bomb arrives.
            this.directive(
              `snd_push_site_${target.id}`,
              "hold_area",
              this.standingSpot(target),
              SITE_ARRIVAL_RADIUS,
              PRIORITY_HOLD,
              expiresAtTick,
              "enemy_visible",
            ),
          ];
    }

    // Carried. The carrier goes to the committed site; everyone else escorts,
    // tracking them rather than a fixed point, so the screen moves with them.
    const carrier = this.bomb.carrierId;
    const isCarrier = carrier !== null && me === carrier;
    const target = this.sites.find((s) => s.id === this.targetSiteId) ?? this.sites[0];

    // The coach's plan: each group along its lane to its staging point, in
    // together once all are staged (see planAttack).
    const plan = this.attackPlan;
    const group = me === null ? undefined : plan?.groupOf.get(me);
    if (plan && group !== undefined && !plan.go) {
      const lane = this.laneFor(plan, group);
      return [
        this.directive(
          `snd_stage_${target.id}_${group % plan.lanes.length}`,
          "move_to",
          lane.staging,
          STAGING_RADIUS / 2,
          isCarrier ? PRIORITY_ARM : PRIORITY_ESCORT,
          expiresAtTick,
          "enemy_visible",
          lane.via,
        ),
      ];
    }
    if (plan && group !== undefined && group > 0 && !isCarrier) {
      return [
        this.directive(
          `snd_push_site_${target.id}`,
          "hold_area",
          this.standingSpot(target),
          SITE_ARRIVAL_RADIUS,
          PRIORITY_HOLD,
          expiresAtTick,
          "enemy_visible",
        ),
      ];
    }

    if (isCarrier) {
      return [
        this.directive(
          `snd_plant_site_${target.id}`,
          "move_to",
          this.standingSpot(target),
          PLANT_ARRIVAL_RADIUS,
          PRIORITY_ARM,
          expiresAtTick,
          "enemy_visible",
        ),
      ];
    }

    if (carrier === null) return [];
    return [
      {
        id: "snd_escort_carrier",
        kind: "escort",
        target: { type: "player", entityId: toClientKey(carrier as EntityId) },
        priority: PRIORITY_ESCORT,
        expiresAtTick,
        interrupt: "enemy_visible",
      },
    ];
  }

  /** Positional directive, which is most of them. */
  private directive(
    id: string,
    kind: AgentDirective["kind"],
    position: Vec3Like,
    radius: number,
    priority: number,
    expiresAtTick: number,
    interrupt: AgentDirective["interrupt"],
    via?: readonly Vec3Like[],
    watch?: Vec3Like,
  ): AgentDirective {
    return {
      id,
      kind,
      target: { type: "position", position: { ...position }, radius },
      priority,
      expiresAtTick,
      interrupt,
      ...(via && via.length > 0 ? { via: via.map((p) => ({ x: p.x, y: p.y, z: p.z })) } : {}),
      ...(watch ? { watch: { x: watch.x, y: watch.y, z: watch.z } } : {}),
    };
  }

  /** Recover the simulation entity id from the client key the snapshot uses. */
  private entityIdOf(entityKey: string): number | null {
    const raw = Number.parseInt(clientKeyDisplayId(entityKey), 10);
    return Number.isInteger(raw) ? raw : null;
  }

  // ========================================================================
  // Events
  // ========================================================================

  onPlayerJoin(_playerId: PlayerId, _entityId: string, _state: WorldState, _teamId?: string): void {
    // Handled by controller loadout logic.
  }

  onSpawn(_player: Entity, _state: WorldState): void {
    // Handled by controller loadout logic.
  }

  override onPlayerLeave(playerId: PlayerId): void {
    this.loadouts.forget(playerId);
  }

  onDeath(_victim: Entity, _killer: Entity | null, _state: WorldState): void {
    // Elimination is checked in onTick against live state, not counted here —
    // a death event that arrives out of order cannot desync the round result.
  }

  checkWinCondition(_state: WorldState): GameResult | null {
    return null; // MatchState decides the match; onTick decides the round.
  }

  getScore(_playerId: PlayerId): number {
    return 0; // Held by MatchState.
  }

  /**
   * Score from what a player did, not from who landed the last shot.
   *
   * A frag count misrepresents this mode. Rounds are short and there are no
   * respawns, so the player who softened three enemies before dying decided
   * that round as much as whoever finished them — Warsow Bomb scores mostly on
   * damage dealt for exactly this reason, and this keeps its shape:
   *
   *   frags at half weight, 100 damage = 1 point, team damage doubly negative
   *
   * The two additions are ours. Warsow defines POINTS_DEFUSE and then sets it
   * to zero, so arming and defusing are worth nothing there — which cannot be
   * right in a mode named after them. They are worth a good gunfight each,
   * enough to notice and not enough to make the objective the only thing.
   */
  override scoreFromStats(stats: PlayerStats): number {
    return (
      (stats.frags - stats.teamFrags) * FRAG_POINTS +
      (stats.damageGiven - 2 * stats.teamDamageGiven) * DAMAGE_POINTS +
      stats.plants * PLANT_POINTS +
      stats.defuses * DEFUSE_POINTS
    );
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private nearestSite(from: Vec3Like): BombSite | null {
    let best: BombSite | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const site of this.sites) {
      const dx = site.position.x - from.x;
      const dy = site.position.y - from.y;
      const dz = site.position.z - from.z;
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = site;
      }
    }
    return best;
  }

  private scheduleStructures(siteId: number | null): void {
    const target = this.sites.find((site) => site.id === siteId)?.target;
    if (!target) return;
    this.pendingStructures = this.brushModels.definitions
      .filter((definition) => definition.targetname === target)
      .map((definition) => ({
        modelIndex: definition.modelIndex,
        tick: this.tick + Math.round(definition.delay * TICK_RATE),
      }));
    this.updateStructures();
  }

  private updateStructures(): void {
    for (const structure of this.pendingStructures) {
      if (structure.tick > this.tick) continue;
      this.brushModels.setEnabled(structure.modelIndex, false);
      this.collision?.brushModels?.setEnabled(structure.modelIndex, false);
    }
    this.pendingStructures = this.pendingStructures.filter((structure) => structure.tick > this.tick);
  }

  /**
   * Where a player stands in a site: the site's point dropped to the floor,
   * at origin height. A site's point can float well above its floor, and a
   * bot told to go there never counted as arrived: it kept running through
   * the site, too fast to plant. The point itself when its floor is outside
   * the site.
   */
  private standingSpot(site: BombSite): Vec3Like {
    let spot = this.standingSpots.get(site.id);
    if (!spot) {
      const floor = this.dropToFloor(site.position);
      const standing = { x: floor.x, y: floor.y + PLAYER_ORIGIN_HEIGHT, z: floor.z };
      spot = isInsideBombSite(site, standing) ? standing : { ...site.position };
      this.standingSpots.set(site.id, spot);
    }
    return spot;
  }

  /** Is the surface under this point flat enough to plant on? */
  private isPlantableGround(position: Vec3Like): boolean {
    if (!this.collision) return true; // No collision loaded: do not block the mode.
    const start: Vec3 = { x: position.x, y: position.y, z: position.z };
    const end: Vec3 = { x: position.x, y: position.y - GROUND_TRACE_DISTANCE, z: position.z };
    const hit = this.collision.trace(start, end);
    if (hit.fraction >= 1) return false; // Airborne.
    return (hit.normal?.y ?? 0) >= PLANTABLE_NORMAL_Y;
  }

  /** Drop a point to the floor, so the bomb starts on the ground not in the air. */
  private dropToFloor(point: Vec3Like): Vec3Like {
    if (!this.collision) return { ...point };
    const start: Vec3 = { x: point.x, y: point.y, z: point.z };
    const end: Vec3 = { x: point.x, y: point.y - 512, z: point.z };
    const hit = this.collision.trace(start, end);
    if (hit.fraction >= 1) return { ...point };
    return { x: point.x, y: point.y - 512 * hit.fraction, z: point.z };
  }
}
