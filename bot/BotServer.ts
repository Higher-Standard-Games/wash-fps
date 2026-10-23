/**
 * BotServer - Bot Intelligence Server
 *
 * Main server that manages bot lifecycle. Provides a control WebSocket API
 * for adding/removing/configuring bots. Game servers or clients connect
 * to this API to request bots.
 *
 * Architecture (follows LobbyServer pattern):
 *   - CLI entry point: src/games/fps/cli/bot-server.ts
 *   - Control API: WebSocket JSON messages on 127.0.0.1:9100. A connection must
 *     send the shared bot secret in the x-bot-secret header (see
 *     src/lobby/ServerData.ts); any other connection is closed at once.
 *   - BotClients: Spawned on demand, connect to game servers as real clients
 *
 * Control API Messages:
 *   → { type: 'add_bot', gameServerUrl: string, options?: BotOptions }
 *   ← { type: 'bot_added', botId: string, name: string }
 *
 *   → { type: 'remove_bot', botId: string }
 *   ← { type: 'bot_removed', botId: string }
 *
 *   → { type: 'remove_all' }
 *   ← { type: 'all_removed', count: number }
 *
 *   → { type: 'set_difficulty', botId: string, difficulty: string }
 *   ← { type: 'difficulty_set', botId: string }
 *
 *   → { type: 'status' }
 *   ← { type: 'status', bots: [...] }
 */

import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { background } from "../../../engine/core/AsyncErrors";
import { BOT_SECRET_HEADER, secretMatches } from "../../../lobby/ServerData";
import { BotClient, type BotClientState } from "./BotClient";
import { type BotOptions, getNextBotName } from "./BotConfig";
import { BotLobbyClient, type LobbyBotState } from "./BotLobbyClient";
import { BotNavCacheStore } from "./BotNavCache";
import { BotNavGraph } from "./BotNavGraph";
import { type BotVision, createBotVision } from "./BotVision";
import { loadLearnedRoutes } from "./LearnedRoutes";

// ── Control API Message Types ───────────────────────────────────────────

/** A control request as it arrives: its type, and fields that are whatever the sender wrote. */
interface ControlMessage {
  type: string;
  [key: string]: unknown;
}

interface AddBotRequest extends ControlMessage {
  type: "add_bot";
  gameServerUrl: string;
  options?: Partial<BotOptions>;
}

interface AddLobbyBotRequest extends ControlMessage {
  type: "add_lobby_bot";
  lobbyUrl: string;
  gametype?: string;
  options?: Partial<BotOptions>;
  lobbyId?: string;
  inviteToken?: string;
}

interface RemoveBotRequest extends ControlMessage {
  type: "remove_bot";
  botId: string;
}

interface SetDifficultyRequest extends ControlMessage {
  type: "set_difficulty";
  botId: string;
  difficulty: string;
}

/** One bot in a `status` reply. */
export interface BotStatus {
  id: string;
  name: string;
  state: BotClientState | LobbyBotState;
  brainState: string;
  playerId: string;
  server: string;
  source: "direct" | "lobby";
}

/** Everything the control socket sends back. */
type ControlResponse =
  | { type: "bot_added"; botId: string; name: string }
  | { type: "bot_preparing" }
  | { type: "bot_removed" | "error"; botId: string; error: string | undefined }
  | { type: "all_removed"; count: number }
  | { type: "difficulty_set"; botId: string }
  | { type: "status"; bots: BotStatus[] }
  | { type: "error"; error: string };

// ── BotServer ───────────────────────────────────────────────────────────

export class BotServer {
  private _wss: WebSocketServer | null = null;
  private _bots: Map<string, BotClient> = new Map();
  private _lobbyBots: Map<string, BotLobbyClient> = new Map();
  private _pendingLobbyBots = new Set<BotLobbyClient>();
  private _port: number;
  /** Trained models a bot inherits unless its request names another directory.
   *  Without this, a bot asked for over the control socket — which is what the
   *  lobby's Add bot does — could never receive a model, because the lobby
   *  sends only a difficulty. */
  private _modelDir: string | undefined;

  // Vision cache: mapName → BotVision (shared across all bots on same map)
  private _visionCache: Map<string, BotVision> = new Map();
  // NavGraph cache: mapName → BotNavGraph (shared across all bots on same map)
  private _navGraphCache: Map<string, BotNavGraph> = new Map();
  // Pending vision loads to avoid duplicate BSP loading
  private _visionLoading: Map<string, Promise<BotVision | null>> = new Map();

