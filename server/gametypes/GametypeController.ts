/**
 * Gametype Controller
 * 
 * Orchestrates the gametype within the server tick loop.
 * Sits between the simulation (125Hz subsystems) and the gametype script.
 * 
 * Flow per tick:
 * 1. simulation.tick()          ← physics, combat, weapons
 * 2. gametypeController.postTick()  ← process kills, check win, respawn, match state
 * 3. broadcastSnapshot()        ← send state + events to clients
 */

import type { WorldState } from '@engine/server/core/WorldState';
import type { Entity } from '@engine/server/ecs/Entity';
import type { EntityId, PlayerId } from '@engine/server/ecs/types';
import type { TickNumber } from '@engine/server/ecs/types';
import type { Vec3 } from '@shared/server/simulation/types';
import { MatchPhase } from '@shared/server/gametype';
import type { MatchStateSnapshot } from '@shared/server/gametype';

import type { BaseGametype } from './BaseGametype';
import { MatchState } from './MatchState';
import { createSpawnStrategy, type SpawnPointStrategy } from './SpawnPointStrategy';
import type { CombatSystem } from '../systems/CombatSystem';
import type { WeaponSystem } from '../systems/WeaponSystem';

// ============================================================================
// Respawn Queue Entry
// ============================================================================

interface RespawnEntry {
    entityId: EntityId;
    respawnTick: number;
}

// ============================================================================
// Controller
// ============================================================================

export class GametypeController {
    private gametype: BaseGametype;
    private matchState: MatchState;
    private spawnStrategy: SpawnPointStrategy;
    private spawnPoints: Vec3[] = [];
    private respawnQueue: RespawnEntry[] = [];

    // Subsystem references (set after construction)
    private combatSystem: CombatSystem | null = null;
    private weaponSystem: WeaponSystem | null = null;

    constructor(gametype: BaseGametype) {
        this.gametype = gametype;
        const config = gametype.getMatchConfig();
        this.matchState = new MatchState(gametype.name, config);
        this.spawnStrategy = createSpawnStrategy(gametype.getSpawnStrategy());

        console.log(`[GametypeController] Initialized: ${gametype.name}`);
        console.log(`[GametypeController] Spawn strategy: ${gametype.getSpawnStrategy()}`);
        console.log(`[GametypeController] Score limit: ${config.scoreLimit}, Time limit: ${config.timeLimit}s`);
    }

    // ========================================================================
    // Setup
    // ========================================================================

    /**
     * Set subsystem references for interaction.
     * Called after all subsystems are created.
     */
    setSubsystems(combat: CombatSystem, weapon: WeaponSystem): void {
        this.combatSystem = combat;
        this.weaponSystem = weapon;
    }

    /**
     * Set available spawn points (from BSP parsing).
     */
    setSpawnPoints(points: Vec3[]): void {
        this.spawnPoints = points;
        console.log(`[GametypeController] ${points.length} spawn points loaded`);
    }

    // ========================================================================
    // Player Lifecycle
    // ========================================================================

    /**
     * Handle a new player joining.
     * Returns a spawn position for the player entity.
     */
    onPlayerJoin(playerId: PlayerId, entityId: EntityId, state: WorldState): Vec3 {
        // Track in match state
        this.matchState.addPlayer(playerId);

        // Choose spawn point
        const spawn = this.spawnStrategy.choose(this.spawnPoints, state, entityId);

        // Apply weapon loadout
        if (this.weaponSystem) {
            const loadout = this.gametype.getSpawnLoadout();
            this.weaponSystem.initializeWeaponFromLoadout(entityId, loadout);
        }

        console.log(`[GametypeController] Player ${playerId} joined (${this.matchState.totalPlayers} total)`);
        return spawn;
    }

    /**
     * Handle player disconnect.
     */
    onPlayerDisconnect(playerId: PlayerId): void {
        this.matchState.removePlayer(playerId);
        console.log(`[GametypeController] Player ${playerId} disconnected (${this.matchState.totalPlayers} total)`);
    }

    /**
     * Handle player ready (F4 press).
     */
    onPlayerReady(playerId: PlayerId): void {
        this.matchState.playerReady(playerId);
    }

    // ========================================================================
    // Post-Tick Processing
    // ========================================================================

