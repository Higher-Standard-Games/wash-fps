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
import { playerId as createPlayerId, EntityType } from '@engine/server/ecs/types';
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
import { PickupSystem } from './systems/PickupSystem';

// Anti-cheat
import { MovementValidator } from './MovementValidator';

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
    /** Snapshot broadcast rate in Hz (default: 30). Must be <= tickRate. */
    snapshotRate?: number;
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
    /** Player display name from join message */
    playerName: string;
    /** Last processed input sequence (for reconciliation) */
    lastInputSeq: number;
    /** Last snapshot tick the client has acknowledged receiving (for delta compression) */
    lastAckedTick: number;
}

// ============================================================================
// Game Server
// ============================================================================

export class GameServer {
    /** Track projectile entity IDs we've already sent projectile_spawn events for */
    private knownProjectileIds: Set<number> = new Set();
    private config: GameServerConfig;
    private simulation: Simulation;
    private transport: Transport;
    private clients: Map<string, ClientInfo> = new Map();
    private nextPlayerId: number = 1;
    private nextBotId: number = 900; // Bot IDs start high to avoid collisions
    private running: boolean = false;
    private tickTimer: ReturnType<typeof setTimeout> | null = null;

    // Subsystems
    private physicsSystem: FPSMovementSubsystem;
    private projectileSystem: ProjectileSystem;
    private weaponSystem: WeaponSystem;
    private combatSystem: CombatSystem;
    private pickupSystem: PickupSystem;

    // Gametype
    private gametypeController: GametypeController;

    // Anti-warp: rate-limit client inputs to prevent speed hacking
    private movementValidator: MovementValidator;

    // Snapshot throttling: only broadcast every N ticks
    private snapshotTickCounter: number = 0;
    private ticksPerSnapshot: number = 1;

    // Snapshot history for delta compression baselines
    // Ring buffer keyed by tick — stores recent GameStates so we can delta
    // each client's snapshot against the last state they acknowledged.
    private snapshotHistory: Map<number, GameState> = new Map();
    private readonly SNAPSHOT_HISTORY_SIZE = 64;

