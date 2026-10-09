/**
 * Duel Gametype
 *
 * 1v1 combat (uses Team names dynamically mapped to Player names).
 * - 2 players max
 * - 10 minute time limit
 * - No score limit
 * - Shared item spawns like Deathmatch
 */

import type { WorldState } from "@engine/server/core/WorldState";
import type { Entity } from "@engine/server/ecs/Entity";
import type { PlayerId } from "@engine/server/ecs/types";
import type { ItemSpawnRules, MatchConfig, SpawnStrategyType, WeaponLoadout } from "@shared/server/gametype";
import { debugLog } from "../DebugLog";
import { BaseGametype, type GameResult } from "./BaseGametype";

export class Duel extends BaseGametype {
  readonly name = "Duel";
  readonly maxPlayers = 2;
  readonly teamBased = true; // Use team infrastructure for 1v1 UI

  // ========================================================================
  // Configuration
  // ========================================================================

  getMatchConfig(): MatchConfig {
    return {
      warmupTimeout: 120, // 2 minutes
      countdownDuration: 3, // 3-2-1
      scoreLimit: 0, // no score limit
      timeLimit: 600, // 10 minutes
      postGameDuration: 18, // post-game screen duration (duel savors the result)
      respawnDelay: 3, // seconds min before respawn input accepted
      maxRespawnDelay: 6, // seconds auto-respawn deadline
      selfDamage: 1.0, // full self-damage
      overtimeOnDraw: true, // duel never draws — tied at the limit extends the match
      overtimeDuration: 60, // +1 minute per extension
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
      weaponRespawnTime: 30, // Could tweak this differently for Duel later
      ammoRespawnTime: 15,
      armorRespawnTime: 25,
      healthRespawnTime: 20,
      megaHealthRespawnTime: 60, // e.g. 35s in some Quake rulesets
    };
  }

  getSpawnStrategy(): SpawnStrategyType {
    // Furthest is very important for duel
    return "furthest";
  }

  // ========================================================================
  // Events
  // ========================================================================

  onPlayerJoin(_playerId: PlayerId, _entityId: string, _state: WorldState, _teamId?: string): void {
    // Handled by controller loadout logic
  }

  // We don't use player/state here for now, so prefix with _ to satisfy linter
  onSpawn(_player: Entity, _state: WorldState): void {
    // Handled by controller loadout logic
  }

  onDeath(victim: Entity, killer: Entity | null, _state: WorldState): void {
    if (killer && killer.ownerId && killer.ownerId !== victim.ownerId) {
      debugLog("kills", () => `[Duel] Kill: player ${killer.ownerId} → player ${victim.ownerId}`);
    }
  }

  // ========================================================================
  // Queries
  // ========================================================================

  checkWinCondition(_state: WorldState): GameResult | null {
    // Handled by controller
    return null;
  }

  getScore(_playerId: PlayerId): number {
    return 0; // Handled by controller MatchState
  }
}
