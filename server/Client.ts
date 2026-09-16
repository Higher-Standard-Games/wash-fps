/**
 * Client — Shared types for server client management.
 *
 * ClientInfo tracks the state of a connected player: their connection,
 * player/entity IDs, name, input sequence, delta compression baseline, etc.
 */

import type { EntityId, PlayerId } from "@engine/server/ecs/types";
import type { ClientConnection } from "@engine/server/network/transport/WebSocketTransport";
import type { GameState } from "../../../engine/network/core/GameState";

export interface GameServerConfig {
  port: number;
  serverName: string;
  mapName: string;
  maxClients: number;
  /** Max spectator connections on top of maxClients (default: 8) */
  maxSpectators?: number;
  tickRate: number;
  /** Snapshot broadcast rate in Hz (default: 60). Must be <= tickRate. */
  snapshotRate?: number;
  certPath: string;
  keyPath: string;
  /** When true, server auto-exits when all clients disconnect (used by lobby spawner) */
  shutdownOnEmpty?: boolean;
  /** When true, this server hosts exactly ONE match: post-game is terminal
   *  (players return to the lobby, bots are kicked, process exits when empty).
   *  Default false = classic continuous warmup loop.
   *  See docs/research/single_game_server_lobby.md. */
  singleMatch?: boolean;
}

export interface ClientInfo {
  id: string;
  connection: ClientConnection;
  playerId: PlayerId;
  entityId: EntityId;
  /** Player display name from join message */
  playerName: string;
  /**
   * Secret this client presents to take its seat back after a drop. Held by
   * SuspendedSessions for the grace period; unguessable, so nobody else can
   * claim the session.
   */
  resumeToken: string;
  /** Last processed input sequence (for reconciliation) */
  lastInputSeq: number;
  /** Last snapshot tick the client has acknowledged receiving (for delta compression) */
  lastAckedTick: number;
  /**
   * Smoothed round trip in ms, measured by the server: snapshot sent → ack back.
   * 0 until the first ack lands. This is the game loop's actual round trip, which
   * is what a player means by ping — not a number the client reports about itself.
   */
  ping: number;
  /** Wall-clock (performance.now) of the last accepted respawn request. */
  lastRespawnReqMs?: number;
  /** Wall-clock (performance.now) of the last accepted team/spectate switch. */
  lastTeamSwitchMs?: number;
  /** Wall-clock (performance.now) of the last accepted chat message. */
  lastChatMs?: number;
  /** Accepted chat timestamps inside the burst window (sliding). */
  chatStamps?: number[];
  /** Actual per-client snapshots, indexed by tick; only ACKed entries are baselines. */
  sentSnapshots?: Map<number, GameState>;
  /** Successful sends since the last full snapshot (bounded recovery interval). */
  snapshotsSinceFull?: number;
  /** true = spectating (no entity in simulation), false = playing */
  isSpectator: boolean;
  /** true = AI bot client (from the bot server), false = human. Used to gate
   *  demo recording and auto-shutdown on the presence of real players. */
  isBot?: boolean;
}
