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

import { Simulation } from "@engine/server/core/Simulation";
import { createPlayerEntity } from "@engine/server/ecs/Entity";
import type { EntityId, PlayerId } from "@engine/server/ecs/types";
import { playerId as createPlayerId } from "@engine/server/ecs/types";
// Transport
import type { ClientConnection, Transport, TransportConfig } from "@engine/server/network/transport/WebSocketTransport";
import { WebSocketServerTransport } from "@engine/server/network/transport/WebSocketTransport";
import type { Vec3 } from "@shared/server/simulation/types";
import type { BspEntity, BspModel } from "../../../engine/loader/bsp/BspLoader";
// Protocol (client-compatible)
import { MessageCodec, MessageType } from "../../../engine/network/protocol/MessageCodec";
import type { CollisionWorld } from "../../../engine/network/systems/collision/CollisionWorld";
// PVS (Potentially Visible Set) for network culling
import { ServerPVS, type ServerPVSData } from "../../../engine/server/ServerPVS";
import type { PickupEntry } from "../../../shared/bsp/PickupTable";
import type { TriggerVolume } from "../../../shared/bsp/TriggerTable";
import { MatchPhase } from "../../../shared/server/gametype/GametypeTypes";
// Match phase tracking (for auto-recording)
import { describeLoadout, parseLoadout } from "../../../shared/server/gametype/Loadout";
import { sanitizeCommand } from "../../../shared/server/simulation/InputSanitizer";
import { toClientKey } from "../ClientEntityKey";
import { nextAckedTick, rateLimited } from "./AuthorityGuards";
// Bot names
import { getNextBotName } from "./BotNames";
// Client types (shared with SnapshotBuilder, SnapshotBroadcaster)
import type { ClientInfo, GameServerConfig } from "./Client";
// Demo recording
import { DemoRecorder } from "./DemoRecorder";
import type { AwardEvent } from "./gametypes/AwardTracker";
import type { BaseGametype } from "./gametypes/BaseGametype";
import { Deathmatch } from "./gametypes/Deathmatch";
// Gametype
import { GametypeController } from "./gametypes/GametypeController";
// Anti-cheat
import { MovementValidator } from "./MovementValidator";
import { createServerTiming, type ServerTiming } from "./ServerTiming";
import { SnapshotBroadcaster } from "./SnapshotBroadcaster";
// Snapshot building (extracted from this file)
import { buildSnapshot, type SnapshotContext } from "./SnapshotBuilder";
import { CombatSystem } from "./systems/CombatSystem";
import { DroppedWeaponSystem } from "./systems/DroppedWeaponSystem";
// Subsystems
import { FPSMovementSubsystem } from "./systems/FPSMovementSubsystem";
import { PickupSystem } from "./systems/PickupSystem";
import { ProjectileSystem } from "./systems/ProjectileSystem";
import { WeaponSystem } from "./systems/WeaponSystem";
import { Telemetry } from "./Telemetry";

export type { ClientInfo, GameServerConfig };

