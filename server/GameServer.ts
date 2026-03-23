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

// Snapshot building (extracted from this file)
import { buildSnapshot, type SnapshotContext } from './SnapshotBuilder';
import { SnapshotBroadcaster } from './SnapshotBroadcaster';

// Demo recording
import { DemoRecorder } from './DemoRecorder';

// Subsystems
import { FPSMovementSubsystem } from './systems/FPSMovementSubsystem';
import { ProjectileSystem } from './systems/ProjectileSystem';
import { WeaponSystem } from './systems/WeaponSystem';
import { CombatSystem } from './systems/CombatSystem';
import { PickupSystem } from './systems/PickupSystem';
import { DroppedWeaponSystem } from './systems/DroppedWeaponSystem';

// Anti-cheat
import { MovementValidator } from './MovementValidator';

// Gametype
import { GametypeController } from './gametypes/GametypeController';
import { Deathmatch } from './gametypes/Deathmatch';
import type { BaseGametype } from './gametypes/BaseGametype';
import type { AwardEvent } from './gametypes/AwardTracker';

// Bot names
import { getNextBotName } from './BotNames';

// PVS (Potentially Visible Set) for network culling
import { ServerPVS, type ServerPVSData } from '../../../engine/server/ServerPVS';

// Match phase tracking (for auto-recording)
import { MatchPhase } from '../../../shared/server/gametype/GametypeTypes';

// Transport
import type { Transport, TransportConfig, ClientConnection } from '@engine/server/network/transport/WebSocketTransport';
import { WebSocketServerTransport } from '@engine/server/network/transport/WebSocketTransport';

