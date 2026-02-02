/**
 * Deathmatch Gametype
 * Free-for-all deathmatch
 */

import { BaseGametype, type GameResult } from './BaseGametype';
import type { WorldState } from '@engine/server/core/WorldState';
import type { Entity } from '@engine/server/ecs/Entity';
import type { PlayerId } from '@engine/server/ecs/types';
import type { Vec3 } from '@shared/server/simulation/types';

export interface DeathmatchConfig {
    /** Score limit for win */
    scoreLimit: number;
    /** Time limit in seconds (0 = no limit) */
    timeLimit: number;
}

const DEFAULT_CONFIG: DeathmatchConfig = {
    scoreLimit: 25,
    timeLimit: 600, // 10 minutes
};

export class Deathmatch extends BaseGametype {
    readonly name = 'Deathmatch';
    readonly maxPlayers = 16;
    readonly teamBased = false;

    private config: DeathmatchConfig;
    private scores: Map<PlayerId, number> = new Map();

    constructor(config: Partial<DeathmatchConfig> = {}) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    checkWinCondition(_state: WorldState): GameResult | null {
        // Check if anyone reached score limit
        for (const [playerId, score] of this.scores) {
            if (score >= this.config.scoreLimit) {
                return { winner: playerId, scores: new Map(this.scores) };
            }
        }
        return null;
    }

    onSpawn(_player: Entity, _state: WorldState): void {
        // TODO: Reset player loadout
    }

    onDeath(
        victim: Entity,
        killer: Entity | null,
        _state: WorldState
    ): void {
        if (killer && killer.ownerId && killer.ownerId !== victim.ownerId) {
            // Killer gets a point
            const current = this.scores.get(killer.ownerId) || 0;
            this.scores.set(killer.ownerId, current + 1);
        }
    }

    getScore(playerId: PlayerId): number {
        return this.scores.get(playerId) || 0;
    }

    chooseSpawnPoint(_player: Entity, _state: WorldState): Vec3 {
        // TODO: Implement spawn point selection
        return { x: 0, y: 100, z: 0 };
    }
}
