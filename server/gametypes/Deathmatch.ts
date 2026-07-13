/**
 * Deathmatch Gametype
 * Free-for-all deathmatch with Warsow-style rules:
 * - Furthest spawn selection
 * - Gunblade on spawn
 * - All items from BSP spawn on map
 * - 30s weapon respawn
 */

import type { WorldState } from "@engine/server/core/WorldState";
import type { Entity } from "@engine/server/ecs/Entity";
import type { PlayerId } from "@engine/server/ecs/types";
import type { ItemSpawnRules, MatchConfig, SpawnStrategyType, WeaponLoadout } from "@shared/server/gametype";
import { BaseGametype, type GameResult } from "./BaseGametype";

export class Deathmatch extends BaseGametype {
  readonly name = "Deathmatch";
  readonly maxPlayers = 16;
  readonly teamBased = false;

  private scores: Map<PlayerId, number> = new Map();

  // ========================================================================
  // Configuration
  // ========================================================================

  getMatchConfig(): MatchConfig {
    return {
      warmupTimeout: 120, // 2 minutes
      countdownDuration: 3, // 3-2-1
      scoreLimit: 20, // frags to win
      timeLimit: 600, // 10 minutes
      postGameDuration: 15, // post-game screen duration
      respawnDelay: 3, // seconds min before respawn input accepted
      maxRespawnDelay: 6, // seconds auto-respawn deadline
      selfDamage: 1.0, // full self-damage (standard DM)
    };
  }

  getSpawnLoadout(): WeaponLoadout {
    return {
      weapons: ["blade"],
      ammo: { blade: 1 },
      health: 100,
      armor: 0,
    };
  }

  getItemSpawnRules(): ItemSpawnRules {
    return {
      spawnFromBsp: true,
      weaponRespawnTime: 30,
      ammoRespawnTime: 15,
      armorRespawnTime: 25,
      healthRespawnTime: 20,
      megaHealthRespawnTime: 60,
    };
  }

  getSpawnStrategy(): SpawnStrategyType {
    return "furthest";
  }

  // ========================================================================
  // Events
  // ========================================================================

  onPlayerJoin(_playerId: PlayerId, _entityId: string, _state: WorldState, _teamId?: string): void {
    // No special action required
  }

  onSpawn(_player: Entity, _state: WorldState): void {
    // Loadout is handled by GametypeController using getSpawnLoadout()
  }

  onDeath(victim: Entity, killer: Entity | null, _state: WorldState): void {
    // Score is tracked by MatchState.addScore() called from GametypeController
    // We just log here for debugging
    if (killer && killer.ownerId && killer.ownerId !== victim.ownerId) {
      console.log(`[Deathmatch] Kill: player ${killer.ownerId} → player ${victim.ownerId}`);
    }
  }

  // ========================================================================
  // Queries
  // ========================================================================

  checkWinCondition(_state: WorldState): GameResult | null {
    // Win condition is checked by GametypeController using MatchState scores
    // This is called by the controller which passes in its own scores
    return null;
  }

  getScore(playerId: PlayerId): number {
    return this.scores.get(playerId) || 0;
  }
}
