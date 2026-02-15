/**
 * GameServer — Core FPS game server
 * 
 * Extracted from headless-netserver-v2.ts to separate game logic
 * from CLI/transport concerns. Owns:
 * - Simulation + subsystems (physics, weapons, combat, projectiles)
 * - GametypeController (match lifecycle, spawn strategy, scoring)
 * - Client management (player join/disconnect/input)
 * - State conversion (WorldState → GameState for network)
 */

import { Simulation } from '@engine/server/core/Simulation';
import { createPlayerEntity } from '@engine/server/ecs/Entity';
import { playerId as createPlayerId } from '@engine/server/ecs/types';
import type { PlayerId, EntityId } from '@engine/server/ecs/types';
import type { CollisionWorld } from '../../../engine/network/systems/collision/CollisionWorld';
import type { Vec3 } from '@shared/server/simulation/types';

// Protocol (client-compatible)
import { MessageCodec, MessageType } from '../../../engine/network/protocol/MessageCodec';
import { GameState, type PlayerState } from '../../../engine/network/core/GameState';
import { Entity } from '../../../engine/network/core/Entity';

// Subsystems
import { FPSMovementSubsystem } from './systems/FPSMovementSubsystem';
import { ProjectileSystem } from './systems/ProjectileSystem';
import { WeaponSystem } from './systems/WeaponSystem';
import { CombatSystem } from './systems/CombatSystem';

// Gametype
import { GametypeController } from './gametypes/GametypeController';
import { Deathmatch } from './gametypes/Deathmatch';
import type { BaseGametype } from './gametypes/BaseGametype';

// Transport
import type { Transport, TransportConfig, ClientConnection } from '@engine/server/network/transport/WebSocketTransport';
import { WebSocketServerTransport } from '@engine/server/network/transport/WebSocketTransport';

// ============================================================================
// Configuration
// ============================================================================

export interface GameServerConfig {
    port: number;
    serverName: string;
    mapName: string;
    maxClients: number;
    tickRate: number;
    certPath: string;
    keyPath: string;
}

// ============================================================================
// Client State
// ============================================================================

export interface ClientInfo {
    id: string;
    connection: ClientConnection;
    playerId: PlayerId;
    entityId: EntityId;
    /** Last processed input sequence (for reconciliation) */
    lastInputSeq: number;
}

// ============================================================================
// Game Server
// ============================================================================

export class GameServer {
    private config: GameServerConfig;
    private simulation: Simulation;
    private transport: Transport;
    private clients: Map<string, ClientInfo> = new Map();
    private nextPlayerId: number = 1;
    private running: boolean = false;
    private tickTimer: ReturnType<typeof setTimeout> | null = null;

    // Subsystems
    private physicsSystem: FPSMovementSubsystem;
    private projectileSystem: ProjectileSystem;
    private weaponSystem: WeaponSystem;
    private combatSystem: CombatSystem;

    // Gametype
    private gametypeController: GametypeController;

    constructor(config: GameServerConfig, gametype?: BaseGametype) {
        this.config = config;

        // Create simulation
        this.simulation = new Simulation({
            tickMs: 1000 / config.tickRate,
        });

        // Create subsystems
        this.physicsSystem = new FPSMovementSubsystem();
        this.projectileSystem = new ProjectileSystem();
        this.weaponSystem = new WeaponSystem();
        this.combatSystem = new CombatSystem();

        // Add subsystems to simulation
        this.simulation.addSubsystem(this.physicsSystem);
        this.simulation.addSubsystem(this.projectileSystem);
        this.simulation.addSubsystem(this.weaponSystem);
        this.simulation.addSubsystem(this.combatSystem);

        // Create gametype controller
        const gt = gametype || new Deathmatch();
        this.gametypeController = new GametypeController(gt);
        this.gametypeController.setSubsystems(this.combatSystem, this.weaponSystem);

        // Create transport
        const transportConfig: TransportConfig = {
            port: config.port,
            maxClients: config.maxClients,
            certPath: config.certPath,
            keyPath: config.keyPath,
        };

        this.transport = new WebSocketServerTransport(transportConfig, {
            onConnect: (conn) => this.handleConnect(conn),
            onDisconnect: (conn, reason) => this.handleDisconnect(conn, reason),
            onDatagram: (conn, data) => this.handleDatagram(conn, data),
            onReliable: (conn, data) => this.handleReliable(conn, data),
            onError: (conn, error) => this.handleError(conn, error),
        });

        console.log(`[GameServer] Created with ${this.simulation.getSubsystems().length} subsystems`);
        console.log(`[GameServer] Gametype: ${gt.name}`);
    }