// Client types (shared with SnapshotBuilder, SnapshotBroadcaster)
import { type ClientInfo, type GameServerConfig } from './Client';
export type { ClientInfo, GameServerConfig };

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
    /** Clients that need initial pickup state sync (pickups deactivated before they joined) */
    private needsPickupSync: Set<string> = new Set();
    /** Bot player ID → display name */
    private botNames: Map<PlayerId, string> = new Map();
    /** Set of bot names currently in use (for dedup) */
    private usedBotNames: Set<string> = new Set();

    // Subsystems
    private physicsSystem: FPSMovementSubsystem;
    private projectileSystem: ProjectileSystem;
    private weaponSystem: WeaponSystem;
    private combatSystem: CombatSystem;
    private pickupSystem: PickupSystem;
    private droppedWeaponSystem: DroppedWeaponSystem;

    // Gametype
    private gametypeController: GametypeController;

    // Anti-warp: rate-limit client inputs to prevent speed hacking
    private movementValidator: MovementValidator;

    // Snapshot throttling: only broadcast every N ticks
    private snapshotTickCounter: number = 0;
    private ticksPerSnapshot: number = 1;

    // Kill events cached for snapshot broadcast (postTick drains them from CombatSystem)
    private pendingKillEvents: import('./systems/CombatSystem').KillEvent[] = [];
    // Award events cached for snapshot broadcast (postTick generates them via AwardTracker)
    private pendingAwards: AwardEvent[] = [];

    // Snapshot broadcaster (owns snapshot history, PVS, delta baselines)
    private broadcaster: SnapshotBroadcaster;

    // Auto-shutdown: track if any client has ever connected
    private hasHadClients = false;
    private shutdownTimer: ReturnType<typeof setTimeout> | null = null;

    // Demo recording (optional)
    private demoRecorder: DemoRecorder | null = null;
    private _lastMatchPhase: MatchPhase = MatchPhase.Warmup;

    constructor(config: GameServerConfig, gametype?: BaseGametype) {
        this.config = config;

        // Create simulation
        this.simulation = new Simulation({
            tickMs: 1000 / config.tickRate,
        });

        // Calculate ticks-per-snapshot for decoupled snapshot rate
        const snapshotRate = config.snapshotRate ?? 60;
        this.ticksPerSnapshot = Math.max(1, Math.round(config.tickRate / snapshotRate));
        console.log(`[GameServer] Tick rate: ${config.tickRate}Hz, Snapshot rate: ${snapshotRate}Hz (every ${this.ticksPerSnapshot} ticks)`);

        // Create subsystems
        this.physicsSystem = new FPSMovementSubsystem();
        this.projectileSystem = new ProjectileSystem();
        this.weaponSystem = new WeaponSystem();
        this.combatSystem = new CombatSystem();
        this.pickupSystem = new PickupSystem();
        this.droppedWeaponSystem = new DroppedWeaponSystem();

        // Add subsystems to simulation
        this.simulation.addSubsystem(this.physicsSystem);
        this.simulation.addSubsystem(this.projectileSystem);
        this.simulation.addSubsystem(this.weaponSystem);
        this.simulation.addSubsystem(this.combatSystem);
        this.simulation.addSubsystem(this.pickupSystem);
        this.simulation.addSubsystem(this.droppedWeaponSystem);

        // Wire weapon → projectile system for type tracking
        this.weaponSystem.setProjectileSystem(this.projectileSystem);

        // Wire weapon → dropped weapon system for physical drops
        this.weaponSystem.setDroppedWeaponSystem(this.droppedWeaponSystem);

        // Wire pickup → weapon system for inventory management
        this.pickupSystem.setWeaponSystem(this.weaponSystem);

        // Wire pickup → dropped weapon system for picking up dropped weapons
        this.pickupSystem.setDroppedWeaponSystem(this.droppedWeaponSystem);

        // Wire combat → movement system for KB grounded state reset
        this.combatSystem.setMovementSubsystem(this.physicsSystem);

        // Wire weapon → movement system for weapon speed bonuses (e.g., blade +25)
        this.weaponSystem.setMovementSubsystem(this.physicsSystem);

        // Create gametype controller
        const gt = gametype || new Deathmatch();
        this.gametypeController = new GametypeController(gt);
        this.gametypeController.setSubsystems(this.combatSystem, this.weaponSystem);

        // Wire name resolver for awards (resolves PlayerId → display name)
        this.gametypeController.setNameResolver((playerId) => {
            // Check bot names first, then connected clients
            const botName = this.botNames.get(playerId);
            if (botName) return botName;
            for (const client of this.clients.values()) {
                if (client.playerId === playerId) return client.playerName;
            }
            return `Player ${playerId}`;
        });

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

        // Snapshot broadcaster
        this.broadcaster = new SnapshotBroadcaster(this.simulation);
    }

    // ========================================================================
    // Setup
    // ========================================================================

    setCollisionWorld(collision: CollisionWorld): void {
        this.physicsSystem.setCollisionWorld(collision);
        this.projectileSystem.setCollisionWorld(collision);
        this.droppedWeaponSystem.setCollisionWorld(collision);
        this.gametypeController.setCollisionWorld(collision);
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

    /**
     * Set PVS data for server-side network visibility culling.
     * When set, broadcastSnapshot() will filter entities per-client,
     * only sending entities that are in the client's potentially visible set.
     */
    setPVSData(data: ServerPVSData): void {
        const pvs = new ServerPVS(data);
        this.broadcaster.setPVS(pvs);
        console.log(`[GameServer] PVS configured: ${pvs.numClusters} clusters, enabled: ${pvs.enabled}`);
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

        // Use the full player join flow (spawn point, weapon loadout, match registration)
        const spawnPoint = this.gametypeController.onPlayerJoin(pid, eid, state);
        if (!spawnPoint) {
            console.log(`[GameServer] Bot spawn rejected (spectator)`);
            return null;
        }

        // Create entity (same as a real player — full physics, health, etc.)
        const entity = createPlayerEntity(eid, pid, spawnPoint);
        entity.spawnTick = this.simulation.currentTick as number;
        state.addEntity(entity);

        // Track as bot for auto-ready
        this.gametypeController.registerBot(pid);

        // Assign a themed bot name
        const botName = getNextBotName(this.usedBotNames);
        this.botNames.set(pid, botName);
        this.usedBotNames.add(botName);

        console.log(`[GameServer] Bot "${botName}" (${pid}, entity ${eid}) spawned at (${spawnPoint.x.toFixed(1)}, ${spawnPoint.y.toFixed(1)}, ${spawnPoint.z.toFixed(1)})`);
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
    // Demo Recording
    // ========================================================================

    /**
     * Start recording the match to a .shagdemo file.
     */
    startRecording(): void {
        if (this.demoRecorder?.isRecording) {
            console.log('[GameServer] Already recording');
            return;
        }

        const snapshotRate = this.config.snapshotRate ?? 60;
        const gametypeName = this.gametypeController.getGametype()?.constructor?.name?.toLowerCase() || 'deathmatch';

        this.demoRecorder = new DemoRecorder({
            map: this.config.mapName,
            gametype: gametypeName,
            tickRate: this.config.tickRate,
            snapshotRate,
        });

        // Add existing players to roster
        for (const client of this.clients.values()) {
            if (!client.isSpectator) {
                this.demoRecorder.addPlayer(
                    String(client.playerId),
                    client.playerName,
                    '',
                );
            }
        }

        console.log(`[GameServer] 🔴 Demo recording started`);
    }

    /**
     * Stop recording and save the demo file.
     * Returns the filepath of the saved demo, or null if not recording.
     */
    async stopRecording(): Promise<string | null> {
        if (!this.demoRecorder?.isRecording) {
            console.log('[GameServer] Not recording');
            return null;
        }

        try {
            const filepath = await this.demoRecorder.stop();
            console.log(`[GameServer] 🟢 Demo saved: ${filepath}`);
            this.demoRecorder = null;
            return filepath;
        } catch (err) {
            console.error('[GameServer] Failed to save demo:', err);
            this.demoRecorder = null;
            return null;
        }
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

        // Finalize demo recording if active
        if (this.demoRecorder?.isRecording) {
            try {
                const filepath = await this.demoRecorder.stop();
                console.log(`[GameServer] Demo saved: ${filepath}`);
            } catch (err) {
                console.error(`[GameServer] Failed to save demo:`, err);
            }
            this.demoRecorder = null;
        }

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

        // 0.5. Cache entity positions for weapon drop spawning
        const preTickState = this.simulation.getState();
        for (const entity of preTickState.allEntities()) {
            if (entity.transform && entity.ownerId !== undefined) {
                this.weaponSystem.cacheEntityPosition(entity.id, entity.transform.position);
            }
        }

        // 1. Run simulation (physics, weapons, combat)
        this.simulation.tick();

        // 2. Forward weapon & projectile damage → combat system
        for (const dmg of this.weaponSystem.getPendingDamage()) {
            this.combatSystem.queueDamage(dmg);
        }
        for (const dmg of this.projectileSystem.getPendingDamage()) {
            this.combatSystem.queueDamage(dmg);
        }

        // 2b. Accumulate kills (snapshots only send every N ticks, so we must not overwrite)
        const recentKills = this.combatSystem.getRecentKills();
        if (recentKills.length > 0) {
            this.pendingKillEvents.push(...recentKills);
            console.log(`[GameServer] Cached ${recentKills.length} kill events for snapshot broadcast (total pending: ${this.pendingKillEvents.length})`);
        }

        // 3. Run gametype controller post-tick (kills, respawns, match state)
        const state = this.simulation.getStateMut();
        this.gametypeController.postTick(state, dt, this.simulation.currentTick);

        // 3a. Accumulate awards from AwardTracker
        const awards = this.gametypeController.drainAwards();
        if (awards.length > 0) {
            this.pendingAwards.push(...awards);
        }

        // 3b. Auto-record on match phase transition (skip warmup)
        const currentPhase = this.gametypeController.getPhase();
        if (currentPhase !== this._lastMatchPhase) {
            // Match started → begin recording
            if (currentPhase === MatchPhase.Active && !this.demoRecorder?.isRecording) {
                this.startRecording();
            }
            // Match ended → stop recording
            if (currentPhase === MatchPhase.PostGame && this.demoRecorder?.isRecording) {
                this.stopRecording();
            }
            this._lastMatchPhase = currentPhase;
        }

        // 4. Broadcast snapshot to clients (throttled to snapshot rate)
        this.snapshotTickCounter++;
        if (this.snapshotTickCounter >= this.ticksPerSnapshot) {
            this.snapshotTickCounter = 0;

            const snapshotCtx = this.getSnapshotContext();
            this.broadcaster.broadcast(this.clients, snapshotCtx);

            // 4b. Record frame for demo (if recording)
            if (this.demoRecorder?.isRecording) {
                const gameState = buildSnapshot(snapshotCtx);
                this.demoRecorder.recordFrame(gameState);
            }
        }
    }

    // ========================================================================
    // Client Handlers
    // ========================================================================

    private handleConnect(conn: ClientConnection): void {
        this.hasHadClients = true;
        // Cancel any pending shutdown timer
        if (this.shutdownTimer) {
            clearTimeout(this.shutdownTimer);
            this.shutdownTimer = null;
            console.log('[GameServer] Shutdown timer cancelled — client connected');
        }
        console.log(`[GameServer] WebSocket connected: ${conn.id}`);
    }

    private handleDisconnect(conn: ClientConnection, reason: string): void {
        const client = this.clients.get(conn.id);
        if (!client) return;

        // Only remove entity and game state if client was actually playing
        if (!client.isSpectator) {
            // Remove player entity
            const state = this.simulation.getStateMut();
            state.removeEntity(client.entityId);

            // Notify gametype
            this.gametypeController.onPlayerDisconnect(client.playerId);

            // Remove from anti-warp tracker
            this.movementValidator.removeClient(client.playerId);
        }

        this.clients.delete(conn.id);
        console.log(`[GameServer] Player ${client.playerId} disconnected (${client.isSpectator ? 'spectator' : 'player'}): ${reason} (${this.clients.size}/${this.config.maxClients})`);

        // Auto-shutdown when all clients are gone (lobby-spawned mode)
        if (this.config.shutdownOnEmpty && this.hasHadClients && this.clients.size === 0) {
            console.log('[GameServer] All clients disconnected — shutting down in 5 seconds...');
            this.shutdownTimer = setTimeout(() => {
                if (this.clients.size === 0) {
                    console.log('[GameServer] Auto-shutdown: no clients remaining');
                    this.stop().then(() => process.exit(0));
                }
            }, 5000);
        }
    }

    // Debug counters for message type tracking
    private msgCounts = { input: 0, ack: 0, join: 0, ready: 0, joinGame: 0, spectate: 0, other: 0, error: 0 };

    private handleDatagram(conn: ClientConnection, data: Uint8Array): void {
        if (data.length === 0) return;

        try {
            const msgType = MessageCodec.peekMessageType(data);

            // Handle Join message (initial connect — registers as spectator)
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

            // Handle JoinGame message (spectator → player)
            if (msgType === MessageType.JoinGame) {
                this.msgCounts.joinGame++;
                const { teamId } = MessageCodec.decodeJoinGame(data);
                this.handleJoinGame(conn, teamId);
                return;
            }

            // Handle Spectate message (player → spectator)
            if (msgType === MessageType.Spectate) {
                this.msgCounts.spectate++;
                this.handleSpectate(conn);
                return;
            }

            // Handle RequestSpawn message (dead player requests respawn)
            if (msgType === MessageType.RequestSpawn) {
                this.handleRequestSpawn(conn);
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
            const total = this.msgCounts.input + this.msgCounts.ack + this.msgCounts.join + this.msgCounts.ready + this.msgCounts.joinGame + this.msgCounts.spectate + this.msgCounts.other + this.msgCounts.error;
            if (total % 500 === 0) {
                console.log(`[GameServer] Message distribution (${total} total): Input=${this.msgCounts.input}, Ack=${this.msgCounts.ack}, Join=${this.msgCounts.join}, Ready=${this.msgCounts.ready}, JoinGame=${this.msgCounts.joinGame}, Spectate=${this.msgCounts.spectate}, Other=${this.msgCounts.other}, Errors=${this.msgCounts.error}`);
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
            } else if (msgType === MessageType.JoinGame) {
                const { teamId } = MessageCodec.decodeJoinGame(data);
                this.handleJoinGame(conn, teamId);
            } else if (msgType === MessageType.Spectate) {
                this.handleSpectate(conn);
            } else if (msgType === MessageType.RequestSpawn) {
                this.handleRequestSpawn(conn);
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

    private handleRequestSpawn(conn: ClientConnection): void {
        const client = this.clients.get(conn.id);
        if (!client) return;

        // Set wantsRespawn flag on the entity — GametypeController.processRespawns() will check it
        const state = this.simulation.getStateMut();
        const entity = state.getEntityMut(client.entityId);
        if (!entity?.input || !entity.health?.dead) {
            // Not dead or no entity — ignore
            return;
        }

        entity.input.wantsRespawn = true;
        console.log(`[GameServer] RequestSpawn from player ${client.playerId}`);
    }

    private handleError(conn: ClientConnection, error: Error): void {
        console.error(`[GameServer] Client ${conn.id} error:`, error.message);
    }

    // ========================================================================
    // Player Management
    // ========================================================================

    /**
     * handleJoin — initial connect handshake.
     * Registers the client as a SPECTATOR (no entity created).
     * The client must send JoinGame to enter the match.
     */
    private handleJoin(conn: ClientConnection, data: Uint8Array): void {
        const { playerName } = MessageCodec.decodeJoin(data);
        console.log(`[GameServer] Join request from: ${playerName}`);

        let client = this.clients.get(conn.id);
        if (!client) {
            // Register client as spectator — NO entity created yet
            const pid = createPlayerId(this.nextPlayerId++);
            // Reserve an entity ID for when they join the game
            const eid = this.simulation.getStateMut().generateEntityId();

            client = {
                id: conn.id,
                connection: conn,
                playerId: pid,
                entityId: eid,
                playerName: playerName || `Player ${pid}`,
                lastInputSeq: 0,
                lastAckedTick: 0,
                isSpectator: true,  // Start as spectator
            };
            this.clients.set(conn.id, client);

            console.log(`[GameServer] Player ${pid} connected as spectator`);
            console.log(`[GameServer] Connected clients: ${this.clients.size}/${this.config.maxClients}`);
        }

        this.sendWelcome(client);
        this.sendJoinAccept(client);

        // Mark client for initial pickup state sync
        this.needsPickupSync.add(client.id);
    }

    /**
     * handleJoinGame — spectator → player transition.
     * Creates the player entity and spawns them into the match.
     */
    private handleJoinGame(conn: ClientConnection, teamId?: string): void {
        const client = this.clients.get(conn.id);
        if (!client) return;
        if (!client.isSpectator) {
            console.log(`[GameServer] Player ${client.playerId} tried to JoinGame but is already playing`);
            return;
        }

        const state = this.simulation.getStateMut();

        // Get spawn point from gametype controller (uses spawn strategy)
        const spawnPoint = this.gametypeController.onPlayerJoin(client.playerId, client.entityId, state, teamId, client.playerName);
        if (!spawnPoint) {
            console.log(`[GameServer] Player ${client.playerId} assigned to spectator, skipped physical spawn.`);
            return;
        }

        // Create entity
        const entity = createPlayerEntity(client.entityId, client.playerId, spawnPoint);
        entity.spawnTick = this.simulation.currentTick as number;
        state.addEntity(entity);

        // Register with anti-warp validator
        this.movementValidator.addClient(client.playerId);

        // Mark as playing
        client.isSpectator = false;

        // Record player in demo roster
        if (this.demoRecorder?.isRecording) {
            this.demoRecorder.addPlayer(
                String(client.playerId),
                client.playerName,
                '', // team assigned by gametype
            );
        }

        console.log(`[GameServer] Player ${client.playerId} joined game at (${spawnPoint.x.toFixed(1)}, ${spawnPoint.y.toFixed(1)}, ${spawnPoint.z.toFixed(1)})`);

        // Debug floor trace
        this.debugFloorTrace(spawnPoint);

        // Re-send JoinAccept so client gets the entity ID confirmation
        this.sendJoinAccept(client);
    }

    /**
     * handleSpectate — player → spectator transition.
     * Removes the player entity and resets match stats.
     */
    private handleSpectate(conn: ClientConnection): void {
        const client = this.clients.get(conn.id);
        if (!client) return;
        if (client.isSpectator) {
            console.log(`[GameServer] Player ${client.playerId} tried to Spectate but is already spectating`);
            return;
        }

        // Remove player entity from simulation
        const state = this.simulation.getStateMut();
        state.removeEntity(client.entityId);

        // Remove from gametype tracking (resets scores/deaths)
        this.gametypeController.onPlayerDisconnect(client.playerId);

        // Remove from anti-warp tracker
        this.movementValidator.removeClient(client.playerId);

        // Mark as spectator and reserve a fresh entity ID for potential rejoin
        client.isSpectator = true;
        client.entityId = state.generateEntityId();
        client.lastInputSeq = 0;

        console.log(`[GameServer] Player ${client.playerId} is now spectating`);
    }

    private handleInput(client: ClientInfo, data: Uint8Array): void {
        // Spectators don't send input — skip silently
        if (client.isSpectator) return;

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
                weaponSlot: command.weaponSlot || 0,
            });
            client.lastInputSeq = seq;
        }
    }

    // ========================================================================
    // Snapshot Context
    // ========================================================================

    /** Lazily provide the snapshot context (avoids creating a new object each tick) */
    private _snapshotCtx: SnapshotContext | null = null;

    private getSnapshotContext(): SnapshotContext {
        if (!this._snapshotCtx) {
            this._snapshotCtx = {
                simulation: this.simulation,
                weaponSystem: this.weaponSystem,
                projectileSystem: this.projectileSystem,
                combatSystem: this.combatSystem,
                pickupSystem: this.pickupSystem,
                droppedWeaponSystem: this.droppedWeaponSystem,
                gametypeController: this.gametypeController,
                clients: this.clients,
                botNames: this.botNames,
                knownProjectileIds: this.knownProjectileIds,
                pendingKillEvents: this.pendingKillEvents,
                pendingAwards: this.pendingAwards,
                needsPickupSync: this.needsPickupSync,
            };
        }
        this._snapshotCtx.pendingKillEvents = this.pendingKillEvents;
        this._snapshotCtx.pendingAwards = this.pendingAwards;
        return this._snapshotCtx;
    }

    // ========================================================================
    // Network Messages
    // ========================================================================

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
        const entityId = `player_${client.entityId}`;

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
