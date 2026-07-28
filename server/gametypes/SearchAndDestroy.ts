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
import type { PlayerId } from "@engine/server/ecs/types";
import { EntityType } from "@engine/server/ecs/types";
import type {
  AgentDirective,
  AgentDirectiveContext,
  ItemSpawnRules,
  MatchConfig,
  SpawnStrategyType,
  TeamId,
  WeaponLoadout,
} from "@shared/server/gametype";
import type { Vec3 } from "@shared/server/simulation/types";
import type { BombSite, Vec3Like } from "../../../../shared/bsp/BombSiteTable";
import { extractBombSites, isBombMap, spawnCentroid } from "../../../../shared/bsp/BombSiteTable";
import type { CollisionWorld } from "../../../../shared/collision/CollisionWorld";
import type { BombEvent, BombPlayerView } from "../../../../shared/server/gametype/BombModel";
import { BombModel } from "../../../../shared/server/gametype/BombModel";
import {
  BaseGametype,
  type GameResult,
  type GametypeMapContext,
  type GametypeTickContext,
  type RoundOutcome,
} from "./BaseGametype";

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
/** Freeze between rounds: read the map, pick a side, no buy phase to fill. */
const FREEZE_SECONDS = 5;

/** Warsow's `PLAYER_ARMOR` — every round starts as a full-strength fight. */
const SPAWN_ARMOR = 100;

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
/** Holding a site pre-plant is a default, not an order. */
const PRIORITY_HOLD = 0.5;

/**
 * A surface this flat counts as plantable ground (Warsow traces one unit down
 * and requires `normal.z >= 0.90`; our up axis is Y). Steep enough to exclude
 * ramps — deliberately, since it removes real plant spots.
 */
const PLANTABLE_NORMAL_Y = 0.9;
/** How far below the feet to look for that surface. */
const GROUND_TRACE_DISTANCE = 8;

export class SearchAndDestroy extends BaseGametype {
  readonly name = "Search & Destroy";
  readonly maxPlayers = 10;
  readonly teamBased = true;