    constructor(config: GameServerConfig, gametype?: BaseGametype) {
        this.config = config;

        // Create simulation
        this.simulation = new Simulation({
            tickMs: 1000 / config.tickRate,
        });

        // Calculate ticks-per-snapshot for decoupled snapshot rate
        const snapshotRate = config.snapshotRate ?? 30;
        this.ticksPerSnapshot = Math.max(1, Math.round(config.tickRate / snapshotRate));
        console.log(`[GameServer] Tick rate: ${config.tickRate}Hz, Snapshot rate: ${snapshotRate}Hz (every ${this.ticksPerSnapshot} ticks)`);

        // Create subsystems
        this.physicsSystem = new FPSMovementSubsystem();
        this.projectileSystem = new ProjectileSystem();
        this.weaponSystem = new WeaponSystem();
        this.combatSystem = new CombatSystem();
        this.pickupSystem = new PickupSystem();

        // Add subsystems to simulation
        this.simulation.addSubsystem(this.physicsSystem);
        this.simulation.addSubsystem(this.projectileSystem);
        this.simulation.addSubsystem(this.weaponSystem);
        this.simulation.addSubsystem(this.combatSystem);
        this.simulation.addSubsystem(this.pickupSystem);

        // Wire weapon → projectile system for type tracking
        this.weaponSystem.setProjectileSystem(this.projectileSystem);

        // Wire pickup → weapon system for inventory management
        this.pickupSystem.setWeaponSystem(this.weaponSystem);

        // Wire combat → movement system for KB grounded state reset
        this.combatSystem.setMovementSubsystem(this.physicsSystem);

        // Create gametype controller
        const gt = gametype || new Deathmatch();
        this.gametypeController = new GametypeController(gt);
        this.gametypeController.setSubsystems(this.combatSystem, this.weaponSystem);

        // Wire gametype self-damage config into projectile system
        const matchConfig = this.gametypeController.getMatchState().getConfig();
        this.projectileSystem.selfDamageMultiplier = matchConfig.selfDamage;

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
        // Anti-warp: init with expected client rate and server tick rate
        this.movementValidator = new MovementValidator(144, config.tickRate);
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

    /**
     * Set weapon/item pickup locations from BSP entity data
     */
    setPickupItems(items: Array<{ classname: string; position: { x: number; y: number; z: number } }>): void {
        this.pickupSystem.setPickupItems(items);
    }

    /**
     * Set pickup respawn time (in seconds), typically called by gametype
     */
    setPickupRespawnTime(seconds: number): void {
        this.pickupSystem.setRespawnTime(seconds);
    }

    getGametypeController(): GametypeController {
        return this.gametypeController;
    }

    // ========================================================================
    // Bot Spawning
    // ========================================================================

    /**
     * Spawn a single bot at a spawn point.
     * Bots are server entities with physics and health but no input.
     */
    spawnBot(): EntityId | null {
        const state = this.simulation.getStateMut();
        const pid = createPlayerId(this.nextBotId++);
        const eid = state.generateEntityId();

        // Use the gametype spawn strategy
        const spawnPoint = this.gametypeController.getSpawnPoint(state, eid);

        // Create entity (same as a real player — full physics, health, etc.)
        const entity = createPlayerEntity(eid, pid, spawnPoint);
        state.addEntity(entity);

        console.log(`[GameServer] Bot ${pid} (entity ${eid}) spawned at (${spawnPoint.x.toFixed(1)}, ${spawnPoint.y.toFixed(1)}, ${spawnPoint.z.toFixed(1)})`);
        return eid;
    }

    /**
     * Spawn N bots at random spawn points.
     */
    spawnBots(count: number): EntityId[] {
        const spawned: EntityId[] = [];

        for (let i = 0; i < count; i++) {
            const eid = this.spawnBot();
            if (eid !== null) spawned.push(eid);
        }

        console.log(`[GameServer] Spawned ${spawned.length} bots`);
        return spawned;
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

        // 0. Reset anti-warp per-tick counters
        this.movementValidator.onTick();

        // 1. Run simulation (physics, weapons, combat)
        this.simulation.tick();

        // 2. Forward weapon & projectile damage → combat system
        for (const dmg of this.weaponSystem.getPendingDamage()) {
            this.combatSystem.queueDamage(dmg);
        }
        for (const dmg of this.projectileSystem.getPendingDamage()) {
            this.combatSystem.queueDamage(dmg);
        }

        // 3. Run gametype controller post-tick (kills, respawns, match state)
        const state = this.simulation.getStateMut();
        this.gametypeController.postTick(state, dt, this.simulation.currentTick);

        // 4. Broadcast snapshot to clients (throttled to snapshot rate)
        this.snapshotTickCounter++;
        if (this.snapshotTickCounter >= this.ticksPerSnapshot) {
            this.snapshotTickCounter = 0;
            this.broadcastSnapshot();
        }
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

        // Remove from anti-warp tracker
        this.movementValidator.removeClient(client.playerId);

        this.clients.delete(conn.id);
        console.log(`[GameServer] Player ${client.playerId} disconnected: ${reason} (${this.clients.size}/${this.config.maxClients})`);
    }

    // Debug counters for message type tracking
    private msgCounts = { input: 0, ack: 0, join: 0, ready: 0, other: 0, error: 0 };

    private handleDatagram(conn: ClientConnection, data: Uint8Array): void {
        if (data.length === 0) return;

        try {
            const msgType = MessageCodec.peekMessageType(data);

            // Handle Join message
            if (msgType === MessageType.Join) {
                this.msgCounts.join++;
                this.handleJoin(conn, data);
                return;
            }

            // Handle Ready message
            if (msgType === MessageType.Ready) {
                this.msgCounts.ready++;
                this.handleReady(conn);
                return;
            }

            const client = this.clients.get(conn.id);
            if (!client) return;

            if (msgType === MessageType.Input) {
                this.msgCounts.input++;
                this.handleInput(client, data);
            } else if (msgType === MessageType.Ack) {
                this.msgCounts.ack++;
                const { tick } = MessageCodec.decodeAck(data);
                // Store acked tick for per-client delta compression baselines
                if (tick > client.lastAckedTick) {
                    client.lastAckedTick = tick;
                }
                if (tick % 1000 === 0) {
                    console.log(`[GameServer] Client ${client.playerId} acked tick ${tick}`);
                }
            } else if (msgType === MessageType.Ping) {
                // ClockSync: reply with Pong containing client's send time + server time
                const { clientSendTime } = MessageCodec.decodePing(data);
                const pong = MessageCodec.encodePong(clientSendTime, Date.now());
                client.connection.sendDatagram(pong);
            } else {
                this.msgCounts.other++;
            }

            // Log message distribution every 500 messages
            const total = this.msgCounts.input + this.msgCounts.ack + this.msgCounts.join + this.msgCounts.ready + this.msgCounts.other + this.msgCounts.error;
            if (total % 500 === 0) {
                console.log(`[GameServer] Message distribution (${total} total): Input=${this.msgCounts.input}, Ack=${this.msgCounts.ack}, Join=${this.msgCounts.join}, Ready=${this.msgCounts.ready}, Other=${this.msgCounts.other}, Errors=${this.msgCounts.error}`);
            }
        } catch (err) {
            this.msgCounts.error++;
            // Log first 5 errors then every 100th
            if (this.msgCounts.error <= 5 || this.msgCounts.error % 100 === 0) {
                console.error(`[GameServer] Datagram error #${this.msgCounts.error}: ${err}, data[0]=0x${data[0]?.toString(16)}, len=${data.length}`);
            }
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
                playerName: playerName || `Player ${pid}`,
                lastInputSeq: 0,
                lastAckedTick: 0,
            };
            this.clients.set(conn.id, client);

            // Register with anti-warp validator
            this.movementValidator.addClient(pid);

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
        const seq = command.seq || 0;

        // Deduplicate: reject commands already processed (from command redundancy)
        // Client sends last 3 commands per tick for packet loss resilience.
        // Without this guard, each command would be applied 3x → triple movement speed.
        if (seq <= client.lastInputSeq) {
            return; // Already processed this or an older command
        }

        // Anti-warp: validate input rate (rate cap + time budget)
        if (!this.movementValidator.validateInput(client.playerId)) {
            return; // Silently drop — don't inform cheater
        }

        const state = this.simulation.getStateMut();
        const mutEntity = state.getEntityMut(client.entityId);
        if (mutEntity?.input) {
            const buttons = command.buttons || 0;
            // Debug: log every 200th input to trace button values
            if (seq % 200 === 0) {
                console.log(`[GameServer.handleInput] Player ${client.playerId}: buttons=${buttons} (raw command.buttons=${command.buttons}), seq=${seq}`);
            }
            mutEntity.input.inputQueue.push({
                forward: command.direction?.z || 0,
                right: command.direction?.x || 0,
                pitch: command.pitch || 0,
                yaw: command.yaw || 0,
                buttons,
                sequence: seq,
            });
            client.lastInputSeq = seq;
        }
    }

    // ========================================================================
    // State Conversion
    // ========================================================================

    private toGameState(): GameState {
        const state = this.simulation.getState();
        const gameState = new GameState();
        gameState.tick = Number(state.tick);

        // Convert entities (including projectiles — Q3-style server-rendered)
        for (const entity of state.allEntities()) {
            // Projectile entities get a separate path (proj_ prefix, no player state)
            if (entity.type === EntityType.Projectile) {
                const projEntity = new Entity(`proj_${entity.id}`);
                if (entity.transform) {
                    projEntity.addComponent('transform', {
                        position: { ...entity.transform.position },
                        rotation: { x: 0, y: 0, z: 0, w: 1 },
                        serialize: () => ({}),
                        deserialize: () => { },
                        clone: function () { return { ...this }; }
                    });
                    projEntity.addComponent('position', {
                        x: entity.transform.position.x,
                        y: entity.transform.position.y,
                        z: entity.transform.position.z,
                        serialize: () => ({}),
                        deserialize: () => { },
                        clone: function () { return { ...this }; }
                    });
                }
                if (entity.physics) {
                    projEntity.addComponent('velocity', {
                        x: entity.physics.velocity.x,
                        y: entity.physics.velocity.y,
                        z: entity.physics.velocity.z,
                        linear: { ...entity.physics.velocity },
                        angular: { x: 0, y: 0, z: 0 },
                        grounded: false,
                        serialize: () => ({}),
                        deserialize: () => { },
                        clone: function () { return { ...this }; }
                    });
                }
                gameState.entities.set(projEntity.id, projEntity);

                // Emit projectile_spawn event for newly created projectiles
                const numId = entity.id as number;
                if (!this.knownProjectileIds.has(numId)) {
                    this.knownProjectileIds.add(numId);
                    const defId = this.projectileSystem.getDefId(entity.id);
                    if (defId) {
                        gameState.events.push({
                            type: 'projectile_spawn',
                            entityId: `proj_${entity.id}`,
                            defId,
                        });
                    }
                }
                continue;
            }

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
                    // Get score and deaths from gametype controller
                    const matchState = this.gametypeController.getMatchState();
                    const score = matchState.getScore(entity.ownerId);
                    const deaths = matchState.getDeaths(entity.ownerId);

                    // Find real player name and ping from client info
                    let displayName = `Player ${entity.ownerId}`;
                    let ping = 0;
                    for (const client of this.clients.values()) {
                        if (client.playerId === entity.ownerId) {
                            displayName = client.playerName;
                            ping = Math.round(client.connection.latency ?? 0);
                            break;
                        }
                    }

                    const playerState: PlayerState = {
                        entityId: clientEntity.id,
                        name: displayName,
                        team: '',
                        score,
                        deaths,
                        ping,
                        serialize: () => ({}),
                        deserialize: () => { },
                        clone() { return { ...this, serialize: this.serialize, deserialize: this.deserialize, clone: this.clone }; }
                    };
                    gameState.players.set(playerId, playerState);

                    // Emit combat_state event (health/armor — private to owning player)
                    if (entity.health) {
                        gameState.events.push({
                            type: 'combat_state',
                            entityId: clientEntity.id,
                            health: Math.max(0, Math.round(entity.health.health)),
                            armor: Math.max(0, Math.round(entity.health.armor)),
                            dead: entity.health.dead,
                        });
                    }
                }
            }
        }