    // ========================================================================
    // Setup
    // ========================================================================

    setCollisionWorld(collision: CollisionWorld): void {
        this.physicsSystem.setCollisionWorld(collision);
        this.projectileSystem.setCollisionWorld(collision);
        console.log(`[GameServer] Collision world configured`);
    }

    setSpawnPoints(points: Vec3[]): void {
        this.gametypeController.setSpawnPoints(points);
    }

    getGametypeController(): GametypeController {
        return this.gametypeController;
    }

    getPhysicsSystem(): FPSMovementSubsystem {
        return this.physicsSystem;
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    async start(): Promise<void> {
        if (this.running) return;

        this.simulation.initialize();
        await this.transport.start();

        this.running = true;
        this.scheduleNextTick(performance.now());

        console.log(`[GameServer] Tick loop started at ${this.config.tickRate}Hz`);
    }

    async stop(): Promise<void> {
        if (!this.running) return;

        if (this.tickTimer) {
            clearTimeout(this.tickTimer);
            this.tickTimer = null;
        }

        await this.transport.stop();
        this.running = false;
        this.simulation.cleanup();

        console.log(`[GameServer] Stopped`);
    }

    // ========================================================================
    // Tick Loop
    // ========================================================================

    private scheduleNextTick(lastTickTime: number): void {
        if (!this.running) return;

        const tickMs = 1000 / this.config.tickRate;
        const now = performance.now();
        const elapsed = now - lastTickTime;
        const drift = elapsed - tickMs;
        const nextDelay = Math.max(1, Math.min(tickMs * 2, tickMs - drift));

        this.tickTimer = setTimeout(() => {
            const tickStart = performance.now();
            this.tick();
            this.scheduleNextTick(tickStart);
        }, nextDelay);
    }

    private tick(): void {
        const dt = 1 / this.config.tickRate;

        // 1. Run simulation (physics, weapons, combat)
        this.simulation.tick();

        // 2. Run gametype controller post-tick (kills, respawns, match state)
        const state = this.simulation.getStateMut();
        this.gametypeController.postTick(state, dt, this.simulation.currentTick);

        // 3. Broadcast snapshot to clients
        this.broadcastSnapshot();
    }

    // ========================================================================
    // Client Handlers
    // ========================================================================

    private handleConnect(conn: ClientConnection): void {
        console.log(`[GameServer] WebSocket connected: ${conn.id}`);
    }

    private handleDisconnect(conn: ClientConnection, reason: string): void {
        const client = this.clients.get(conn.id);
        if (!client) return;

        // Remove player entity
        const state = this.simulation.getStateMut();
        state.removeEntity(client.entityId);

        // Notify gametype
        this.gametypeController.onPlayerDisconnect(client.playerId);

        this.clients.delete(conn.id);
        console.log(`[GameServer] Player ${client.playerId} disconnected: ${reason} (${this.clients.size}/${this.config.maxClients})`);
    }

    private handleDatagram(conn: ClientConnection, data: Uint8Array): void {
        if (data.length === 0) return;

        try {
            const msgType = MessageCodec.peekMessageType(data);

            // Handle Join message
            if (msgType === MessageType.Join) {
                this.handleJoin(conn, data);
                return;
            }

            // Handle Ready message
            if (msgType === MessageType.Ready) {
                this.handleReady(conn);
                return;
            }

            const client = this.clients.get(conn.id);
            if (!client) return;

            if (msgType === MessageType.Input) {
                this.handleInput(client, data);
            } else if (msgType === MessageType.Ack) {
                const { tick } = MessageCodec.decodeAck(data);
                if (tick % 1000 === 0) {
                    console.log(`[GameServer] Client ${client.playerId} acked tick ${tick}`);
                }
            }
        } catch {
            // Silently ignore malformed packets
        }
    }

    private handleReliable(conn: ClientConnection, data: Uint8Array): void {
        if (data.length === 0) return;

        try {
            const msgType = MessageCodec.peekMessageType(data);

            if (msgType === MessageType.Join) {
                const { playerName } = MessageCodec.decodeJoin(data);
                console.log(`[GameServer] Reliable join request from: ${playerName}`);

                const client = this.clients.get(conn.id);
                if (client) {
                    this.sendJoinAccept(client);
                }
            } else if (msgType === MessageType.Ready) {
                this.handleReady(conn);
            }
        } catch {
            // Silently ignore malformed packets
        }
    }

    private handleReady(conn: ClientConnection): void {
        const client = this.clients.get(conn.id);
        if (!client) return;

        console.log(`[GameServer] Player ${client.playerId} pressed Ready`);
        this.gametypeController.onPlayerReady(client.playerId);
    }

    private handleError(conn: ClientConnection, error: Error): void {
        console.error(`[GameServer] Client ${conn.id} error:`, error.message);
    }

    // ========================================================================
    // Player Management
    // ========================================================================

    private handleJoin(conn: ClientConnection, data: Uint8Array): void {
        const { playerName } = MessageCodec.decodeJoin(data);
        console.log(`[GameServer] Join request from: ${playerName}`);

        let client = this.clients.get(conn.id);
        if (!client) {
            // Create player
            const pid = createPlayerId(this.nextPlayerId++);
            const eid = this.simulation.getStateMut().generateEntityId();
            const state = this.simulation.getStateMut();

            // Get spawn point from gametype controller (uses spawn strategy)
            const spawnPoint = this.gametypeController.onPlayerJoin(pid, eid, state);

            // Create entity
            const entity = createPlayerEntity(eid, pid, spawnPoint);
            state.addEntity(entity);

            // Track client
            client = {
                id: conn.id,
                connection: conn,
                playerId: pid,
                entityId: eid,
                lastInputSeq: 0,
            };
            this.clients.set(conn.id, client);

            console.log(`[GameServer] Player ${pid} spawned at (${spawnPoint.x.toFixed(1)}, ${spawnPoint.y.toFixed(1)}, ${spawnPoint.z.toFixed(1)})`);

            // Debug floor trace
            this.debugFloorTrace(spawnPoint);

            console.log(`[GameServer] Players: ${this.clients.size}/${this.config.maxClients}`);
        }

        this.sendWelcome(client);
        this.sendJoinAccept(client);
    }

    private handleInput(client: ClientInfo, data: Uint8Array): void {
        const { command } = MessageCodec.decodeCommand(data);

        const state = this.simulation.getStateMut();
        const mutEntity = state.getEntityMut(client.entityId);
        if (mutEntity?.input) {
            const buttons = command.buttons || 0;
            mutEntity.input.inputQueue.push({
                forward: command.direction?.z || 0,
                right: command.direction?.x || 0,
                pitch: command.pitch || 0,
                yaw: command.yaw || 0,
                buttons,
                sequence: command.seq || 0,
            });
            client.lastInputSeq = command.seq || 0;
        }
    }

    // ========================================================================
    // State Conversion
    // ========================================================================

    private toGameState(): GameState {
        const state = this.simulation.getState();
        const gameState = new GameState();
        gameState.tick = Number(state.tick);

        // Convert entities
        for (const entity of state.allEntities()) {
            const clientEntity = new Entity(`player_${entity.id}`);

            if (entity.transform) {
                clientEntity.addComponent('transform', {
                    position: { ...entity.transform.position },
                    rotation: { x: entity.transform.rotation.x, y: entity.transform.rotation.y, z: entity.transform.rotation.z, w: 1 },
                    serialize: () => ({}),
                    deserialize: () => { },
                    clone: function () { return { ...this }; }
                });
                clientEntity.addComponent('position', {
                    x: entity.transform.position.x,
                    y: entity.transform.position.y,
                    z: entity.transform.position.z,
                    serialize: () => ({}),
                    deserialize: () => { },
                    clone: function () { return { ...this }; }
                });
            }

            if (entity.physics) {
                clientEntity.addComponent('velocity', {
                    x: entity.physics.velocity.x,
                    y: entity.physics.velocity.y,
                    z: entity.physics.velocity.z,
                    linear: { ...entity.physics.velocity },
                    angular: { x: 0, y: 0, z: 0 },
                    grounded: entity.physics.grounded,
                    serialize: () => ({}),
                    deserialize: () => { },
                    clone: function () { return { ...this }; }
                });

                clientEntity.addComponent('movementState', {
                    isSliding: entity.physics.isSliding ?? false,
                    isCrouching: entity.physics.isCrouching ?? false,
                    crouchViewOffset: entity.physics.crouchViewOffset ?? 0,
                    wallJumpState: entity.physics.wallJumpState ?? 'none',
                    ledgeGrabState: entity.physics.ledgeGrabState ?? 'none',
                    actualHorizSpeed: entity.physics.actualHorizSpeed ?? 0,
                    serialize: () => ({}),
                    deserialize: () => { },
                    clone: function () { return { ...this }; }
                });
            }

            gameState.entities.set(clientEntity.id, clientEntity);

            // Player state
            if (entity.ownerId !== undefined) {
                const playerId = `player_${entity.ownerId}`;
                if (!gameState.players.has(playerId)) {
                    // Get score from gametype controller
                    const score = this.gametypeController.getMatchState().getScore(entity.ownerId);
                    const playerState: PlayerState = {
                        entityId: clientEntity.id,
                        name: `Player ${entity.ownerId}`,
                        team: '',
                        score,
                        ping: 0,
                        serialize: () => ({}),
                        deserialize: () => { },
                        clone() { return { ...this, serialize: this.serialize, deserialize: this.deserialize, clone: this.clone }; }
                    };
                    gameState.players.set(playerId, playerState);
                }
            }
        }

        // Add match state as event (client can read this for HUD)
        const matchSnapshot = this.gametypeController.getMatchSnapshot();
        gameState.events.push({
            type: 'match_state',
            ...matchSnapshot,
        });

        return gameState;
    }

    // ========================================================================
    // Network Messages
    // ========================================================================

    private broadcastSnapshot(): void {
        if (this.clients.size === 0) return;

        const gameState = this.toGameState();

        for (const client of this.clients.values()) {
            try {
                gameState.ackedInputSeq = client.lastInputSeq;
                const snapshotBytes = MessageCodec.encodeSnapshot(gameState);
                client.connection.sendDatagram(snapshotBytes);
            } catch {
                // Client may have disconnected
            }
        }
    }

    private sendWelcome(client: ClientInfo): void {
        const welcomeBytes = MessageCodec.encodeWelcome(
            'server-v2',
            this.config.serverName,
            this.config.mapName,
            this.config.tickRate,
            this.config.maxClients,
            this.clients.size
        );
        client.connection.sendReliable(welcomeBytes);
    }

    private sendJoinAccept(client: ClientInfo): void {
        const playerId = `player_${client.playerId}`;
        const entityId = `player_${client.playerId}`;

        const acceptBytes = MessageCodec.encodeJoinAccept(
            client.id,
            playerId,
            entityId
        );
        client.connection.sendReliable(acceptBytes);
        console.log(`[GameServer] Sent JoinAccept: playerId=${playerId}, entityId=${entityId}`);
    }

    // ========================================================================
    // Debug
    // ========================================================================

    private debugFloorTrace(spawnPoint: Vec3): void {
        const bounds = {
            min: { x: -16, y: -24, z: -16 },
            max: { x: 16, y: 32, z: 16 }
        };
        const start = { ...spawnPoint };
        const end = { x: spawnPoint.x, y: spawnPoint.y - 200, z: spawnPoint.z };
        const collision = this.physicsSystem.getCollisionWorld();
        if (collision) {
            const trace = collision.trace(start, end, bounds);
            const floorY = trace.hit ? spawnPoint.y - 200 * trace.fraction : 'NO HIT';
            const originY = typeof floorY === 'number' ? floorY + 24 : 'N/A';
            console.log(`[GameServer] Floor trace: spawnY=${spawnPoint.y.toFixed(1)}, floorY=${typeof floorY === 'number' ? floorY.toFixed(1) : floorY}, originY=${typeof originY === 'number' ? originY.toFixed(1) : originY}`);
        }
    }

    // ========================================================================
    // Stats
    // ========================================================================

    getStats() {
        return {
            players: this.clients.size,
            maxPlayers: this.config.maxClients,
            tick: Number(this.simulation.currentTick),
            matchPhase: this.gametypeController.getPhase(),
        };
    }
}
