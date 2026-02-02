/**
 * Base Gametype
 * Abstract base class for game modes
 */

import type { WorldState } from '@engine/server/core/WorldState';
import type { Entity } from '@engine/server/ecs/Entity';
import type { PlayerId } from '@engine/server/ecs/types';
import type { Vec3 } from '@shared/server/simulation/types';

export interface GameResult {
    winner?: PlayerId | 'team1' | 'team2' | 'draw';
    scores: Map<PlayerId, number>;
}

export abstract class BaseGametype {
    abstract readonly name: string;
    abstract readonly maxPlayers: number;
    abstract readonly teamBased: boolean;

    /**
     * Check win conditions
     */
    abstract checkWinCondition(state: WorldState): GameResult | null;

    /**
     * Handle player spawn
     */
    abstract onSpawn(player: Entity, state: WorldState): void;

    /**
     * Handle player death
     */
    abstract onDeath(
        victim: Entity,
        killer: Entity | null,
        state: WorldState
    ): void;

    /**
     * Get score for player
     */
    abstract getScore(playerId: PlayerId): number;

    /**
     * Choose spawn point for player
     */
    abstract chooseSpawnPoint(player: Entity, state: WorldState): Vec3;
}