        // Add match state as event (client can read this for HUD)
        const matchSnapshot = this.gametypeController.getMatchSnapshot();
        gameState.events.push({
            type: 'match_state',
            ...matchSnapshot,
        });

        // Add per-player weapon state events (so clients know which weapon they have)
        for (const entity of state.allEntities()) {
            if (entity.type === EntityType.Projectile) continue;
            if (entity.ownerId === undefined) continue;

            const weaponState = this.weaponSystem.getWeaponState(entity.id);
            if (weaponState) {
                gameState.events.push({
                    type: 'weapon_state',
                    entityId: `player_${entity.id}`,
                    currentWeapon: weaponState.currentWeapon,
                    weapons: weaponState.weapons,
                    ammo: Object.fromEntries(weaponState.ammo),
                });
            }
        }

        // Add weapon fire events (so other clients can see shots)
        for (const fireEvent of this.weaponSystem.getPendingFireEvents()) {
            gameState.events.push({
                type: 'weapon_fire',
                entityId: `player_${fireEvent.entityId}`,
                weaponId: fireEvent.weaponId,
                originX: fireEvent.originX,
                originY: fireEvent.originY,
                originZ: fireEvent.originZ,
                dirX: fireEvent.dirX,
                dirY: fireEvent.dirY,
                dirZ: fireEvent.dirZ,
            });
        }

