/**
 * BotClient - Headless network client for a single bot
 *
 * Connects to a game server via WebSocket, receives snapshots,
 * runs BotBrain AI decisions, and sends input commands.
 *
 * Based on src/cli/headless-netclient.ts but with:
 * - BotBrain integration for AI decisions
 * - BotGameState for world perception
 * - Proper protocol flow (Join → JoinGame → Game Loop)
 * - Death/respawn handling
 * - Human-like input timing with configurable delay
 * - Team auto-balance on join
 */

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { background } from "../../../engine/core/AsyncErrors";
import { log } from "../../../engine/core/Log";
import { SnapshotReceiver } from "../../../engine/network/client/SnapshotReceiver";
import { MessageCodec, MessageType } from "../../../engine/network/protocol/MessageCodec";
import { type BotReference, canonicalBotReference } from "../../../shared/ranking/BotReference";
import { debugEnabled, debugLog } from "../server/DebugLog";
import { BotAimController } from "./BotAimController";
import { type BotBrain, type BotInput, travelYaw } from "./BotBrain";
// HybridBrain is imported dynamically — requires @tensorflow/tfjs-node native addon
// import { HybridBrain } from './HybridBrain';
import { type BotDifficulty, type BotOptions, defaultBotChat, defaultGoalArbiterMode, InputButtons } from "./BotConfig";
import type { BotEpisodeRecorder } from "./BotEpisodeRecorder";
import { applyFriendlyFireSafety } from "./BotFireSafety";
import { BotGameState } from "./BotGameState";
import { BotPerception } from "./BotPerception";
import { initialBotReference, modelDigest } from "./BotRatingIdentity";
import { duelLeadReactionDelay } from "./BotReactionTuning";
import type { BotVision, VisionResult } from "./BotVision";
import { pulseMeleeFire } from "./BotWeaponProfile";
import { BotChat } from "./chat/BotChat";
import { StateMachineBrain } from "./StateMachineBrain";

/** Most script commands sent in one timer firing, well under the server's input buffer. */
const MAX_SCRIPT_BURST = 4;
/** Commands (200 ms) the paced repeat may fall behind before it skips the lost time. */
const MAX_PACED_BACKLOG = 25;

// ── Types ───────────────────────────────────────────────────────────────

interface ServerInfo {
  serverId: string;
  serverName: string;
  map: string;
  tickRate: number;
  maxPlayers: number;
  currentPlayers: number;
}

export type BotClientState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "spectating"
  | "joining"
  | "playing"
  | "dead";

// ── BotClient ───────────────────────────────────────────────────────────

export class BotClient extends EventEmitter {
  /** Unique ID for this bot instance */
  readonly id: string;
  /** Display name */
  readonly name: string;

  // Connection state
  private _state: BotClientState = "disconnected";
  private _ws: WebSocket | null = null;

  // Protocol state
  private _playerId: string = "";
  private _entityId: string = "";
  private _serverInfo: ServerInfo | null = null;
  private _sequence: number = 0;
  private _tickCount: number = 0;
  private _friendlyFireSuppressions: number = 0;
  private _lastSnapshotTick: number = 0;

  private readonly _snapshotReceiver = new SnapshotReceiver();

  // AI
  private _brain: BotBrain;
  private _gameState: BotGameState;
  private _difficulty: BotDifficulty;
  private readonly _chat: BotChat | null;
  private _ratingReference: BotReference;
  private _disposed = false;
  /** Resolves after model loading/fallback is known, before lobby authentication. */
  readonly referenceReady: Promise<void>;

  // 125Hz input loop (matches server tick rate)
  private _inputLoopTimer: ReturnType<typeof setInterval> | null = null;
  private _lastBotInput: BotInput | null = null; // Cached AI decision, re-sent at 125Hz
  /** Whether the last command sent pressed the melee attack (see _pulsedMeleeFire). */
  private _meleePress = false;
  /** Turns the view toward each decision's angles over the commands that carry it. */
  private _aim: BotAimController;
  /** Narrows each snapshot to what this bot can see and hear. */
  private _perception: BotPerception;
  /** A scripted movement being sent, one command per server tick (see `BotInput.script`). */
  private _script: { inputs: readonly BotInput[]; sent: number; startedAt: number } | null = null;
  /** The plain repeat of the last decision, paced by the clock rather than by timer firings. */
  private _paced: { sent: number; startedAt: number } | null = null;