/**
 * Whether a socket address is loopback. Used to only trust a client's self-
 * declared bot flag from localhost — the bot server always runs locally, so a
 * remote client cannot claim bot status (which would let it dodge the human-
 * presence accounting that gates demo recording and auto-shutdown).
 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "localhost" ||
    address.startsWith("::ffff:127.") ||
    address.startsWith("127.")
  );
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
  /** Absolute wall-clock deadline (performance.now ms) for the next tick. The
   * scheduler targets this so the simulation stays aligned to real time
   * regardless of setTimeout jitter or tick work duration. */
  private nextTickAt: number = 0;
  /** Tick-rate diagnostic accumulators (wall-clock). */
  private diagLastLog: number = 0;
  private diagTickCount: number = 0;
  private diagMaxTickMs: number = 0;
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

  // Per-client telemetry (WO-12): uplink jitter/loss + aim-flick signal. Derived
  // from the usercmd stream the server already receives; no sim-state coupling.
  private telemetry = new Telemetry();

  // Snapshot throttling: only broadcast every N ticks
  private snapshotTickCounter: number = 0;
  private ticksPerSnapshot: number = 1;

  // Kill events cached for snapshot broadcast (postTick drains them from CombatSystem)
  private pendingKillEvents: import("./systems/CombatSystem").KillEvent[] = [];
  // Chat messages queued for snapshot broadcast (handleChat sanitizes + rate-limits)
  private pendingChatEvents: Array<{ senderId: string; senderName: string; team: string; text: string }> = [];

  // Chat limits (server-authoritative; over-limit messages dropped, log-only)
  private static readonly CHAT_MAX_LENGTH = 128;
  private static readonly CHAT_MIN_INTERVAL_MS = 600;
  private static readonly CHAT_BURST_WINDOW_MS = 5000;
  private static readonly CHAT_BURST_MAX = 5;
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

  // Single-match post-game lifecycle (see docs/research/single_game_server_lobby.md)
  /** Tick at which the current PostGame began (null outside PostGame). */
  private _postGameEnterTick: number | null = null;
  /** One-shot latch for the +10s bot release. */
  private _postGameBotsKicked = false;

  /** The one timing contract every time-based value derives from (QA-24). */
  readonly timing: ServerTiming;

  // Challengers queue: spectators waiting to join (FIFO by conn.id)
  private challengersQueue: string[] = [];

  constructor(config: GameServerConfig, gametype?: BaseGametype) {
    this.config = config;

    // One immutable timing contract: tick, snapshot cadence, lifecycle timers.
    // Validates the config up front (rejects unrepresentable rates) and owns
    // the requested-vs-effective snapshot distinction (QA-24).
    this.timing = createServerTiming(config);

    // Create simulation
    this.simulation = new Simulation({
      tickMs: this.timing.tickMs,
    });

    this.ticksPerSnapshot = this.timing.ticksPerSnapshot;
    console.log(
      `[GameServer] Tick rate: ${this.timing.tickRate}Hz, Snapshot rate: ${this.timing.effectiveSnapshotRate}Hz (every ${this.timing.ticksPerSnapshot} ticks)`,
    );

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
    this.physicsSystem.setCombatSystem(this.combatSystem);

    // Wire weapon → movement system for weapon speed bonuses (e.g., blade +25)
    this.weaponSystem.setMovementSubsystem(this.physicsSystem);

    // Create gametype controller
    const gt = gametype || new Deathmatch();
    this.gametypeController = new GametypeController(gt);
    this.gametypeController.setSubsystems(this.combatSystem, this.weaponSystem);
    this.gametypeController.setMatchStartReset((state, tickNum) => this.resetWorldForMatch(state, tickNum));
    // Per-match server mode: post-game is terminal (lobby return flow).
    this.gametypeController.setMatchFlow(this.config.singleMatch ? "single" : "continuous");

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

    // Item rules come from the gametype — a round mode restores the map per
    // round instead of per item timer.
    const itemRules = this.gametypeController.getGametype().getItemSpawnRules();
    this.pickupSystem.setRespawnTime(itemRules.weaponRespawnTime);
    this.pickupSystem.setRespawnMode(itemRules.respawnMode ?? "timed");

    // Wire gametype self-damage config into projectile + weapon systems
    const matchConfig = this.gametypeController.getMatchState().getConfig();
    this.projectileSystem.selfDamageMultiplier = matchConfig.selfDamage;
    this.weaponSystem.selfDamageMultiplier = matchConfig.selfDamage;

    // Create transport
    // Allow extra connection slots for spectators beyond the player limit.
    // Player enforcement happens in handleJoinGame(), not at WS level.
    const maxSpectators = config.maxSpectators ?? 8;
    const transportConfig: TransportConfig = {
      port: config.port,
      maxClients: config.maxClients + maxSpectators,
      certPath: config.certPath,
      keyPath: config.keyPath,
    };

    this.transport = new WebSocketServerTransport(transportConfig, {
      onConnect: (conn) => this.handleConnect(conn),
      onDisconnect: (conn, reason) => this.handleDisconnect(conn, reason),
      onDatagram: (conn, data) => this.handleDatagram(conn, data),
      // One router for BOTH channels. The old separate handleReliable router was
      // an armed trap: unreachable over WebSocket (the WS transport delivers
      // everything via onDatagram), so a message wired only there died silently
      // — that's exactly how chat shipped broken (QA-7). A future WebTransport
      // reliable channel flows through the same complete router.
      onReliable: (conn, data) => this.handleDatagram(conn, data),
      onError: (conn, error) => this.handleError(conn, error),
    });

    console.log(`[GameServer] Created with ${this.simulation.getSubsystems().length} subsystems`);
    console.log(`[GameServer] Gametype: ${gt.name}`);
    // Anti-warp: init with expected client rate and server tick rate
    this.movementValidator = new MovementValidator(144, config.tickRate);

    // Snapshot broadcaster
    this.broadcaster = new SnapshotBroadcaster(this.simulation);
  }

  /** Reset all authoritative/transient warmup state before match-start respawns. */
  private resetWorldForMatch(state: import("@engine/server/core/WorldState").WorldState, tickNum: number): void {
    this.combatSystem.resetForMatch();
    this.weaponSystem.resetForMatch();
    this.physicsSystem.resetForMatch();
    this.projectileSystem.resetForMatch(state);
    this.droppedWeaponSystem.resetForMatch(state);
    // Round modes restore the map per ROUND, which is also where the
    // alternating-scarcity rule is applied.
    if (this.gametypeController.getMatchState().roundBased) {
      this.pickupSystem.resetForRound(tickNum);
    } else {
      this.pickupSystem.resetForMatch(tickNum);
    }

    this.knownProjectileIds.clear();
    this.pendingKillEvents = [];
    this.pendingAwards = [];
    console.log("[GameServer] Match start — reset warmup world state");
  }

  // ========================================================================
  // Setup
  // ========================================================================

  setCollisionWorld(collision: CollisionWorld): void {
    this.physicsSystem.setCollisionWorld(collision);
    this.projectileSystem.setCollisionWorld(collision);
    this.weaponSystem.setCollisionWorld(collision);
    this.droppedWeaponSystem.setCollisionWorld(collision);
    this.gametypeController.setCollisionWorld(collision);
    console.log(`[GameServer] Collision world configured`);
  }

  setSpawnPoints(points: Vec3[], teamPoints?: ReadonlyMap<string, Vec3[]>): void {
    this.gametypeController.setSpawnPoints(points, teamPoints);
  }

  /**
   * Hand the raw BSP lumps to the gametype so it can read its own map
   * authoring — bombsites, flag stands, whatever a future mode needs.
   *
   * Call after `setCollisionWorld` and `setSpawnPoints`: the gametype sees all
   * three together and most modes ignore all of it.
   */
  setMapData(entities: readonly BspEntity[], models: readonly BspModel[] = []): void {
    this.gametypeController.setMapData(entities, models);
  }

  /**
   * Set weapon/armor/health pickup locations from the shared pickup table
   * (extractPickups — ids are authoritative and shared with the client).
   */
  setPickupItems(entries: PickupEntry[]): void {
    const excluded = this.gametypeController.getGametype().getItemSpawnRules().excludeClassnames;
    if (excluded && excluded.length > 0) {
      const drop = new Set(excluded);
      const kept = entries.filter((e) => !drop.has(e.classname));
      if (kept.length !== entries.length) {
        console.log(`[GameServer] ${entries.length - kept.length} pickups excluded by gametype`);
      }
      this.pickupSystem.setPickupItems(kept);
      return;
    }
    this.pickupSystem.setPickupItems(entries);
  }

  /**
   * Set the map's trigger volumes (teleporters/jumppads) from the shared
   * TriggerTable (extractTriggerVolumes — same ids and evaluation as client
   * prediction). Applied to every player MovementProfile.
   */
  setTriggerVolumes(volumes: TriggerVolume[]): void {
    this.physicsSystem.setTriggerVolumes(volumes);
    console.log(`[GameServer] ${volumes.length} trigger volumes configured`);
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

    console.log(
      `[GameServer] Bot "${botName}" (${pid}, entity ${eid}) spawned at (${spawnPoint.x.toFixed(1)}, ${spawnPoint.y.toFixed(1)}, ${spawnPoint.z.toFixed(1)})`,
    );
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
      console.log("[GameServer] Already recording");
      return;
    }

    const gametypeName = this.gametypeController.getGametype()?.constructor?.name?.toLowerCase() || "deathmatch";

    this.demoRecorder = new DemoRecorder({
      map: this.config.mapName,
      gametype: gametypeName,
      tickRate: this.timing.tickRate,
      // Record the EFFECTIVE cadence, never the requested one: at 125/60 the
      // server broadcasts every 2 ticks = 62.5Hz, and recording "60" made
      // nominal demo playback ~4.17% slow (QA-24). Rounded because the header
      // field is a uint8; playback itself is driven by recorded frame ticks
      // (WO-DP1), so the header rate is informational.
      snapshotRate: Math.round(this.timing.effectiveSnapshotRate),
    });

    // Add existing players to roster
    for (const client of this.clients.values()) {
      if (!client.isSpectator) {
        this.demoRecorder.addPlayer(String(client.playerId), client.playerName, "");
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
      console.log("[GameServer] Not recording");
      return null;
    }

    try {
      const filepath = await this.demoRecorder.stop();
      console.log(`[GameServer] 🟢 Demo saved: ${filepath}`);
      this.demoRecorder = null;
      return filepath;
    } catch (err) {
      console.error("[GameServer] Failed to save demo:", err);
      this.demoRecorder = null;
      return null;
    }
  }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  /**
   * Actual bound port. Resolves the OS-assigned ephemeral port when the server
   * was constructed with `port: 0` (used by the protocol smoke tests to connect
   * a real client). Valid only after {@link start}.
   */
  getPort(): number {
    return this.transport.getPort();
  }

  /** Number of registered clients (spectators + players). Used by smoke tests. */
  getClientCount(): number {
    return this.clients.size;
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.simulation.initialize();
    await this.transport.start();

    this.running = true;
    const now = performance.now();
    this.nextTickAt = now + 1000 / this.config.tickRate;
    this.diagLastLog = now;
    this.diagTickCount = 0;
    this.diagMaxTickMs = 0;
    this.scheduleNextTick();

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

  /**
   * Schedule the next tick against an absolute wall-clock deadline (nextTickAt),
   * so the simulation tracks real time regardless of setTimeout jitter or tick
   * work duration.
   *
   * (Previously this measured `elapsed = now - lastTickTime` AFTER tick() ran,
   * where lastTickTime was the current tick's start — so `elapsed` was the tick
   * work time (~1ms), and the drift compensation scheduled ~16ms start-to-start
   * at 125Hz, running the whole server at ~62.5Hz / half real-time.)
   */
  private scheduleNextTick(): void {
    if (!this.running) return;

    const tickMs = 1000 / this.config.tickRate;
    const delay = Math.max(0, this.nextTickAt - performance.now());

    this.tickTimer = setTimeout(() => {
      if (!this.running) return;

      // Run every tick whose deadline has passed (catch up after jitter/stalls),
      // capped to avoid a spiral of death if the event loop fell far behind.
      const MAX_CATCHUP = 5;
      let ran = 0;
      while (performance.now() >= this.nextTickAt && ran < MAX_CATCHUP) {
        const t0 = performance.now();
        this.tick();
        this.diagMaxTickMs = Math.max(this.diagMaxTickMs, performance.now() - t0);
        this.diagTickCount++;
        this.nextTickAt += tickMs;
        ran++;
      }

      // If still behind after the catch-up cap, we hit a real stall — resync the
      // deadline to now (drop the lost game time) rather than spiral.
      if (performance.now() - this.nextTickAt > tickMs) {
        this.nextTickAt = performance.now() + tickMs;
      }

      this.logTickRateDiagnostic();
      this.scheduleNextTick();
    }, delay);
  }

  /** Log actual wall-clock tick rate every ~5s so timing regressions are visible. */
  private logTickRateDiagnostic(): void {
    const now = performance.now();
    const elapsed = now - this.diagLastLog;
    if (elapsed < 5000) return;
    const hz = (this.diagTickCount * 1000) / elapsed;
    console.log(
      `[GameServer] tickrate: ${hz.toFixed(1)}Hz actual (target ${this.config.tickRate}Hz), ` +
        `${this.diagTickCount} ticks / ${(elapsed / 1000).toFixed(1)}s, maxTickWork ${this.diagMaxTickMs.toFixed(1)}ms`,
    );
    this.logClientTelemetry();
    this.diagLastLog = now;
    this.diagTickCount = 0;
    this.diagMaxTickMs = 0;
  }

  /**
   * Emit one structured [Telemetry] line per playing client (~every 5s, on the
   * tick-rate diagnostic cadence): uplink jitter/loss, the view-angular-speed
   * aim-flick signal, and the anti-warp strike count composed from
   * MovementValidator. Shape is stable for a future admin view / WO-13 to parse.
   */
  private logClientTelemetry(): void {
    for (const client of this.clients.values()) {
      if (client.isSpectator) continue;
      const m = this.telemetry.get(client.playerId);
      if (!m || m.inputs === 0) continue;
      const strikes = this.movementValidator.getStrikes(client.playerId);
      // Accuracy (WO-AC1) lives in WeaponSystem (keyed by entity); compose here.
      // Min-sample gated — small samples are noise (see ANTICHEAT_FEATURES.md §0.3).
      const acc = this.weaponSystem.getAccuracy(client.entityId);
      const accStr = acc.shots >= 30 ? `${((acc.hits / acc.shots) * 100).toFixed(1)}%` : "n/a";
      const hsStr = acc.hits >= 10 ? `${((acc.headshots / acc.hits) * 100).toFixed(1)}%` : "n/a";
      // Impossible-input counters (WO-AC2): near-zero for honest clients. rejected/
      // clamped from the sanitizer (Telemetry), tripwire from the physics subsystem.
      const tripwire = this.physicsSystem.getTripwireHits(client.entityId as number);
      console.log(
        `[Telemetry] player=${client.playerId} inputs=${m.inputs} loss=${(m.inputLoss * 100).toFixed(1)}% ` +
          `jitter=${m.jitterMs.toFixed(1)}ms viewSpeed=${m.viewSpeedDps.toFixed(0)}dps ` +
          `peakFlick=${m.peakViewSpeedDps.toFixed(0)}dps flickHist=${m.flickHistogram.join(",")} ` +
          `warpStrikes=${strikes} ` +
          `acc=${accStr} hs=${hsStr} shots=${acc.shots} ` +
          `rejected=${m.rejectedCmds} clamped=${m.clampedCmds} tripwire=${tripwire}`,
      );
    }
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

    // 0.7. Post-game input freeze — zero movement/actions (keep look) while the
    // scoreboard screen is up, so the fight visibly ends when the match does.
    this.gametypeController.applyPostGameInputFreeze(this.simulation.getStateMut());

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
      console.log(
        `[GameServer] Cached ${recentKills.length} kill events for snapshot broadcast (total pending: ${this.pendingKillEvents.length})`,
      );
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
      // Single-match mode: remember when post-game began (drives bot kick +
      // grace close below). Reset if the phase ever leaves PostGame.
      this._postGameEnterTick = currentPhase === MatchPhase.PostGame ? (this.simulation.currentTick as number) : null;
      this._postGameBotsKicked = false;
      this._lastMatchPhase = currentPhase;
    }

    // 3c. Single-match post-game lifecycle: bots leave at +10s (they never
    // hold a server open); any stragglers are closed out at +120s so the
    // process ALWAYS exits (shutdownOnEmpty reaps it once empty).
    if (this.config.singleMatch && this._postGameEnterTick !== null) {
      const ticksInPostGame = (this.simulation.currentTick as number) - this._postGameEnterTick;
      if (!this._postGameBotsKicked && ticksInPostGame >= this.timing.postGameBotKickTicks) {
        this._postGameBotsKicked = true;
        for (const client of this.clients.values()) {
          if (client.isBot) {
            console.log(`[GameServer] Post-game: releasing bot ${client.playerName}`);
            client.connection.close("match over");
          }
        }
      }
      if (ticksInPostGame === this.timing.postGameGraceTicks) {
        console.log(`[GameServer] Post-game grace elapsed — closing remaining connections`);
        for (const client of this.clients.values()) {
          client.connection.close("match over — returning to lobby");
        }
      }
    }

    // 4. Broadcast snapshot to clients (throttled to snapshot rate)
    this.snapshotTickCounter++;
    if (this.snapshotTickCounter >= this.ticksPerSnapshot) {
      this.snapshotTickCounter = 0;

      const recording = !!this.demoRecorder?.isRecording;
      if (this.clients.size > 0 || recording) {
        // Build the snapshot ONCE and share it between broadcast + recording.
        // buildSnapshot() drains one-shot events (weapon_fire, projectile_*,
        // damage, death, …) from the subsystems as a side effect. The old code
        // built it twice — the broadcaster's build drained those events, so the
        // recorder's second build only captured persistent state (combat/weapon/
        // match), and demos never contained any shooting/impact events.
        const snapshotCtx = this.getSnapshotContext();
        const gameState = buildSnapshot(snapshotCtx);
        // Per-player orders, collected once and delivered only to the addressed
        // client. Empty for every gametype that does not opt in.
        const directives = this.gametypeController.collectAgentDirectives(
          this.simulation.getStateMut(),
          gameState.tick,
        );
        this.broadcaster.broadcast(this.clients, gameState, directives);
        if (recording) {
          this.demoRecorder?.recordFrame(gameState);
        }
      }
    }
  }

  // ========================================================================
  // Client Handlers
  // ========================================================================

  /** Human clients connected, spectators included. Drives the ready gate. */
  private refreshHumanClientCount(): void {
    let humans = 0;
    for (const client of this.clients.values()) {
      if (!client.isBot) humans++;
    }
    this.gametypeController.setHumanClientCount(humans);
  }

  private handleConnect(conn: ClientConnection): void {
    this.hasHadClients = true;
    // Cancel any pending shutdown timer
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
      console.log("[GameServer] Shutdown timer cancelled — client connected");
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
      this.gametypeController.onPlayerDisconnect(client.playerId, client.entityId);

      // Remove from anti-warp tracker
      this.movementValidator.removeClient(client.playerId);
      this.telemetry.remove(client.playerId);
    } else {
      // Spectating preserves session state; a real disconnect must release it.
      this.gametypeController.onPlayerDisconnect(client.playerId);
    }

    this.clients.delete(conn.id);
    this.refreshHumanClientCount();

    // Remove from challengers queue if queued
    this.removeFromQueue(conn.id);

    console.log(
      `[GameServer] Player ${client.playerId} disconnected (${client.isSpectator ? "spectator" : "player"}): ${reason} (${this.clients.size}/${this.config.maxClients})`,
    );

    // If a playing client disconnected, try to promote from queue
    if (!client.isSpectator) {
      this.processQueue();
    }

    // Count remaining human (non-bot) players. Bots left alone must not keep a
    // match — or its demo recording — alive, which was flooding the demo archive
    // with 10-minute bot-only recordings.
    const humansPlaying = [...this.clients.values()].some((c) => !c.isSpectator && !c.isBot);

    // Save-on-leave: finalize any active demo recording as soon as the last
    // HUMAN playing client leaves, instead of waiting for the match to formally
    // end (frag/time limit). Makes recording a demo as easy as "play, then leave".
    if (!client.isSpectator && this.demoRecorder?.isRecording && !humansPlaying) {
      console.log("[GameServer] Last human left — finalizing demo recording");
      this.stopRecording().catch((err) => console.error("[GameServer] Save-on-leave failed:", err));
    }

    // Auto-shutdown (lobby-spawned mode) when no humans remain — even if bots are
    // still connected — so a lone/bot-only match tears down instead of idling.
    const humansConnected = [...this.clients.values()].some((c) => !c.isBot);
    if (this.config.shutdownOnEmpty && this.hasHadClients && !humansConnected) {
      console.log("[GameServer] No human clients remaining — shutting down in 5 seconds...");
      this.shutdownTimer = setTimeout(() => {
        if (![...this.clients.values()].some((c) => !c.isBot)) {
          console.log("[GameServer] Auto-shutdown: no human clients remaining");
          this.stop().then(() => process.exit(0));
        }
      }, 5000);
    }
  }

  /**
   * Process the challengers queue — promote the next spectator to player.
   * Called when a playing client disconnects and a slot opens.
   */
  private processQueue(): void {
    while (this.challengersQueue.length > 0) {
      const nextConnId = this.challengersQueue.shift()!;
      const nextClient = this.clients.get(nextConnId);
      if (!nextClient || !nextClient.isSpectator) continue; // disconnected or already playing

      // Find the connection object
      const nextConn = nextClient.connection;
      console.log(`[GameServer] Promoting queued player ${nextClient.playerId} (${nextClient.playerName}) from queue`);

      // Auto-join them (same flow as handleJoinGame), bypassing the
      // client-initiated team-switch gate for server queue promotion.
      this.handleJoinGame(nextConn, undefined, true);

      // Notify them
      const msg = "You have been promoted from the challengers queue!";
      const data = MessageCodec.encodeServerMessage(msg, "info");
      nextConn.sendDatagram(data);
      return; // Only promote one at a time
    }
  }

  /**
   * Remove a connection from the challengers queue.
   */
  private removeFromQueue(connId: string): void {
    const idx = this.challengersQueue.indexOf(connId);
    if (idx !== -1) {
      this.challengersQueue.splice(idx, 1);
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
        const { teamId, manualPick } = MessageCodec.decodeJoinGame(data);
        this.handleJoinGame(conn, teamId, false, manualPick);
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

      // In-game chat. This is the ONE router for both channels (onDatagram and
      // onReliable both land here) — the old separate handleReliable router was
      // where chat silently died over WS, and it has been removed (QA-7).
      if (msgType === MessageType.Chat) {
        this.handleChat(conn, data);
        return;
      }

      if (msgType === MessageType.SetLoadout) {
        this.handleSetLoadout(conn, data);
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
        client.lastAckedTick = nextAckedTick(client.lastAckedTick, tick, Number(this.simulation.currentTick));
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
      const total =
        this.msgCounts.input +
        this.msgCounts.ack +
        this.msgCounts.join +
        this.msgCounts.ready +
        this.msgCounts.joinGame +
        this.msgCounts.spectate +
        this.msgCounts.other +
        this.msgCounts.error;
      if (total % 500 === 0) {
        console.log(
          `[GameServer] Message distribution (${total} total): Input=${this.msgCounts.input}, Ack=${this.msgCounts.ack}, Join=${this.msgCounts.join}, Ready=${this.msgCounts.ready}, JoinGame=${this.msgCounts.joinGame}, Spectate=${this.msgCounts.spectate}, Other=${this.msgCounts.other}, Errors=${this.msgCounts.error}`,
        );
      }
    } catch (err) {
      this.msgCounts.error++;
      // Log first 5 errors then every 100th
      if (this.msgCounts.error <= 5 || this.msgCounts.error % 100 === 0) {
        console.error(
          `[GameServer] Datagram error #${this.msgCounts.error}: ${err}, data[0]=0x${data[0]?.toString(16)}, len=${data.length}`,
        );
      }
    }
  }

  /**
   * A player chose a spawn kit.
   *
   * Server-authoritative in both directions: unknown weapon names are rejected
   * rather than defaulted, and the gametype decides when the choice takes
   * effect — which for S&D is the next round, never this one.
   */
  private handleSetLoadout(conn: ClientConnection, data: Uint8Array): void {
    const client = this.clients.get(conn.id);
    if (!client) return;

    const { primary, secondary } = MessageCodec.decodeSetLoadout(data);
    const choice = parseLoadout(primary, secondary);
    if (!choice) {
      console.warn(`[GameServer] Player ${client.playerId} sent an unknown loadout: ${primary}/${secondary}`);
      return;
    }

    const gametype = this.gametypeController.getGametype();
    if (!gametype.setPlayerLoadout(client.playerId, choice)) return;
    console.log(`[GameServer] Player ${client.playerId} loadout → ${describeLoadout(choice)} (from next round)`);
  }

  /**
   * In-game chat. Server-authoritative: sanitize, rate
   * limit, then queue for the next snapshot as a one-shot `chat` event —
   * which also lands in demo recordings for free (post-D16 the recorder gets
   * the same snapshot instance as the broadcaster).
   */
  private handleChat(conn: ClientConnection, data: Uint8Array): void {
    const client = this.clients.get(conn.id);
    if (!client) return;

    // Sanitize: strip control chars/newlines (charCode filter — no regex
    // escapes), collapse whitespace, cap length.
    const raw = MessageCodec.decodeChat(data).text;
    let cleaned = "";
    for (const ch of raw) {
      const code = ch.charCodeAt(0);
      cleaned += code < 32 || code === 127 ? " " : ch;
    }
    const text = cleaned.replace(/ {2,}/g, " ").trim().slice(0, GameServer.CHAT_MAX_LENGTH);
    if (!text) return;

    // Rate limit (log-only drop, consistent with authority conventions):
    // min interval between messages + burst cap over a sliding window.
    const now = performance.now();
    if (rateLimited(client.lastChatMs, now, GameServer.CHAT_MIN_INTERVAL_MS)) return;
    const stamps = (client.chatStamps ?? []).filter((t) => now - t < GameServer.CHAT_BURST_WINDOW_MS);
    if (stamps.length >= GameServer.CHAT_BURST_MAX) {
      console.log(`[Chat] rate-limited ${client.playerName} (burst)`);
      return;
    }
    stamps.push(now);
    client.chatStamps = stamps;
    client.lastChatMs = now;

    const team = client.isSpectator
      ? "spectator"
      : (this.gametypeController.getMatchState().getPlayerTeam(client.playerId) ?? "");
    console.log(`[Chat] ${client.playerName}: ${text}`);
    this.pendingChatEvents.push({
      senderId: toClientKey(client.entityId),
      senderName: client.playerName,
      team,
      text,
    });
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

    const now = performance.now();
    if (rateLimited(client.lastRespawnReqMs, now, 500)) return;
    client.lastRespawnReqMs = now;

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
    const { playerName, isBot: claimedBot } = MessageCodec.decodeJoin(data);
    // Only trust the bot flag from loopback (bots always connect locally).
    const isBot = claimedBot && isLoopbackAddress(conn.address);
    console.log(`[GameServer] Join request from: ${playerName}${isBot ? " (bot)" : ""}`);

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
        isSpectator: true, // Start as spectator
        isBot,
      };
      this.clients.set(conn.id, client);
      this.refreshHumanClientCount();

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
  private handleJoinGame(conn: ClientConnection, teamId?: string, fromQueue = false, manualPick = false): void {
    const client = this.clients.get(conn.id);
    if (!client) return;
    if (!client.isSpectator) {
      console.log(`[GameServer] Player ${client.playerId} tried to JoinGame but is already playing`);
      return;
    }
    // S&D must not create a live entity until the reliable loadout choice has
    // arrived. Keep this before the rate gate so a rejected click can be
    // retried immediately after choosing.
    const gametype = this.gametypeController.getGametype();
    if (!client.isBot && !gametype.hasChosenLoadout(client.playerId)) {
      conn.sendDatagram(MessageCodec.encodeServerMessage("Choose a loadout before joining.", "info"));
      return;
    }

    // Rate-gate client-initiated joins/switches (server queue promotion bypasses).
    // The timestamp is stamped on the accepted *attempt*, not on a successful
    // spawn: a join that then falls through to the challengers queue (server full)
    // must still count, or a client could spam JoinGame against a full server.
    if (!fromQueue) {
      const now = performance.now();
      if (rateLimited(client.lastTeamSwitchMs, now, 3000)) return;
      client.lastTeamSwitchMs = now;
    }

    // Guard: count active (non-spectator) players — reject if full
    let activePlayers = 0;
    for (const c of this.clients.values()) {
      if (!c.isSpectator) activePlayers++;
    }
    if (activePlayers >= this.config.maxClients) {
      // Add to challengers queue if not already queued
      if (!this.challengersQueue.includes(conn.id)) {
        this.challengersQueue.push(conn.id);
      }
      const queuePos = this.challengersQueue.indexOf(conn.id) + 1;
      const msg = `Teams are full. You are #${queuePos} in the challengers queue.`;
      console.log(`[GameServer] Player ${client.playerId} queued (position ${queuePos})`);

      // Send rejection message to client
      const data = MessageCodec.encodeServerMessage(msg, "queue");
      conn.sendDatagram(data);
      return;
    }

    const state = this.simulation.getStateMut();

    // Get spawn point from gametype controller (uses spawn strategy)
    const spawnPoint = this.gametypeController.onPlayerJoin(
      client.playerId,
      client.entityId,
      state,
      teamId,
      client.playerName,
      manualPick,
    );
    if (!spawnPoint) {
      console.log(`[GameServer] Player ${client.playerId} assigned to spectator, skipped physical spawn.`);
      return;
    }

    // Create entity
    const entity = createPlayerEntity(client.entityId, client.playerId, spawnPoint);
    entity.spawnTick = this.simulation.currentTick as number;

    // A round mode has no respawn, so appearing mid-round means arriving from
    // nowhere into a fight the others have been having since the freeze — and
    // spawn points belong to a side, so possibly inside the enemy's half.
    //
    // Join DEAD rather than not at all: the entity has to exist for the freeze
    // to revive it, and being dead already means the death screen, the
    // teammate spectate camera and the round-start respawn all do the right
    // thing with no new machinery.
    if (this.gametypeController.joinMustWaitForNextRound && entity.health) {
      entity.health.dead = true;
      console.log(`[GameServer] Player ${client.playerId} joined mid-round — dead until the next one`);
      const notice = MessageCodec.encodeServerMessage("Round in progress — you are in from the next one.", "info");
      conn.sendDatagram(notice);
    }

    state.addEntity(entity);

    // Register with anti-warp validator
    this.movementValidator.addClient(client.playerId);
    this.telemetry.add(client.playerId);

    // Mark as playing
    client.isSpectator = false;

    // Lobby/network bots enter through this normal join flow — register them
    // for auto-ready (spawnBot() only covers server-spawned entity bots, so
    // invited bots previously never readied and warmup always timed out).
    if (client.isBot) {
      this.gametypeController.registerBot(client.playerId);
    }

    // Record player in demo roster
    if (this.demoRecorder?.isRecording) {
      this.demoRecorder.addPlayer(
        String(client.playerId),
        client.playerName,
        "", // team assigned by gametype
      );
    }

    console.log(
      `[GameServer] Player ${client.playerId} joined game at (${spawnPoint.x.toFixed(1)}, ${spawnPoint.y.toFixed(1)}, ${spawnPoint.z.toFixed(1)})`,
    );

    // Debug floor trace
    this.debugFloorTrace(spawnPoint);

    // Re-send JoinAccept so client gets the entity ID confirmation
    this.sendJoinAccept(client);
  }

  /**
   * handleSpectate — player → spectator transition.
   * Removes the player entity while preserving match stats and mode session state.
   */
  private handleSpectate(conn: ClientConnection): void {
    const client = this.clients.get(conn.id);
    if (!client) return;
    if (client.isSpectator) {
      console.log(`[GameServer] Player ${client.playerId} tried to Spectate but is already spectating`);
      return;
    }
    const now = performance.now();
    if (rateLimited(client.lastTeamSwitchMs, now, 3000)) return;
    client.lastTeamSwitchMs = now;

    // Remove player entity from simulation
    const state = this.simulation.getStateMut();
    state.removeEntity(client.entityId);

    // Leave the active roster, but keep stats and S&D loadout for rejoin.
    this.gametypeController.onPlayerSpectate(client.playerId, client.entityId);

    // Remove from anti-warp tracker
    this.movementValidator.removeClient(client.playerId);
    this.telemetry.remove(client.playerId);

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

    const clean = sanitizeCommand(command);
    if (!clean) {
      // Non-finite usercmd — a hard contract violation (WO-AC2). Count + drop.
      this.telemetry.recordViolation(client.playerId, "rejected");
      client.lastInputSeq = seq;
      return;
    }
    // Accepted but the sanitizer had to clamp an out-of-range field (pitch beyond
    // ±90° or |wishdir|>1) — also a contract violation an honest client never sends.
    const rawDx = command.direction?.x ?? 0;
    const rawDz = command.direction?.z ?? 0;
    if (Math.abs(command.pitch ?? 0) > Math.PI / 2 + 1e-4 || Math.hypot(rawDx, rawDz) > 1 + 1e-4) {
      this.telemetry.recordViolation(client.playerId, "clamped");
    }

    const state = this.simulation.getStateMut();
    const mutEntity = state.getEntityMut(client.entityId);
    if (mutEntity?.input) {
      const buttons = clean.buttons;
      // Debug: log every 200th input to trace button values
      if (seq % 200 === 0) {
        console.log(
          `[GameServer.handleInput] Player ${client.playerId}: buttons=${buttons} (raw command.buttons=${command.buttons}), seq=${seq}`,
        );
      }
      mutEntity.input.inputQueue.push({
        forward: clean.direction.z,
        right: clean.direction.x,
        pitch: clean.pitch,
        yaw: clean.yaw,
        buttons,
        sequence: seq,
        weaponSlot: clean.weaponSlot,
      });
      client.lastInputSeq = seq;
      // Telemetry (WO-12): sample this accepted usercmd — arrival time for jitter,
      // seq for loss, sanitized view angles for the aim-flick signal.
      this.telemetry.recordInput(client.playerId, performance.now(), seq, clean.pitch, clean.yaw);
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
        pendingChatEvents: this.pendingChatEvents,
        pendingAwards: this.pendingAwards,
        needsPickupSync: this.needsPickupSync,
      };
    }
    this._snapshotCtx.pendingKillEvents = this.pendingKillEvents;
    this._snapshotCtx.pendingChatEvents = this.pendingChatEvents;
    this._snapshotCtx.pendingAwards = this.pendingAwards;
    return this._snapshotCtx;
  }

  // ========================================================================
  // Network Messages
  // ========================================================================

  private sendWelcome(client: ClientInfo): void {
    const welcomeBytes = MessageCodec.encodeWelcome(
      "server-v2",
      this.config.serverName,
      this.config.mapName,
      this.config.tickRate,
      this.config.maxClients,
      this.clients.size,
    );
    client.connection.sendReliable(welcomeBytes);
  }

  private sendJoinAccept(client: ClientInfo): void {
    const playerId = toClientKey(client.playerId);
    const entityId = toClientKey(client.entityId);

    const acceptBytes = MessageCodec.encodeJoinAccept(client.id, playerId, entityId);
    client.connection.sendReliable(acceptBytes);
    console.log(`[GameServer] Sent JoinAccept: playerId=${playerId}, entityId=${entityId}`);
  }

  // ========================================================================
  // Debug
  // ========================================================================

  private debugFloorTrace(spawnPoint: Vec3): void {
    const bounds = {
      min: { x: -16, y: -24, z: -16 },
      max: { x: 16, y: 32, z: 16 },
    };
    const start = { ...spawnPoint };
    const end = { x: spawnPoint.x, y: spawnPoint.y - 200, z: spawnPoint.z };
    const collision = this.physicsSystem.getCollisionWorld();
    if (collision) {
      const trace = collision.trace(start, end, bounds);
      const floorY = trace.hit ? spawnPoint.y - 200 * trace.fraction : "NO HIT";
      const originY = typeof floorY === "number" ? floorY + 24 : "N/A";
      console.log(
        `[GameServer] Floor trace: spawnY=${spawnPoint.y.toFixed(1)}, floorY=${typeof floorY === "number" ? floorY.toFixed(1) : floorY}, originY=${typeof originY === "number" ? originY.toFixed(1) : originY}`,
      );
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
