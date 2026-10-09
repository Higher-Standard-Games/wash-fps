/**
 * Base Gametype
 * Abstract base class for game modes.
 *
 * The gametype is an event-driven orchestrator that:
 * - Defines match rules (score limit, time limit, loadouts)
 * - Reacts to lifecycle events (spawn, death, pickup)
 * - Controls item spawn behavior
 * - Runs AFTER the simulation tick, not inside it
 */

import type { WorldState } from "@engine/server/core/WorldState";
import type { Entity } from "@engine/server/ecs/Entity";
import type { EntityId, PlayerId, TickNumber } from "@engine/server/ecs/types";
import type {
  AgentDirective,
  AgentDirectiveContext,
  BombExplosionEvent,
  ItemSpawnRules,
  LoadoutChoice,
  MatchConfig,
  ObjectiveSnapshot,
  PlayerStats,
  RoundResult,
  SpawnStrategyType,
  TeamId,
  WeaponLoadout,
} from "@shared/server/gametype";
import type { Vec3 } from "@shared/server/simulation/types";
import type { BspEntity, BspModel } from "../../../../engine/loader/bsp/BspLoader";
import type { CollisionWorld } from "../../../../shared/collision/CollisionWorld";

export interface GameResult {
  winner?: PlayerId | "team1" | "team2" | "draw";
  scores: Map<PlayerId, number>;
}

/**
 * What a gametype is allowed to know about the map it is running on.
 *
 * Handed over once, after the BSP has loaded and before the first tick. Modes
 * that need map authoring (bombsites, flag stands) extract it themselves from
 * `entities` using the shared `src/shared/bsp` tables, so the controller does
 * not have to know which mode wants what.
 */
export interface GametypeMapContext {
  /** Raw BSP entity dictionaries, as parsed. */
  entities: readonly BspEntity[];
  /** BSP model records, for entities whose `model` is a `*N` brush reference. */
  models: readonly BspModel[];
  /** Team spawn points by team id, empty on maps without team spawns. */
  teamSpawnPoints: ReadonlyMap<string, Vec3[]>;
  /**
   * Trace a line through the world. Present only once collision is loaded, so
   * always null-check: headless tests and re-simulation may run without it.
   */
  collision: CollisionWorld | null;
}

/**
 * Per-tick view of the match, for modes whose rules depend on it.
 *
 * The round fields come from `MatchState`, which owns the round loop — a mode
 * asks who is attacking rather than working it out, so the half-swap and
 * overtime rules live in exactly one place.
 */
export interface GametypeTickContext {
  tick: TickNumber;
  /** Current round, 1-based. 0 outside round modes. */
  round: number;
  /** True only during a live round — not the freeze, warmup or post-game. */
  live: boolean;
  attackingTeam: TeamId;
  defendingTeam: TeamId;
  /** Team of a player, or "spectator" if unassigned. */
  teamOf(playerId: PlayerId): TeamId;
  /**
   * Credit a player with completing an objective.
   *
   * A callback rather than something the mode writes itself, so a gametype
   * still holds no reference to the match — the same reason `onTick` returns a
   * round result instead of ending the round directly.
   */
  credit(playerId: PlayerId, kind: "plant" | "defuse"): void;
  /**
   * Hurt a player with the bomb's blast, credited to no one.
   *
   * `push` is the direction the blast throws them, from the blast to the
   * player. A callback for the same reason as `credit`: the mode decides who
   * is hit, the controller owns the combat system that applies it.
   */
  blast(entityId: EntityId, damage: number, push: Vec3): void;
}

/**
 * How a round ended. `winner: null` is a draw — possible in principle, though
 * S&D has no rule that produces one.
 */
export interface RoundOutcome {
  winner: TeamId | null;
  /** For the log. The client's wording comes from `resultKey`. */
  reason: string;
  /**
   * Stable key for the round-end banner. A key rather than the prose in
   * `reason` because the client owns the wording, and a key survives rephrasing
   * where a sentence does not.
   */
  resultKey?: RoundResult["reason"];
  /** Where the camera should look during the intermission — usually the bomb. */
  focus?: { x: number; y: number; z: number };
}

export abstract class BaseGametype {
  abstract readonly name: string;
  abstract readonly maxPlayers: number;
  abstract readonly teamBased: boolean;

  // ========================================================================
  // Configuration — gametype defines these
  // ========================================================================

  /** Match configuration (warmup, countdown, time/score limits) */
  abstract getMatchConfig(): MatchConfig;

  /**
   * Weapons and ammo given to a player on spawn.
   *
   * `playerId` is present for modes where the kit is the player's own choice
   * (S&D). Modes with one kit for everyone ignore it, which is most of them.
   */
  abstract getSpawnLoadout(playerId?: PlayerId): WeaponLoadout;

  /**
   * Remember a player's chosen spawn kit. Modes without loadouts ignore it.
   *
   * Deliberately does not take effect immediately: a change made mid-round
   * applies from the NEXT round, so nobody re-kits themselves out of a fight
   * they are losing. Returns false if the mode has no loadouts to set.
   */
  setPlayerLoadout(_playerId: PlayerId, _choice: LoadoutChoice): boolean {
    return false;
  }

  /** How items spawn on the map */
  abstract getItemSpawnRules(): ItemSpawnRules;

  /** Spawn point selection algorithm */
  abstract getSpawnStrategy(): SpawnStrategyType;