  // Death/respawn
  private _isDead: boolean = false;
  private _deathTime: number = 0;
  private _respawnDelayMs: number;

  // Options
  private _team: string | undefined;
  private _admissionTicket: string | undefined;

  // Vision (shared across bots on same map)
  private _vision: BotVision | null = null;
  private _lastVisionResult: VisionResult | null = null;

  // Navigation graph (shared across bots on same map)
  private _navGraph: import("./BotNavGraph").BotNavGraph | null = null;

  // Optional episode recorder for training data collection
  private _recorder: BotEpisodeRecorder | null = null;

  // Logging
  private _logPrefix: string;

  constructor(options: BotOptions) {
    super();

    this.id = `bot_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    this.name = options.name;
    this._chat = (options.chat ?? defaultBotChat()) ? new BotChat(options.name) : null;
    this._team = options.team;

    // Resolve difficulty
    this._ratingReference = initialBotReference(options);
    this._difficulty = { ...this._ratingReference.difficulty };

    // Default to StateMachineBrain (no TF.js dependency)
    this._brain = new StateMachineBrain(this._difficulty, options.goalArbiter ?? defaultGoalArbiterMode());
    this._aim = new BotAimController(this._difficulty);
    this._perception = new BotPerception(this._difficulty);

    // If modelDir is specified, try to load HybridBrain (requires TF.js)
    this.referenceReady = options.modelDir
      ? this._initHybridBrain(options.modelDir, options.difficulty)
      : Promise.resolve();

    // Create game state tracker
    this._gameState = new BotGameState();

    // Input loop starts when playing (see _startInputLoop)
    // AI decisions happen on snapshot, but commands send at 125Hz
    this._respawnDelayMs = 1500 + Math.random() * 2000; // 1.5-3.5 sec respawn delay

    this._logPrefix = `[Bot:${this.name}]`;
  }

  /**
   * Try to load HybridBrain with TF.js models.
   * Falls back to StateMachineBrain if @tensorflow/tfjs-node isn't available.
   */
  private _initHybridBrain(modelDir: string, difficulty: string | BotDifficulty): Promise<void> {
    return Promise.all([import("./HybridBrain"), import("./ModelMetadata")])
      .then(async ([{ HybridBrain }, { resolveModelDir }]) => {
        if (this._disposed) return;
        const hybrid = new HybridBrain(this._difficulty, Math.random, this._ratingReference.goalArbiter);
        this._brain = hybrid;
        // This difficulty's own weights if self-play left some, else the base set
        const diffName = typeof difficulty === "string" ? difficulty : "medium";
        const dir = resolveModelDir(modelDir, diffName);
        const before = modelDigest(dir);
        try {
          await hybrid.loadModels(dir);
        } catch (e) {
          console.error(`${this._logPrefix} Failed to load models from ${dir}:`, e);
        }
        const after = modelDigest(dir);
        if (this._disposed) {
          hybrid.dispose();
          return;
        }
        const tactical = hybrid.tacticalModel !== null;
        const combat = hybrid.combatModel !== null;
        this._setReference({
          ...this._ratingReference,
          model: {
            status:
              before !== after || ((tactical || combat) && after === null)
                ? "unstable"
                : tactical || combat
                  ? "loaded"
                  : "fallback",
            digest: after,
            tactical,
            combat,
          },
        });
      })
      .catch(() => {
        if (this._disposed) return;
        this._setReference({
          ...this._ratingReference,
          model: { status: "fallback", digest: null, tactical: false, combat: false },
        });
        console.warn("");
        console.warn(`${this._logPrefix} ⚠️  @tensorflow/tfjs-node not available — using pure StateMachineBrain`);
        console.warn(
          `${this._logPrefix} To enable neural AI, run: pnpm rebuild @tensorflow/tfjs-node --build-addon-from-source`,
        );
        console.warn("");
      });
  }

  // ── Public API ────────────────────────────────────────────────────

  get state(): BotClientState {
    return this._state;
  }
  get ratingReference(): BotReference {
    return canonicalBotReference(this._ratingReference);
  }
  /** Lobby assignment is authoritative; model preparation can happen before it. */
  setTeam(team: string | undefined): void {
    this._team = team;
  }
  private _setReference(value: BotReference): void {
    this._ratingReference = canonicalBotReference(value);
    this.emit("ratingReferenceChanged", this.ratingReference);
  }
  get serverInfo(): ServerInfo | null {
    return this._serverInfo;
  }
  get playerId(): string {
    return this._playerId;
  }
  get entityId(): string {
    return this._entityId;
  }
  get brainState(): string {
    return this._brain.getState();
  }

  /**
   * Set the vision system (shared per map).
   * Call after construction, before connect.
   */
  setVision(vision: BotVision | null): void {
    this._vision = vision ?? null;
    this._perception.reset();
  }

  /**
   * Set the navigation graph (shared per map).
   */
  setNavGraph(navGraph: import("./BotNavGraph").BotNavGraph | null): void {
    this._navGraph = navGraph ?? null;
  }

  /**
   * Set the episode recorder for training data collection.
   * Call before connect() when using BotTrainer.
   */
  setRecorder(recorder: BotEpisodeRecorder | null): void {
    this._recorder = recorder ?? null;
  }

  /** Get the current recorder (for BotTrainer access) */
  get recorder(): BotEpisodeRecorder | null {
    return this._recorder;
  }

  /**
   * Connect to a game server.
   * Returns a promise that resolves when connection is established
   * and the bot has joined the game.
   */
  async connect(serverUrl: string, admissionTicket?: string): Promise<void> {
    if (this._state !== "disconnected") {
      throw new Error(`${this._logPrefix} Already connected (state: ${this._state})`);
    }

    this._state = "connecting";
    this._admissionTicket = admissionTicket;
    this._snapshotReceiver.reset();
    console.log(`${this._logPrefix} Connecting to ${serverUrl}...`);

    return new Promise<void>((resolve, reject) => {
      try {
        this._ws = new WebSocket(serverUrl);
        this._ws.binaryType = "arraybuffer";

        let settled = false;
        const connectTimeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`${this._logPrefix} Connection timeout`));
            background(this.disconnect(), "BotClient");
          }
        }, 10000);

        this._ws.on("open", () => {
          console.log(`${this._logPrefix} WebSocket connected, sending Join...`);
          this._state = "connected";
          // Send Join immediately — server expects it before sending Welcome
          this._sendJoin();
        });

        this._ws.on("message", (data: Buffer) => {
          try {
            const uint8 = new Uint8Array(data);
            const resolved = this._handleMessage(uint8);
            if (resolved && !settled) {
              settled = true;
              clearTimeout(connectTimeout);
              resolve();
            }
          } catch (err) {
            log.errorRateLimited(`${this._logPrefix} message`, "Message handling error:", err);
          }
        });

        this._ws.on("close", (code, _reason) => {
          clearTimeout(connectTimeout);
          console.log(`${this._logPrefix} Disconnected: ${code}`);
          this._state = "disconnected";
          this.emit("disconnected", code);
          if (!settled) {
            settled = true;
            reject(new Error(`${this._logPrefix} Connection closed before ready: ${code}`));
          }
        });

        this._ws.on("error", (err) => {
          clearTimeout(connectTimeout);
          console.error(`${this._logPrefix} Connection error:`, err.message);
          this._state = "disconnected";
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
      } catch (err) {
        this._state = "disconnected";
        reject(err);
      }
    });
  }

  /** Disconnect from the server */
  async disconnect(): Promise<void> {
    this._stopInputLoop();
    if (this._ws) {
      console.log(`${this._logPrefix} Disconnecting...`);
      this._ws.close();
      this._ws = null;
    }
    this._state = "disconnected";
    this._snapshotReceiver.reset();

    // Reset all mutable state for potential reuse
    this._playerId = "";
    this._entityId = "";
    this._sequence = 0;
    this._tickCount = 0;
    this._friendlyFireSuppressions = 0;
    this._lastSnapshotTick = 0;
    this._isDead = false;
    this._deathTime = 0;
    this._lastBotInput = null;
    this._script = null;
    this._lastVisionResult = null;
    this._aim.clear();
    this._perception.reset();
  }

  /** Update difficulty settings */
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    await this.disconnect();
    const brain = this._brain as BotBrain & { dispose?: () => void };
    // A stalled native load cannot hold cancellation open. Its completion path
    // disposes any late resources before publishing a rating reference.
    if (this._ratingReference.model.status !== "loading") brain.dispose?.();
  }

  /** Update difficulty settings */
  setDifficulty(difficulty: string | BotDifficulty): void {
    const reference = initialBotReference({
      name: this.name,
      difficulty,
      goalArbiter: this._ratingReference.goalArbiter,
    });
    this._difficulty = { ...reference.difficulty };
    this._brain.setDifficulty(this._difficulty);
    this._aim.setDifficulty(this._difficulty);
    this._perception.setDifficulty(this._difficulty);
    this._setReference({ ...reference, model: this._ratingReference.model });
  }

  // ── Message Handling ──────────────────────────────────────────────

  /**
   * Handle an incoming message. Returns true if the bot has fully joined
   * (used to resolve the connect() promise).
   */
  private _handleMessage(data: Uint8Array): boolean {
    const messageType = MessageCodec.peekMessageType(data);

    switch (messageType) {
      case MessageType.Welcome:
        return this._handleWelcome(data);

      case MessageType.JoinAccept:
        return this._handleJoinAccept(data);

      case MessageType.JoinReject:
        console.log(`${this._logPrefix} Join rejected!`);
        background(this.disconnect(), "BotClient");
        return false;

      case MessageType.LegacySnapshot:
      case MessageType.Snapshot:
        this._handleSnapshot(data);
        return false;

      case MessageType.PlayerJoined:
      case MessageType.PlayerLeft:
      case MessageType.GameStart:
        // Informational — ignore for now
        return false;

      default:
        // Unknown message type — ignore
        return false;
    }
  }

  private _handleWelcome(data: Uint8Array): boolean {
    const welcome = MessageCodec.decodeWelcome(data);
    this._serverInfo = {
      serverId: welcome.serverId,
      serverName: welcome.serverName,
      map: welcome.map,
      tickRate: welcome.tickRate,
      maxPlayers: welcome.maxPlayers,
      currentPlayers: welcome.currentPlayers,
    };

    console.log(
      `${this._logPrefix} Welcome from "${welcome.serverName}" (map: ${welcome.map}, ${welcome.currentPlayers}/${welcome.maxPlayers})`,
    );

    // Join was already sent on connect — just store server info
    return false;
  }

  private _handleJoinAccept(data: Uint8Array): boolean {
    const accept = MessageCodec.decodeJoinAccept(data);
    this._playerId = accept.playerId;
    this._entityId = accept.entityId;

    // Update game state identity
    this._gameState.selfEntityId = this._entityId;
    this._gameState.selfPlayerId = this._playerId;

    console.log(`${this._logPrefix} Join accepted: playerId=${this._playerId}, entityId=${this._entityId}`);

    if (this._state === "connected" || this._state === "spectating") {
      // First JoinAccept — we're spectating, now send JoinGame
      this._state = "spectating";
      this._sendJoinGame();
      return false;
    }

    if (this._state === "joining") {
      // Second JoinAccept (after JoinGame) — we're in the game!
      this._state = "playing";
      console.log(`${this._logPrefix} ✓ Joined game! Playing as entity ${this._entityId}`);
      this.emit("joined");
      return true;
    }

    return false;
  }

  private _handleSnapshot(data: Uint8Array): void {
    try {
      const snapshot = this._snapshotReceiver.receive(data);
      if (!snapshot) return;
      this._tickCount++;

      // Send acknowledgment
      this._sendAck(snapshot.tick);

      // Update game state from snapshot, then keep only what this bot perceives
      this._gameState.update(snapshot);
      this._perception.setDifficulty({
        ...this._difficulty,
        reactionTimeMs: this._difficulty.reactionTimeMs + duelLeadReactionDelay(this._gameState),
      });
      const vision = this._vision;
      this._perception.perceive({
        state: this._gameState,
        snapshot,
        viewYaw: this._aim.view?.yaw ?? this._gameState.self.yaw,
        canSee: vision
          ? (from, to, entityId) =>
              entityId === undefined
                ? vision.canSeeFrom(from, to)
                : vision.canSeeEnemy(entityId, from, to, this._gameState.tick)
          : null,
        pickups: vision?.mapKnowledge.pickupPositions ?? [],
      });
      this._brain.observe(this._gameState);
      this._chatter();

      this._lastSnapshotTick = snapshot.tick;

      // Only run game logic if we're actually in the game
      if (this._state !== "playing" && this._state !== "dead") {
        return;
      }

      // Handle death/respawn
      if (this._gameState.self.isDead && !this._isDead) {
        this._isDead = true;
        this._deathTime = Date.now();
        this._state = "dead";
        debugLog(
          "bot",
          () => `${this._logPrefix} Died! Waiting ${(this._respawnDelayMs / 1000).toFixed(1)}s to respawn...`,
        );

        // Record the death transition frame (critical training signal!)
        if (this._recorder) {
          const deathInput: BotInput = {
            buttons: 0,
            direction: { x: 0, y: 0, z: 0 },
            yaw: 0,
            pitch: 0,
            weaponSlot: 0,
          };
          this._recorder.recordTick(this._gameState, deathInput, this._vision, this._lastVisionResult);
        }
      }

      // Server confirmed we're alive again after being dead
      if (this._isDead && !this._gameState.self.isDead) {
        this._isDead = false;
        this._state = "playing";
        this._aim.reset(this._gameState.self.yaw, this._gameState.self.pitch);
        debugLog("bot", () => `${this._logPrefix} Respawned!`);
      }

      if (this._isDead) {
        // Check if respawn delay has passed
        if (Date.now() - this._deathTime > this._respawnDelayMs) {
          this._sendRequestSpawn();
          // Don't clear _isDead here — wait for server confirmation
          // Reset deathTime to avoid spamming (retry every respawnDelay)
          this._deathTime = Date.now();
        }
        return; // Don't send input while dead
      }

      // ── AI Decision ─────────────────────────────────────────────
      // AI decides on each snapshot. The decision is cached and re-sent
      // at 125Hz by the input loop (see _startInputLoop).

      // Run vision query if available
      if (this._vision) {
        this._lastVisionResult = this._vision.getVisibleState(this._gameState);
      }

      let input = this._brain.decide(this._gameState, this._vision, this._lastVisionResult, this._navGraph);
      this._aim.setDifficulty(this._brain.aimDifficulty);
      const fireSafety = applyFriendlyFireSafety(input, this._gameState);
      input = fireSafety.input;
      if (fireSafety.suppressed) {
        this._friendlyFireSuppressions++;
      }
      this._lastBotInput = input;
      if (input.cancelScript) {
        this._script = null;
        this._paced = null;
      }
      if (input.script && input.script.length > 0 && this._script?.inputs !== input.script) {
        this._script = { inputs: input.script, sent: 0, startedAt: performance.now() };
      }

      // Start 125Hz input loop if not already running
      if (!this._inputLoopTimer) {
        this._startInputLoop();
      }

      // Record training frame (if recorder is attached)
      if (this._recorder) {
        this._recorder.recordTick(this._gameState, input, this._vision, this._lastVisionResult);
      }

      // Status line every 300 snapshots, with SHAG_DEBUG=bot
      if (this._tickCount % 300 === 0 && debugEnabled("bot")) {
        const brain = this._brain.getState();
        const navigationInfo = this._brain.getNavigationDebug();
        const hp = this._gameState.self.health;
        const enemies = this._gameState.players.filter((p) => p.relation === "enemy" && !p.isDead).length;
        const allies = this._gameState.getAllies().length;
        const activePickups = this._gameState.pickupActiveMask.filter(Boolean).length;
        const visionInfo = this._lastVisionResult
          ? ` Vis:${this._lastVisionResult.visibleEnemies.length}/${this._lastVisionResult.tracesPerformed}t`
          : " (no vision)";
        const diagnosticInfo = `${visionInfo}${navigationInfo ? ` Nav:${navigationInfo}` : ""}`;
        // Orders held, by id. A bot standing still is either being told nothing
        // or failing to act on what it was told, and those have different
        // fixes — without this the two are indistinguishable from the outside.
        const orders = this._gameState.directives;
        const orderInfo = orders.length > 0 ? ` Orders:${orders.map((d) => d.id).join(",")}` : " Orders:none";
        console.log(
          `${this._logPrefix} [${brain}] HP:${hp} E:${enemies} A:${allies} Pickups:${activePickups}/${this._gameState.pickupActiveMask.length} FF:${this._friendlyFireSuppressions}${diagnosticInfo}${orderInfo} Tick:${snapshot.tick}`,
        );
      }
    } catch (err) {
      // A fault here repeats on every snapshot; once per 5 s per bot is enough to see it.
      log.errorRateLimited(`${this._logPrefix} snapshot`, "Snapshot processing error:", err);
    }
  }

  // ── 125Hz Input Loop ──────────────────────────────────────────────
  // Sends the last AI decision at server tick rate (125Hz = 8ms).
  // AI decisions still happen on snapshot receipt (~30Hz), but the LAST
  // decision is re-sent continuously so the server always has a fresh
  // command each tick. This matches how human clients send at 125Hz
  // via FPSController.commandAccumulator.

  private _startInputLoop(): void {
    if (this._inputLoopTimer) return;
    const TICK_MS = 8; // 125Hz = 1000/125 = 8ms
    this._inputLoopTimer = setInterval(() => {
      if (!this._lastBotInput || this._isDead || this._state !== "playing") {
        this._script = null;
        this._paced = null;
        return;
      }
      const script = this._script;
      if (!script) {
        // One command per server tick by the clock. The server runs one movement
        // step per command and waits when none has arrived, so a bot sending one
        // per timer firing (about 15.6 ms on Windows) would move at half speed.
        const now = performance.now();
        this._paced ??= { sent: 0, startedAt: now };
        const owed = Math.floor((now - this._paced.startedAt) / TICK_MS) + 1;
        // A stalled event loop has lost that time; do not send it all at once.
        if (owed - this._paced.sent > MAX_PACED_BACKLOG) this._paced.sent = owed - 1;
        const until = Math.min(owed, this._paced.sent + MAX_SCRIPT_BURST);
        while (this._paced.sent < until) {
          this._sendInput(this._aimed(this._lastBotInput, TICK_MS / 1000));
          this._paced.sent++;
        }
        return;
      }
      this._paced = null;
      // One script command per server tick. The timer fires late and unevenly
      // (Windows timers tick at about 15.6 ms), so send every command owed by
      // now; the server consumes them one per tick, in order.
      const owed = Math.floor((performance.now() - script.startedAt) / TICK_MS) + 1;
      const until = Math.min(script.inputs.length, owed, script.sent + MAX_SCRIPT_BURST);
      while (script.sent < until) {
        const input = script.inputs[script.sent++];
        this._sendInput(input);
        // A script sets the view itself; turning continues from where it left it.
        this._aim.reset(input.yaw, input.pitch);
      }
      if (script.sent >= script.inputs.length) this._script = null;
    }, TICK_MS);
    console.log(`${this._logPrefix} Started 125Hz input loop`);
  }

  /**
   * The decision as sent this tick: the view turned one step toward its
   * angles, movement still along the wanted heading. The friendly-fire gate
   * runs again on the view actually sent, which is where the shot goes.
   */
  private _aimed(input: BotInput, dt: number): BotInput {
    input = this._pulsedMeleeFire(input);
    const attack = InputButtons.FIRE | InputButtons.ALT_FIRE;
    const firing = (input.buttons & attack) !== 0;
    if (!this._aim.started) this._aim.reset(this._gameState.self.yaw, this._gameState.self.pitch);
    const view = this._aim.step(dt, input.yaw, input.pitch, firing);
    const aimed: BotInput = { ...input, yaw: view.yaw, pitch: view.pitch, moveYaw: travelYaw(input) };
    return firing ? applyFriendlyFireSafety(aimed, this._gameState).input : aimed;
  }

  /** Melee fire as sent this command: see `pulseMeleeFire`. */
  private _pulsedMeleeFire(input: BotInput): BotInput {
    const { buttons, pressed } = pulseMeleeFire(input.buttons, this._gameState.self.currentWeapon, this._meleePress);
    this._meleePress = pressed;
    return buttons === input.buttons ? input : { ...input, buttons };
  }

  private _stopInputLoop(): void {
    if (this._inputLoopTimer) {
      clearInterval(this._inputLoopTimer);
      this._inputLoopTimer = null;
    }
  }

  /** Lets chat see the match and the brain's kills and deaths, and sends a line that is ready. */
  private _chatter(): void {
    const events = this._brain.takeMoodEvents();
    if (!this._chat) return;
    const mood = this._brain.moodState;
    this._chat.observe({
      phase: this._gameState.matchState.phase,
      timeRemaining: this._gameState.matchState.timeRemaining,
      names: this._gameState.playerNames,
      mood: mood?.mood ?? "calm",
      killStreak: mood?.killStreak ?? 0,
      deathStreak: mood?.deathStreak ?? 0,
      events,
    });
    const line = this._chat.poll();
    if (line) this._send(MessageCodec.encodeChat(line));
  }

  // ── Send Messages ─────────────────────────────────────────────────

  private _send(data: Uint8Array): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(data);
    }
  }

  private _sendJoin(): void {
    console.log(`${this._logPrefix} Sending Join...`);
    // Mark as a bot so the server can tell humans from bots (demo/shutdown gating).
    this._send(MessageCodec.encodeJoin(this.name, true, this._admissionTicket));
    this._admissionTicket = undefined;
  }

  private _sendJoinGame(): void {
    this._state = "joining";

    // For team gametypes: pick the smaller team
    let teamId = this._team;
    if (!teamId) {
      teamId = this._gameState.getSmallerTeam();
    }

    console.log(`${this._logPrefix} Sending JoinGame (team: ${teamId || "auto"})...`);
    this._send(MessageCodec.encodeJoinGame(teamId));
  }

  private _sendAck(tick: number): void {
    this._send(MessageCodec.encodeAck(tick));
  }

  private _sendRequestSpawn(): void {
    debugLog("bot", () => `${this._logPrefix} Requesting respawn...`);
    this._send(MessageCodec.encodeRequestSpawn());
  }

  private _sendInput(input: BotInput): void {
    if (!this._playerId) return;

    // Rotate view-relative direction to world-space
    // Must match Game.ts sendInput() — Babylon.js LEFT-HANDED Y rotation:
    //   forward = (sin(yaw), 0, cos(yaw))
    //   right   = (cos(yaw), 0, -sin(yaw))
    // Relative to where the bot is heading, which leads the turning view.
    const moveYaw = travelYaw(input);
    const cosYaw = Math.cos(moveYaw);
    const sinYaw = Math.sin(moveYaw);
    const fwdX = sinYaw;
    const fwdZ = cosYaw;
    const rightX = cosYaw;
    const rightZ = -sinYaw;

    const viewDir = input.direction;
    let worldX = viewDir.z * fwdX + viewDir.x * rightX;
    let worldZ = viewDir.z * fwdZ + viewDir.x * rightZ;

    // Normalize
    const len = Math.sqrt(worldX * worldX + worldZ * worldZ);
    if (len > 0) {
      worldX /= len;
      worldZ /= len;
    }

    const command = {
      direction: { x: worldX, y: 0, z: worldZ },
      pitch: input.pitch,
      yaw: input.yaw,
      buttons: input.buttons,
      weaponSlot: input.weaponSlot,
      tick: this._lastSnapshotTick,
    };

    const encoded = MessageCodec.encodeCommand(this._playerId, this._sequence++, command);
    this._send(encoded);
  }
}