  private readonly bomb = new BombModel();
  private sites: BombSite[] = [];
  /** Where the bomb starts each round, by attacking team. */
  private bombSpawns = new Map<TeamId, Vec3Like>();
  private collision: CollisionWorld | null = null;
  /** Round the bomb was last placed for; drives the once-per-round reset. */
  private placedForRound = -1;
  /**
   * Attacking team, cached from the tick context.
   *
   * `getAgentDirectives` needs the round role but runs from snapshot building,
   * which has no `GametypeTickContext`. Rather than grow the shared bot-facing
   * context with a field only one mode uses, the tick — which always runs
   * first — leaves it here.
   */
  private attackers: TeamId | null = null;

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
      roundBased: true,
      roundsPerHalf: ROUNDS_PER_HALF,
      leadRequired: LEAD_REQUIRED,
    };
  }

  /**
   * Spawn kit.
   *
   * Warsow Bomb is a pure loadout mode — it zeroes every item mask and lets
   * players choose two weapons at spawn. We have no loadout menu, so identical
   * kits would make every round the same fight; instead players spawn armed
   * enough to contest the first ten seconds and the map decides the rest. The
   * armor matches Warsow's, so nobody starts a round soft.
   */
  getSpawnLoadout(): WeaponLoadout {
    return {
      weapons: ["blade", "machinegun"],
      ammo: { blade: 1, machinegun: 100 },
      health: 100,
      armor: SPAWN_ARMOR,
    };
  }

  /**
   * Items respawn fast because a round is short — a 60 s armor on a 90 s round
   * is a coin flip on who spawned nearer, not a timing skill.
   */
  getItemSpawnRules(): ItemSpawnRules {
    return {
      spawnFromBsp: true,
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
  onMapLoad(context: GametypeMapContext): void {
    this.collision = context.collision;
    this.sites = [];
    this.bombSpawns.clear();
    this.placedForRound = -1;

    if (!isBombMap(context.entities)) {
      console.warn(`[S&D] Map has no bombsites — it is tagged for a mode it cannot host`);
      return;
    }

    this.sites = extractBombSites(context.entities, context.models);
    console.log(`[S&D] ${this.sites.length} bombsites: ${this.sites.map((s) => s.label).join(", ")}`);

    // The bomb starts at the attacking team's spawn centroid, dropped to the
    // floor. No entity marks it — `team_CTF_*flag` was measured and rejected as
    // inconsistently placed, and absent on wbomb6 (design doc 5.6).
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
   * Advance the bomb and report any round it decides.
   *
   * Runs in every phase: the bomb has to be placed during the freeze, before
   * the round it belongs to goes live. Only a live round can be ended, which
   * the controller enforces.
   */
  onTick(state: WorldState, context: GametypeTickContext): RoundOutcome | null {
    this.attackers = context.attackingTeam;

    // Place once per round, during the freeze. Doing it on the attacking team
    // of the round about to start is also what makes the half-swap work — the
    // bomb follows the role, not the team.
    if (!context.live) {
      if (context.round !== this.placedForRound) {
        this.placedForRound = context.round;
        this.bomb.reset(this.bombSpawns.get(context.attackingTeam) ?? { x: 0, y: 0, z: 0 });
      }
      return null;
    }

    const players = this.collectPlayers(state, context);
    const events = this.bomb.update(context.tick as number, players, this.sites, context.attackingTeam);

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
  onRoundTimeExpired(_state: WorldState): RoundOutcome | null {
    if (this.bomb.isArmed) return null;
    return { winner: this.attackers === "udon" ? "soba" : "udon", reason: "time expired, bomb not armed" };
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

  /** A round ended on the bomb: a defuse, or a detonation. */
  private outcomeFromEvents(events: readonly BombEvent[], context: GametypeTickContext): RoundOutcome | null {
    for (const event of events) {
      switch (event.kind) {
        case "detonated":
          return { winner: context.attackingTeam, reason: "bomb detonated" };
        case "defused":
          return { winner: context.defendingTeam, reason: "bomb defused" };
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
      return { winner: context.attackingTeam, reason: "defenders eliminated" };
    }
    if (attackersAlive === 0 && !this.bomb.isArmed) {
      return { winner: context.defendingTeam, reason: "attackers eliminated" };
    }
    return null;
  }

  /** The world as the bomb rules need to see it. */
  private collectPlayers(state: WorldState, context: GametypeTickContext): BombPlayerView[] {
    const views: BombPlayerView[] = [];

    for (const entity of state.entitiesByType(EntityType.Player)) {
      if (entity.ownerId === undefined) continue;
      const position = entity.transform?.position;
      if (!position) continue;

      // Full velocity, not the horizontal component: Warsow compares the whole
      // vector, so falling fast is also too fast to plant.
      const velocity = entity.physics?.velocity;
      const speed = velocity ? Math.hypot(velocity.x, velocity.y, velocity.z) : 0;

      views.push({
        entityId: entity.id as number,
        team: context.teamOf(entity.ownerId as PlayerId),
        position,
        speed,
        alive: !entity.health?.dead,
        // Only the carrier's value is ever read, and only while they are slow
        // enough to plant — so the trace is skipped for everyone else rather
        // than run once per player per tick.
        onPlantableGround:
          this.bomb.carrierId === (entity.id as number) && speed <= 400 ? this.isPlantableGround(position) : false,
      });
    }

    return views;
  }

  // ========================================================================
  // Directives — how the mode talks to bots
  // ========================================================================

  /**
   * Orders for one agent.
   *
   * The whole mode's bot intelligence is this function plus the weight profiles
   * — no S&D code runs inside the bot process. Priorities encode the mode's
   * hierarchy (defuse > arm > fetch > hold); the bot still weighs them against
   * staying alive and reaching them, which is the arbitration the goal
   * framework exists to do.
   */
  getAgentDirectives(context: AgentDirectiveContext, _state: WorldState): readonly AgentDirective[] {
    if (!context.alive || !context.teamId || context.teamId === "spectator") return [];
    if (this.sites.length === 0) return [];

    const attacking = this.attackers !== null && context.teamId === this.attackers;
    const expiresAtTick = context.tick + DIRECTIVE_TICKS;
    const bombPosition = this.bomb.position;

    // Armed: everything converges on the bomb. Attackers hold the ground around
    // it, defenders have to physically reach it.
    if (this.bomb.isArmed) {
      return [
        {
          id: attacking ? "snd_hold_armed" : "snd_defuse",
          kind: attacking ? "hold_area" : "move_to",
          target: { type: "position", position: bombPosition, radius: attacking ? SITE_ARRIVAL_RADIUS : 64 },
          priority: attacking ? PRIORITY_ARM : PRIORITY_DEFUSE,
          expiresAtTick,
          // A defuse is worth walking into fire for; holding a site is not.
          interrupt: attacking ? "enemy_visible" : "never",
        },
      ];
    }

    if (!attacking) {
      // Pre-plant defence: sit on the sites. Which site is the bot's business —
      // it picks the reachable one, which spreads the team without any
      // assignment logic here.
      return this.sites.map((site) => ({
        id: `snd_defend_site_${site.id}`,
        kind: "hold_area" as const,
        target: { type: "position" as const, position: site.position, radius: SITE_ARRIVAL_RADIUS },
        priority: PRIORITY_HOLD,
        expiresAtTick,
        interrupt: "enemy_visible" as const,
      }));
    }

    // Attackers, pre-plant. The carrier takes it to a site; everyone else
    // either fetches a loose bomb or escorts the carrier.
    const phase = this.bomb.phase;
    if (phase === "planted") {
      return [
        {
          id: "snd_arm",
          kind: "move_to",
          target: { type: "position", position: bombPosition, radius: 64 },
          priority: PRIORITY_ARM,
          expiresAtTick,
          // Arming is the win condition — do not wander off to shoot someone.
          interrupt: "never",
        },
      ];
    }

    if (phase === "dropped") {
      return [
        {
          id: "snd_fetch_bomb",
          kind: "move_to",
          target: { type: "position", position: bombPosition, radius: 64 },
          priority: PRIORITY_FETCH,
          expiresAtTick,
          // A loose bomb in a firefight is worth breaking off for.
          interrupt: "enemy_visible",
        },
      ];
    }

    // Carried. The carrier is told to go plant; the rest are told to be there.
    const carrierEntity = this.bomb.carrierId;
    const isCarrier = carrierEntity !== null && context.entityId === String(carrierEntity);
    const target = this.nearestSite(context.position) ?? this.sites[0];

    return [
      {
        id: isCarrier ? `snd_plant_site_${target.id}` : "snd_escort_carrier",
        kind: isCarrier ? "move_to" : "escort",
        target: isCarrier
          ? { type: "position", position: target.position, radius: SITE_ARRIVAL_RADIUS }
          : { type: "position", position: bombPosition, radius: SITE_ARRIVAL_RADIUS },
        priority: isCarrier ? PRIORITY_ARM : PRIORITY_HOLD,
        expiresAtTick,
        interrupt: "enemy_visible",
      },
    ];
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