        // Add projectile impact events (so all clients see explosions)
        const impacts = this.projectileSystem.getPendingImpacts();
        for (const impact of impacts) {
            gameState.events.push({
                type: 'projectile_impact',
                defId: impact.defId,
                x: impact.x,
                y: impact.y,
                z: impact.z,
                normalX: impact.normalX,
                normalY: impact.normalY,
                normalZ: impact.normalZ,
            });
        }

        // Add pickup events (so clients can sync pickup visibility and weapon changes)
        const pickups = this.pickupSystem.getPendingPickupEvents();
        for (const pickup of pickups) {
            gameState.events.push({
                type: 'item_pickup',
                pickupId: pickup.pickupId,
                weaponId: pickup.weaponId,
                entityId: pickup.entityId,
                droppedWeaponId: pickup.droppedWeaponId || '',
                x: pickup.x,
                y: pickup.y,
                z: pickup.z,
            });
        }

        // Add damage events (forwarded from CombatSystem for floating damage numbers)
        const damageEvents = this.combatSystem.getProcessedDamage();
        for (const dmg of damageEvents) {
            gameState.events.push({
                type: 'damage',
                entityId: `player_${dmg.victimId}`,
                attackerId: dmg.attackerId !== undefined ? `player_${dmg.attackerId}` : '',
                damage: dmg.damage,
                weaponId: dmg.damageType, // Use damageType as weapon identifier for now
            });
        }
        this.combatSystem.clearProcessedDamage();

