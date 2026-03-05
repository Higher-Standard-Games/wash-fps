/**
 * Team Deathmatch Gametype
 * 
 * Team-based combat (Udon vs Soba).
 * - Auto-balancing on join
 * - 15 minute time limit
 * - 50 frag limit
 * - Shared item spawns like Deathmatch
 */

import { BaseGametype, type GameResult } from './BaseGametype';
import type { WorldState } from '@engine/server/core/WorldState';
import type { Entity } from '@engine/server/ecs/Entity';
import type { PlayerId } from '@engine/server/ecs/types';
import type {
    MatchConfig,
    WeaponLoadout,
    ItemSpawnRules,
    SpawnStrategyType,
} from '@shared/server/gametype';

export class TeamDeathmatch extends BaseGametype {
    readonly name = 'Team Deathmatch';
    readonly maxPlayers = 16;
    readonly teamBased = true;

    // GametypeController passes its own MatchState around where needed,
    // but we can query it via controller if we needed to. 
    // For now we rely on controller handling the state for us.

    // ========================================================================
    // Configuration
    // ========================================================================

    getMatchConfig(): MatchConfig {
        return {
            warmupTimeout: 120,     // 2 minutes
            countdownDuration: 3,   // 3-2-1
            scoreLimit: 50,         // frags to win
            timeLimit: 900,         // 15 minutes
            postGameDuration: 10,   // scoreboard duration
            respawnDelay: 3,        // seconds min before respawn input accepted
            maxRespawnDelay: 6,     // seconds auto-respawn deadline
            selfDamage: 1.0,        // full self-damage
        };
    }

    getSpawnLoadout(): WeaponLoadout {
        return {
            weapons: ['blade'],
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
        // 'team' strategy could be used here if implemented in SpawnPointStrategy.ts
        // For now fallback to farthest or random if team isn't supported yet
        return 'furthest';
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

    onDeath(
        victim: Entity,
        killer: Entity | null,
        _state: WorldState
    ): void {
        if (killer && killer.ownerId && killer.ownerId !== victim.ownerId) {
            console.log(`[TDM] Kill: player ${killer.ownerId} → player ${victim.ownerId}`);
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
