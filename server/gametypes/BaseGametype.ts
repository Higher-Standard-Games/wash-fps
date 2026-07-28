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
import type { PlayerId } from "@engine/server/ecs/types";
import type {
  AgentDirective,
  AgentDirectiveContext,
  ItemSpawnRules,
  MatchConfig,
  SpawnStrategyType,
  WeaponLoadout,
} from "@shared/server/gametype";

export interface GameResult {
  winner?: PlayerId | "team1" | "team2" | "draw";
  scores: Map<PlayerId, number>;
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

  /** Weapons and ammo given to players on spawn */
  abstract getSpawnLoadout(): WeaponLoadout;

  /** How items spawn on the map */
  abstract getItemSpawnRules(): ItemSpawnRules;

  /** Spawn point selection algorithm */
  abstract getSpawnStrategy(): SpawnStrategyType;

  // ========================================================================
  // Events — GametypeController calls these
  // ========================================================================

  /** Called when a player first joins the game */
  abstract onPlayerJoin(playerId: PlayerId, entityId: string, state: WorldState, teamId?: string): void;

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
}