  // Versioned on-disk cache for deterministic map geometry analysis.
  private _navCacheStore: BotNavCacheStore = new BotNavCacheStore();
  /** Shared with the lobby: guards the control port and marks lobby bots as bots. */
  private _secret: string | undefined;

  constructor(port: number = 9100, options: { secret?: string; modelDir?: string } = {}) {
    this._port = port;
    this._secret = options.secret;
    this._modelDir = options.modelDir;
  }

  /** Where trained models live, for every bot this server spawns. */
  get modelDir(): string | undefined {
    return this._modelDir;
  }

  /** The port the control API listens on; the real one when started on port 0. */
  get port(): number {
    const address = this._wss?.address();
    return address && typeof address === "object" ? address.port : this._port;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this._secret) {
      throw new Error("BotServer control API needs the shared bot secret");
    }
    const wss = new WebSocketServer({ port: this._port, host: "127.0.0.1" });
    this._wss = wss;
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });

    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      if (!secretMatches(this._secret, req.headers[BOT_SECRET_HEADER])) {
        console.warn(`[BotServer] Refused control client without the bot secret (${req.socket.remoteAddress})`);
        ws.close(1008, "Bot secret required");
        return;
      }
      console.log(`[BotServer] Control client connected`);

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as ControlMessage;
          background(this._handleControlMessage(ws, msg), "BotServer");
        } catch (_err) {
          this._sendResponse(ws, { type: "error", error: "Invalid JSON" });
        }
      });

      ws.on("close", () => {
        console.log(`[BotServer] Control client disconnected`);
      });
    });

    console.log(`[BotServer] ✓ Control API listening on 127.0.0.1:${this.port}`);
    console.log(`[BotServer] Managing ${this._bots.size} bots`);
  }

  async stop(): Promise<void> {
    console.log(`[BotServer] Shutting down...`);

    // Disconnect all bots
    await this.removeAllBots();

    // Close control server
    if (this._wss) {
      for (const ws of this._wss.clients) ws.close();
      this._wss.close();
      this._wss = null;
    }

    console.log(`[BotServer] Stopped`);
  }

  // ── Bot Management ────────────────────────────────────────────────

  /**
   * Spawn a new bot and connect it to a game server.
   */
  async addBot(gameServerUrl: string, options?: Partial<BotOptions>): Promise<BotClient> {
    const botOptions: BotOptions = {
      name: options?.name || getNextBotName(),
      difficulty: options?.difficulty || "medium",
      team: options?.team,
      modelDir: options?.modelDir ?? this._modelDir,
      goalArbiter: options?.goalArbiter,
      chat: options?.chat,
    };

    const bot = new BotClient(botOptions);

    bot.on("disconnected", () => {
      console.log(`[BotServer] Bot ${bot.name} (${bot.id}) disconnected`);
      this._bots.delete(bot.id);
    });

    try {
      await bot.connect(gameServerUrl);
      this._bots.set(bot.id, bot);
      console.log(`[BotServer] Bot ${bot.name} (${bot.id}) spawned → ${gameServerUrl}`);

      // Load vision asynchronously (don't block bot from playing)
      background(this._loadVisionForBot(bot), "BotServer");

      return bot;
    } catch (err) {
      console.error(`[BotServer] Failed to spawn bot ${bot.name}:`, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Spawn a bot that joins through the lobby server.
   * Bot authenticates, joins queue, readies up, and auto-transitions to game.
   */
  async addLobbyBot(
    lobbyUrl: string,
    gametype: string,
    options?: Partial<BotOptions>,
    joinLobbyId?: string,
    inviteToken?: string,
    signal?: AbortSignal,
  ): Promise<BotLobbyClient> {
    const lobbyBot = new BotLobbyClient(
      {
        name: options?.name || getNextBotName(),
        difficulty: options?.difficulty || "medium",
        team: options?.team,
        modelDir: options?.modelDir ?? this._modelDir,
        goalArbiter: options?.goalArbiter,
        chat: options?.chat,
      },
      this._secret,
    );

    // When lobby bot transitions to game, track the game BotClient
    lobbyBot.onGameBotCreated = (bot: BotClient) => {
      this._bots.set(bot.id, bot);
      console.log(`[BotServer] Lobby bot ${lobbyBot.name} transitioned to game as ${bot.id}`);

      // Load vision asynchronously
      background(this._loadVisionForBot(bot), "BotServer");

      // Track game bot disconnection
      bot.on("disconnected", () => {
        this._bots.delete(bot.id);
      });
    };

    lobbyBot.onDisconnected = () => {
      this._lobbyBots.delete(lobbyBot.id);
    };

    try {
      this._pendingLobbyBots.add(lobbyBot);
      await lobbyBot.connect(lobbyUrl, gametype, joinLobbyId, inviteToken, signal);
      if (signal?.aborted) throw new Error("Bot invite cancelled");
      this._lobbyBots.set(lobbyBot.id, lobbyBot);
      const where = joinLobbyId ? `lobby ${joinLobbyId}` : `queue ${gametype}`;
      console.log(`[BotServer] Lobby bot ${lobbyBot.name} (${lobbyBot.id}) → ${where}`);
      return lobbyBot;
    } catch (err) {
      await lobbyBot.disconnect();
      console.error(`[BotServer] Failed to spawn lobby bot:`, err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      this._pendingLobbyBots.delete(lobbyBot);
    }
  }

  /**
   * Load BotVision for a bot based on its connected server's map.
   * Caches per map name so multiple bots share the same collision world.
   */
  private async _loadVisionForBot(bot: BotClient): Promise<void> {
    const mapName = bot.serverInfo?.map;
    if (!mapName) {
      console.log(`[BotServer] No map info for ${bot.name}, vision disabled`);
      return;
    }

    // Check cache first
    const cached = this._visionCache.get(mapName);
    if (cached) {
      bot.setVision(cached.fork());
      bot.setNavGraph(this._navGraphCache.get(mapName) ?? null);
      console.log(`[BotServer] Vision (cached) → ${bot.name} on map "${mapName}"`);
      return;
    }

    // Check if already loading
    let loadPromise = this._visionLoading.get(mapName);
    if (!loadPromise) {
      console.log(`[BotServer] Loading BotVision for map "${mapName}"...`);
      loadPromise = createBotVision(mapName);
      this._visionLoading.set(mapName, loadPromise);
    }

    try {
      const vision = await loadPromise;

      if (vision) {
        this._visionCache.set(mapName, vision);
        // Delete from loading AFTER setting cache to prevent duplicate loads
        this._visionLoading.delete(mapName);
        bot.setVision(vision.fork());
        console.log(`[BotServer] Vision loaded → ${bot.name} on map "${mapName}"`);

        // Build NavGraph from vision (if not already cached)
        let navGraph: BotNavGraph | null = this._navGraphCache.get(mapName) ?? null;
        if (!navGraph) {
          navGraph = this._navCacheStore.load(mapName, vision.mapKnowledge.mapFingerprint);
          console.log(`[BotServer] NavGraph cache ${this._navCacheStore.lastDiagnostic}`);
          if (!navGraph) {
            navGraph = new BotNavGraph(mapName);
            navGraph.buildFromVision(vision);
            this._navCacheStore.save(navGraph, vision.mapKnowledge.mapFingerprint);
            console.log(`[BotServer] NavGraph cache ${this._navCacheStore.lastDiagnostic}`);
          }
          // After the cache save: learned routes live in config/bot-routes and
          // change without the map changing, so they are never cached.
          const learned = navGraph.addLearnedRoutes(loadLearnedRoutes(mapName));
          this._navGraphCache.set(mapName, navGraph);
          console.log(
            `[BotServer] NavGraph built → ${navGraph.nodeCount} nodes, ${navGraph.edgeCount} edges, ${learned} learned routes`,
          );
        }
        bot.setNavGraph(navGraph);

        // Also set vision + navGraph for any other bots on the same map
        for (const [, otherBot] of this._bots) {
          if (otherBot !== bot && otherBot.serverInfo?.map === mapName) {
            otherBot.setVision(vision.fork());
            otherBot.setNavGraph(navGraph);
          }
        }
      } else {
        this._visionLoading.delete(mapName);
        console.warn(`[BotServer] Vision unavailable for map "${mapName}"`);
      }
    } catch (err) {
      this._visionLoading.delete(mapName);
      console.error(
        `[BotServer] Vision load failed for map "${mapName}":`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Remove a bot by ID.
   */
  async removeBot(botId: string): Promise<boolean> {
    const bot = this._bots.get(botId);
    if (!bot) return false;

    // Remove from map first to prevent the 'disconnected' handler from also deleting
    this._bots.delete(botId);
    await bot.dispose();
    console.log(`[BotServer] Bot ${bot.name} (${botId}) removed`);
    return true;
  }

  /**
   * Remove all bots (direct + lobby).
   */
  async removeAllBots(): Promise<number> {
    const count = this._bots.size + this._lobbyBots.size + this._pendingLobbyBots.size;
    const promises: Promise<void>[] = [];

    // Disconnect direct bots
    for (const [, bot] of this._bots) {
      promises.push(bot.dispose());
    }

    // Disconnect lobby bots (also disconnects their game bots)
    for (const [, lobbyBot] of this._lobbyBots) {
      promises.push(lobbyBot.disconnect());
    }
    for (const lobbyBot of this._pendingLobbyBots) promises.push(lobbyBot.disconnect());

    await Promise.all(promises);
    this._bots.clear();
    this._lobbyBots.clear();
    this._pendingLobbyBots.clear();
    console.log(`[BotServer] Removed all ${count} bots`);
    return count;
  }

  /**
   * Get status of all bots (direct + lobby).
   */
  getStatus(): BotStatus[] {
    const direct = Array.from(this._bots.values()).map((bot) => ({
      id: bot.id,
      name: bot.name,
      state: bot.state,
      brainState: bot.brainState,
      playerId: bot.playerId,
      server: bot.serverInfo?.serverName || "unknown",
      source: "direct" as const,
    }));

    const lobby = Array.from(this._lobbyBots.values()).map((lb) => ({
      id: lb.id,
      name: lb.name,
      state: lb.state,
      brainState: lb.botClient?.brainState || "n/a",
      playerId: lb.botClient?.playerId || "",
      server: lb.botClient?.serverInfo?.serverName || "lobby",
      source: "lobby" as const,
    }));

    return [...direct, ...lobby];
  }

  // ── Control API ───────────────────────────────────────────────────

  private async _handleControlMessage(ws: WebSocket, msg: ControlMessage): Promise<void> {
    console.log(`[BotServer] Control: ${msg.type}`);

    switch (msg.type) {
      case "add_bot": {
        try {
          const request = msg as AddBotRequest;
          const bot = await this.addBot(request.gameServerUrl, request.options);
          this._sendResponse(ws, {
            type: "bot_added",
            botId: bot.id,
            name: bot.name,
          });
        } catch (err) {
          this._sendResponse(ws, {
            type: "error",
            error: `Failed to add bot: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        break;
      }

      case "add_lobby_bot": {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        ws.once("close", cancel);
        this._sendResponse(ws, { type: "bot_preparing" });
        const request = msg as AddLobbyBotRequest;
        try {
          const bot = await this.addLobbyBot(
            request.lobbyUrl,
            request.gametype || "duel",
            request.options,
            request.lobbyId,
            request.inviteToken,
            controller.signal,
          );
          this._sendResponse(ws, {
            type: "bot_added",
            botId: bot.id,
            name: bot.name,
          });
        } catch (err) {
          this._sendResponse(ws, {
            type: "error",
            error: `Failed to add lobby bot: ${err instanceof Error ? err.message : String(err)}`,
          });
        } finally {
          ws.off("close", cancel);
        }
        break;
      }

      case "remove_bot": {
        const { botId } = msg as RemoveBotRequest;
        const removed = await this.removeBot(botId);
        this._sendResponse(ws, {
          type: removed ? "bot_removed" : "error",
          botId,
          error: removed ? undefined : "Bot not found",
        });
        break;
      }

      case "remove_all": {
        const count = await this.removeAllBots();
        this._sendResponse(ws, { type: "all_removed", count });
        break;
      }

      case "set_difficulty": {
        const { botId, difficulty } = msg as SetDifficultyRequest;
        const bot = this._bots.get(botId);
        if (bot) {
          bot.setDifficulty(difficulty);
          this._sendResponse(ws, { type: "difficulty_set", botId });
        } else {
          this._sendResponse(ws, { type: "error", error: "Bot not found" });
        }
        break;
      }

      case "status": {
        this._sendResponse(ws, {
          type: "status",
          bots: this.getStatus(),
        });
        break;
      }

      default:
        this._sendResponse(ws, {
          type: "error",
          error: `Unknown command: ${msg.type}`,
        });
    }
  }

  private _sendResponse(ws: WebSocket, msg: ControlResponse): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