  /**
   * Which team's spawn SET a player should use. Defaults to their own.
   *
   * Exists because Warsow Bomb crosses them: `GT_SelectSpawnPoint` puts the
   * attacking team on `team_CTF_betaspawn` and the defending team on
   * `team_CTF_alphaspawn`, whichever side is which. The team label and the
   * spawn area are separate facts, and reading only `INITIAL_ATTACKERS` gets
   * you the first without the second.
   */
  resolveSpawnTeam(teamId: string): string {
    return teamId;
  }

  // ========================================================================
  // Events — GametypeController calls these
  // ========================================================================

  /**
   * The map finished loading. Extract whatever authoring this mode needs.
   *
   * Called once, before the first tick, and again on a map change. Modes that
   * need nothing from the map ignore it — which is every mode but S&D today.
   */
  onMapLoad(_context: GametypeMapContext): void {
    // Default: no-op
  }

  /**
   * A new round is starting, at the top of its freeze phase.
   *
   * Runs BEFORE the world reset and the respawns, so anything a mode wants to
   * be true when players appear — which side attacks, where the bomb is, whose
   * chosen loadout is now in force — must be settled here.
   */
  onRoundStart(_state: WorldState, _context: GametypeTickContext): void {
    // Default: no-op
  }

  /**
   * Called once per tick, after the simulation and before snapshot building.
   *
   * Objective modes live here: this is where a bomb counts down, a flag is
   * captured, a round is decided. Most modes are purely event-driven and need
   * nothing, so the default costs one virtual call per tick.
   *
   * Returning a `RoundOutcome` ends the round. That is a return value rather
   * than a callback so the mode holds no reference to the controller and stays
   * testable on its own.
   */
  onTick(_state: WorldState, _context: GametypeTickContext): RoundOutcome | null {
    return null;
  }

  /** Called when a player first joins the game */
  abstract onPlayerJoin(playerId: PlayerId, entityId: string, state: WorldState, teamId?: string): void;

  /** Whether this player has completed any mode-specific join prerequisites. */
  hasChosenLoadout(_playerId: PlayerId): boolean {
    return true;
  }

  /**
   * A player left. Drop anything the mode holds for them.
   *
   * Modes that keep per-player state MUST implement this: without it a
   * long-running server leaks a row per player who ever connected, and a
   * recycled player id inherits a stranger's state.
   */
  onPlayerLeave(_playerId: PlayerId): void {
    // Default: no-op
  }

  /** Called when a player spawns (initial or respawn) */
  abstract onSpawn(player: Entity, state: WorldState): void;

  /** Called when a player dies */
  abstract onDeath(victim: Entity, killer: Entity | null, state: WorldState): void;

  /**
   * Called when a player touches an item pickup.
   * Return true to allow pickup, false to deny.
   */
  onPickup(_player: Entity, _itemClassname: string, _state: WorldState): boolean {
    return true; // Default: allow all pickups
  }

  /** Called when match phase changes */
  onMatchPhaseChange(_phase: number, _state: WorldState): void {
    // Default: no-op
  }

  /**
   * The round timer ran out. Round-based gametypes only.
   *
   * Returning null means **the round continues** — the mode has declined to end
   * it. S&D uses that for an armed bomb: once it is ticking the round clock is
   * irrelevant and the bomb's own timer takes over as the pacing device.
   *
   * MatchState owns the round LOOP but not the rules — "defenders win if
   * nothing was armed" is a Search & Destroy rule, not a property of rounds.
   */
  onRoundTimeExpired(_state: WorldState): RoundOutcome | null {
    return null;
  }

  /**
   * The mode's objective, for the client to draw. Null for modes without one.
   *
   * Called once per snapshot. Pure data: the client is told what is true, never
   * how it was decided — every rule stays here.
   */
  getObjectiveState(): ObjectiveSnapshot | null {
    return null;
  }

  /**
   * A one-shot visual the mode wants played. Null when there is nothing.
   *
   * Polled rather than pushed so it survives a dropped packet: the mode keeps
   * returning it for a moment, and a client that missed one snapshot still
   * sees the explosion.
   */
  getExplosion(): BombExplosionEvent | null {
    return null;
  }

  /**
   * Round lifecycle label for the HUD ("pre_plant" / "post_plant").
   *
   * A separate string from the objective because it is what the HUD switches
   * layout on, and because a mode with no bomb could still have round phases.
   */
  getRoundState(): string | null {
    return null;
  }

  /**
   * Orders for one agent, as serializable data.
   *
   * Called once per snapshot per living player. Bots run in a separate process
   * and cannot import gametype code, so this is how a mode steers them — see
   * shared/server/gametype/AgentDirective.ts.
   *
   * MUST be pure: read `state`, return directives, mutate nothing. It runs
   * inside snapshot building, after the tick has been simulated.
   *
   * Directives describe intent only. They cannot bypass fire safety, navigation
   * feasibility, or self-preservation — the bot weighs them like any other goal.
   */
  getAgentDirectives(_context: AgentDirectiveContext, _state: WorldState): readonly AgentDirective[] {
    return [];
  }

  // ========================================================================
  // Queries
  // ========================================================================

  /** Check if a win condition has been met */
  abstract checkWinCondition(state: WorldState): GameResult | null;

  /** Get score for a player */
  abstract getScore(playerId: PlayerId): number;

  /**
   * Derive a player's score from what they have done, instead of counting
   * frags. Return null to keep the default.
   *
   * Objective modes want this because a frag count misrepresents them: the
   * player who softened three enemies and armed the bomb contributed more than
   * whoever landed the last shots, and only a stat-derived score can say so.
   */
  scoreFromStats(_stats: PlayerStats): number | null {
    return null;
  }
}