        // Add death events (forwarded from CombatSystem for kill feed)
        const killEvents = this.combatSystem.getRecentKills();
        for (const kill of killEvents) {
            gameState.events.push({
                type: 'death',
                entityId: `player_${kill.victimId}`,
                killerId: kill.killerId !== undefined ? `player_${kill.killerId}` : '',
                weaponId: kill.damageType, // Use damageType as weapon identifier
            });
        }

        return gameState;
    }

    // ========================================================================
    // Network Messages
    // ========================================================================

    private broadcastSnapshot(): void {
        if (this.clients.size === 0) return;

        const gameState = this.toGameState();

        // Store in snapshot history for delta compression
        const tick = gameState.tick;
        this.snapshotHistory.set(tick, gameState);

        // Prune old snapshots beyond history window
        if (this.snapshotHistory.size > this.SNAPSHOT_HISTORY_SIZE) {
            // Delete oldest entries
            for (const key of this.snapshotHistory.keys()) {
                if (this.snapshotHistory.size <= this.SNAPSHOT_HISTORY_SIZE) break;
                this.snapshotHistory.delete(key);
            }
        }

        let totalEncodeMs = 0;
        for (const client of this.clients.values()) {
            try {
                gameState.ackedInputSeq = client.lastInputSeq;

                // Look up client's last acked snapshot as delta baseline
                const baseline = client.lastAckedTick > 0
                    ? this.snapshotHistory.get(client.lastAckedTick)
                    : undefined;

                const t0 = performance.now();
                const snapshotBytes = MessageCodec.encodeSnapshot(gameState, baseline);
                totalEncodeMs += performance.now() - t0;

                client.connection.sendDatagram(snapshotBytes);
            } catch {
                // Client may have disconnected
            }
        }

        // Perf: log encoding cost periodically to assess Network Worker need
        if (tick % 100 === 0 && this.clients.size > 0) {
            console.log(`[Perf] snapshot encode: ${totalEncodeMs.toFixed(2)}ms total, ${(totalEncodeMs / this.clients.size).toFixed(2)}ms/client, clients: ${this.clients.size}`);
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
