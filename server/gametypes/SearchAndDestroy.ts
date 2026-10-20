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
 *   Search & Destroy ever needs code in `src/bot`, the design has failed.
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
import { extractBombSites, isBombMap, spawnCentroid } from "../../../../shared/bsp/BombSiteTable";
import { BrushModelState, extractBrushModels } from "../../../../shared/bsp/BrushModelState";
import { WEAPON_PICKUP_CLASSNAMES } from "../../../../shared/bsp/PickupTable";
import type { CollisionWorld } from "../../../../shared/collision/CollisionWorld";
import { rngFrom } from "../../../../shared/DeterministicRng";
import type { BombEvent, BombPlayerView } from "../../../../shared/server/gametype/BombModel";
import { BombModel } from "../../../../shared/server/gametype/BombModel";
import { clientKeyDisplayId, toClientKey } from "../../ClientEntityKey";
import {
  BaseGametype,
  type GameResult,
  type GametypeMapContext,
  type GametypeTickContext,
  type RoundOutcome,
} from "./BaseGametype";
import { PlayerLoadouts } from "./PlayerLoadouts";

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
/** Holding a site pre-plant is a default, not an order. */
const PRIORITY_HOLD = 0.5;

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
  /** The one attacker doing the job that needs exactly one person. */
  private bombWorkerId: number | null = null;
  /** Site the attack is committed to. */
  private targetSiteId: number | null = null;
  /** Kits: a change waits for the next round's rollover. */
  private loadouts = new PlayerLoadouts("round");

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
      loadouts: "round",
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
   * Remember a kit for the next round.
   *
   * Never for the current one, even if the player is dead: re-kitting mid-round
   * turns a lost gunfight into a free retry, and a spectating teammate would be
   * able to feed a live one a better weapon. Dead players changing loadout is
   * exactly the intended use — they just wait for the round to turn over.
   *
   * The exception is a player's FIRST choice, which applies at once. They have
   * no kit to re-kit and are not in the round yet, so "never mid-round" would
   * only mean handing a joining player a default nobody asked for and making
   * them sit out a round to correct it.
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
    this.brushModels = new BrushModelState(extractBrushModels(context.entities, context.models));
    this.pendingStructures = [];
    this.sites = [];
    this.bombSpawns.clear();

    if (!isBombMap(context.entities)) {
      console.warn(`[S&D] Map has no bombsites — it is tagged for a mode it cannot host`);
      return;
    }

    this.sites = extractBombSites(context.entities, context.models);
    console.log(`[S&D] ${this.sites.length} bombsites: ${this.sites.map((s) => s.label).join(", ")}`);

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
    this.bomb.reset(this.bombSpawns.get(BETA_TEAM) ?? { x: 0, y: 0, z: 0 });

    // A chosen kit takes effect here and nowhere else. Players respawn moments
    // later in this same freeze, so promoting any later would arm them a round
    // behind what they picked.
    this.loadouts.startRound();
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
        const site = this.sites.reduce((best, candidate) =>
          (counts.get(candidate.id) ?? 0) < (counts.get(best.id) ?? 0) ? candidate : best,
        );
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

    // Which site the attack commits to. Nearest to the bomb, so the team pushes
    // together and the choice does not flip as individuals move around.
    this.targetSiteId = this.nearestSite(this.bomb.position)?.id ?? null;
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
        // The retake. The only order in the mode a bot should die for: with the
        // bomb ticking there is nothing left to preserve itself for.
        return [this.directive("snd_defuse", "move_to", bomb, DEFUSE_RADIUS, PRIORITY_DEFUSE, expiresAtTick, "never")];
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

      const siteId = me === null ? null : (this.siteByDefender.get(me) ?? null);
      const site = this.sites.find((s) => s.id === siteId) ?? this.sites[0];
      directives.push(
        this.directive(
          // Keyed by SITE, not by player: the id must be stable for goal
          // commitment, and a player-keyed id would be unique per bot for no
          // benefit. A defender reassigned to the other site gets a new id,
          // which is exactly when re-committing is correct.
          `snd_defend_site_${site.id}`,
          "defend",
          site.position,
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
              target.position,
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

    if (isCarrier) {
      return [
        this.directive(
          `snd_plant_site_${target.id}`,
          "move_to",
          target.position,
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
  ): AgentDirective {
    return {
      id,
      kind,
      target: { type: "position", position: { ...position }, radius },
      priority,
      expiresAtTick,
      interrupt,
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
