/**
 * Spawn Point Strategies
 * 
 * Different gametypes need different spawn selection algorithms.
 * - Random: any valid spawn point
 * - Furthest: Warsow-style, pick 2 furthest from enemies, randomize
 * - Team: team-specific spawn points
 */

import type { Vec3 } from '@shared/server/simulation/types';
import type { WorldState } from '@engine/server/core/WorldState';
import type { EntityId } from '@engine/server/ecs/types';

// ============================================================================
// Interface
// ============================================================================

export interface SpawnPointStrategy {
    /**
     * Choose a spawn point for a player.
     * @param points Available spawn points from BSP
     * @param state Current world state (for checking enemy positions)
     * @param excludeEntityId Entity ID of the spawning player (to exclude self)
     */
    choose(points: Vec3[], state: WorldState, excludeEntityId?: EntityId): Vec3;
}

// ============================================================================
// Random Strategy
// ============================================================================

/**
 * Random spawn selection — pick any valid spawn point.
 * Suitable for casual modes or as fallback.
 */
export class RandomSpawnStrategy implements SpawnPointStrategy {
    choose(points: Vec3[], _state: WorldState): Vec3 {
        if (points.length === 0) {
            return { x: 0, y: 100, z: 0 };
        }
        const index = Math.floor(Math.random() * points.length);
        return { ...points[index] };
    }
}

// ============================================================================
// Furthest Strategy (Warsow DM/Duel)
// ============================================================================

/**
 * Warsow-style "furthest" spawn selection:
 * 1. Score each spawn by its minimum distance to the nearest enemy
 * 2. Sort by distance (furthest first)
 * 3. Pick randomly from the top N candidates (default 2)
 * 
 * This prevents spawning right next to an enemy while still
 * being somewhat unpredictable.
 */
export class FurthestSpawnStrategy implements SpawnPointStrategy {
    /** Number of top candidates to pick from */
    private readonly candidateCount: number;

    constructor(candidateCount: number = 2) {
        this.candidateCount = candidateCount;
    }

    choose(points: Vec3[], state: WorldState, excludeEntityId?: EntityId): Vec3 {
        if (points.length === 0) {
            return { x: 0, y: 100, z: 0 };
        }

        // Get all enemy positions (all players except the one spawning)
        const enemyPositions = this.getEnemyPositions(state, excludeEntityId);

        // If no enemies, just pick random
        if (enemyPositions.length === 0) {
            const index = Math.floor(Math.random() * points.length);
            return { ...points[index] };
        }

        // Score each spawn point by minimum distance to nearest enemy
        const scored = points.map((point, index) => {
            const minDist = Math.min(
                ...enemyPositions.map(enemy => this.distanceXZ(point, enemy))
            );
            return { index, minDist };
        });

        // Sort by distance descending (furthest first)
        scored.sort((a, b) => b.minDist - a.minDist);

        // Pick randomly from top candidates
        const count = Math.min(this.candidateCount, scored.length);
        const chosen = scored[Math.floor(Math.random() * count)];
        return { ...points[chosen.index] };
    }

    /**
     * Get positions of all alive players (enemies)
     */
    private getEnemyPositions(state: WorldState, excludeEntityId?: EntityId): Vec3[] {
        const positions: Vec3[] = [];
        for (const entity of state.allEntities()) {
            // Skip the player being spawned
            if (excludeEntityId && entity.id === excludeEntityId) continue;
            // Only include alive players
            if (entity.transform && entity.health && !entity.health.dead) {
                positions.push(entity.transform.position);
            }
        }
        return positions;
    }

    /**
     * Distance in XZ plane (horizontal distance matters more for spawn selection)
     */
    private distanceXZ(a: Vec3, b: Vec3): number {
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        return Math.sqrt(dx * dx + dz * dz);
    }
}

// ============================================================================
// Team Strategy
// ============================================================================

/**
 * Team-based spawn selection.
 * Uses team-tagged spawn points (from BSP entity classnames
 * like info_player_team1, info_player_team2).
 */
export interface TeamSpawnPoint extends Vec3 {
    team?: string;
}

export class TeamSpawnStrategy implements SpawnPointStrategy {
    private teamPoints: Map<string, Vec3[]> = new Map();

    /**
     * Set team-specific spawn points (called during BSP loading)
     */
    setTeamPoints(team: string, points: Vec3[]): void {
        this.teamPoints.set(team, points);
    }

    choose(points: Vec3[], _state: WorldState): Vec3 {
        // For now, use all points as fallback
        // TODO: Use player's team to select from team-specific points
        if (points.length === 0) {
            return { x: 0, y: 100, z: 0 };
        }
        const index = Math.floor(Math.random() * points.length);
        return { ...points[index] };
    }
}

// ============================================================================
// Factory
// ============================================================================

import type { SpawnStrategyType } from '@shared/server/gametype';

export function createSpawnStrategy(type: SpawnStrategyType): SpawnPointStrategy {
    switch (type) {
        case 'random': return new RandomSpawnStrategy();
        case 'furthest': return new FurthestSpawnStrategy();
        case 'team': return new TeamSpawnStrategy();
        default: return new RandomSpawnStrategy();
    }
}