    /**
     * Called after simulation.tick() each frame.
     * Processes events, updates match state, handles respawns.
     */
    postTick(state: WorldState, dt: number, tick: TickNumber): void {
        const tickNum = tick as number;

        // 1. Process kills from CombatSystem
        if (this.combatSystem) {
            const kills = this.combatSystem.getRecentKills();
            for (const kill of kills) {
                // Get entities for gametype event
                const victim = state.getEntity(kill.victimId);
                const killer = kill.killerId ? state.getEntity(kill.killerId) : null;

                if (victim) {
                    // Tell gametype about the kill
                    this.gametype.onDeath(
                        victim as Entity,
                        killer as Entity | null,
                        state
                    );

                    // Update score (only during Active phase)
                    if (this.matchState.phase === MatchPhase.Active) {
                        if (killer?.ownerId && killer.ownerId !== victim.ownerId) {
                            this.matchState.addScore(killer.ownerId, 1);
                        }
                        // Track deaths
                        if (victim.ownerId) {
                            this.matchState.addDeath(victim.ownerId);
                        }
                    }

                    // Queue respawn (instant during warmup, normal delay otherwise)
                    const config = this.gametype.getMatchConfig();
                    const isWarmup = this.matchState.phase === MatchPhase.Warmup;
                    const respawnTicks = isWarmup ? 0 : Math.floor(config.respawnDelay * 125);
                    this.respawnQueue.push({
                        entityId: kill.victimId,
                        respawnTick: tickNum + respawnTicks,
                    });
                }
            }
            this.combatSystem.clearKills();
        }

        // 2. Process respawn queue
        this.processRespawns(state, tickNum);

        // 3. Update match state
        const phaseChanged = this.matchState.update(dt);
        if (phaseChanged) {
            this.gametype.onMatchPhaseChange(this.matchState.phase, state);

            // On match start (countdown → active), respawn all players
            if (this.matchState.phase === MatchPhase.Active) {
                this.respawnAllPlayers(state);
            }
        }

        // 4. Check win condition during active phase
        if (this.matchState.phase === MatchPhase.Active) {
            const config = this.gametype.getMatchConfig();
            if (config.scoreLimit > 0) {
                // Check if any player reached score limit
                for (const [_playerId, score] of this.matchState.scores) {
                    if (score >= config.scoreLimit) {
                        console.log(`[GametypeController] Score limit reached!`);
                        this.matchState.endMatch();
                        break;
                    }
                }
            }
        }
    }

    // ========================================================================
    // Respawn Logic
    // ========================================================================

    private processRespawns(state: WorldState, tickNum: number): void {
        const remaining: RespawnEntry[] = [];

        for (const entry of this.respawnQueue) {
            if (tickNum >= entry.respawnTick) {
                this.respawnPlayer(state, entry.entityId);
            } else {
                remaining.push(entry);
            }
        }

        this.respawnQueue = remaining;
    }

    private respawnPlayer(state: WorldState, entityId: EntityId): void {
        const entity = state.getEntityMut(entityId);
        if (!entity) return;

        // Choose spawn point using strategy
        const spawn = this.spawnStrategy.choose(this.spawnPoints, state, entityId);

        // Get loadout from gametype
        const loadout = this.gametype.getSpawnLoadout();

        // Reset health/armor
        if (entity.health) {
            entity.health.health = loadout.health;
            entity.health.armor = loadout.armor;
            entity.health.dead = false;
        }

        // Set position
        if (entity.transform) {
            entity.transform.position = { ...spawn };
        }

        // Reset velocity
        if (entity.physics) {
            entity.physics.velocity = { x: 0, y: 0, z: 0 };
            entity.physics.grounded = false;
            entity.physics.jumping = false;
        }

        // Reset weapon loadout
        if (this.weaponSystem) {
            this.weaponSystem.initializeWeaponFromLoadout(entityId, loadout);
        }

        // Tell gametype
        this.gametype.onSpawn(entity, state);

        console.log(`[GametypeController] Respawned entity ${entityId} at (${spawn.x.toFixed(0)}, ${spawn.y.toFixed(0)}, ${spawn.z.toFixed(0)})`);
    }

    private respawnAllPlayers(state: WorldState): void {
        console.log(`[GametypeController] Match start — respawning all players`);
        for (const entity of state.allEntities()) {
            if (entity.ownerId !== undefined) {
                this.respawnPlayer(state, entity.id);
            }
        }
        // Clear any pending respawns
        this.respawnQueue = [];
    }

    // ========================================================================
    // Queries
    // ========================================================================

    getMatchState(): MatchState {
        return this.matchState;
    }

    getMatchSnapshot(): MatchStateSnapshot {
        return this.matchState.toSnapshot();
    }

    getGametype(): BaseGametype {
        return this.gametype;
    }

    getPhase(): MatchPhase {
        return this.matchState.phase;
    }

    getSpawnPoint(state: WorldState, entityId?: EntityId): Vec3 {
        return this.spawnStrategy.choose(this.spawnPoints, state, entityId);
    }
}
