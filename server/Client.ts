/**
 * Client — Shared types for server client management.
 *
 * ClientInfo tracks the state of a connected player: their connection,
 * player/entity IDs, name, input sequence, delta compression baseline, etc.
 */

import type { EntityId, PlayerId } from "@engine/server/ecs/types";
import type { FairPlayReport } from "@engine/server/network/FairPlayReport";
import type { AdmissionGrant, AdmissionManifest } from "@engine/server/network/MatchAdmission";
import type { MatchResultReport } from "@engine/server/network/MatchResultReport";
import type { ClientConnection } from "@engine/server/network/transport/WebSocketTransport";
import type { GameState } from "../../../engine/network/core/GameState";
import type { CampaignMatchRules } from "../../../lobby/types";
import type { BotReference } from "../../../shared/ranking/BotReference";

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
  /** Optional lobby-issued seats. When present, only ticket holders may play. */
  matchAdmission?: AdmissionManifest;
  /** Server-owned final snapshot, delivered once on entering PostGame. */
  onFinalResult?: (report: MatchResultReport) => void;
  /** Per-account fair-play counters, delivered once beside the final result (FairPlayLedger). */
  onFairPlay?: (report: FairPlayReport) => void;
  matchGametype?: string;
  matchMapDigest?: string;
  /**
   * Seconds spectators watch behind the match. Defaults to
   * SPECTATOR_DELAY_SECONDS on a lobby match (one with `matchAdmission`), live
   * otherwise.
   */
  spectatorDelaySeconds?: number;
  /** Lobby visibility at match start; recordings carry this flag. */
  privateMatch?: boolean;
  /**
   * The campaign mission this match plays, from the lobby. A campaign match
   * admits only its ticket holders (no spectators, no drop-in seats), starts
   * without a ready-up behind a held countdown, and its demo is marked with
   * the mission.
   */
  campaign?: string;
  /**
   * A campaign match's rules beyond map and gametype: S&D attack only, score
   * and time limits, survival waves (read when the gametype is made), and
   * bots bigger than a player, by name.
   */
  campaignRules?: CampaignMatchRules;
  /**
   * Record a training demo under this name: from the first human to join until
   * the last one leaves, a frame every server tick, into
   * `public/data/demos/training/<map>_<name>.shagdemo`. Bots learn movement
   * routes from these (see docs/research/v0.9.27-paperclips.md).
   */
  trainingDemo?: string;
}

export interface ClientInfo {
  botReference?: BotReference;
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
  /** When `lastAckedTick` last moved forward (performance.now); undefined before the first ack. */
  lastAckAtMs?: number;
  /**
   * Smoothed round trip in ms, measured by the server: snapshot sent → ack back.
   * 0 until the first ack lands. This is the game loop's actual round trip, which
   * is what a player means by ping — not a number the client reports about itself.
   */
  ping: number;
  /**
   * `ping` as the match_state roster shows it, refreshed once a second. The
   * roster goes out again whenever it changes, so a ping that moved on every
   * ack would resend it to everyone every snapshot.
   */
  rosterPing?: { ms: number; tick: number };
  /** Wall-clock (performance.now) of the last accepted respawn request. */
  lastRespawnReqMs?: number;
  /** Last timeout or time-in call, for its rate limit. */
  lastPauseCallMs?: number;
  /** The loadout last logged for this client, so a resent choice is not logged again. */
  loggedLoadout?: string;
  /** Wall-clock (performance.now) of the last accepted team/spectate switch. */
  lastTeamSwitchMs?: number;
  /** When the last clock-sync ping was answered (performance.now), for its rate limit. */
  lastPingReplyMs?: number;
  /** Wall-clock (performance.now) of the last accepted chat message. */
  lastChatMs?: number;
  /** Accepted chat timestamps inside the burst window (sliding). */
  chatStamps?: number[];
  /** Actual per-client snapshots, indexed by tick; only ACKed entries are baselines. */
  sentSnapshots?: Map<number, GameState>;
  /** Newest snapshot tick sent, kept while spectators are delayed: the feed never goes back past it. */
  newestSentTick?: number;
  /** The last snapshot sent, repeated while a new spectator waits for the delayed feed. */
  lastSnapshotBytes?: Uint8Array;
  /** When a snapshot last went to this client (performance.now), while spectators are delayed. */
  lastSnapshotSentMs?: number;
  /** Successful sends since the last full snapshot (bounded recovery interval). */
  snapshotsSinceFull?: number;
  /**
   * Lasting state this client was sent (the roster, other players' weapon_state), by key: the
   * value as sent and the first tick it went out with that value. The broadcaster leaves a value
   * out once the client has acked a tick at or after that one (SnapshotBroadcaster.leaveOutKnown).
   */
  sentState?: Map<string, { value: string; since: number }>;
  /** Successful sends since lasting state was last sent in full regardless (the safety-net refresh). */
  snapshotsSinceRefresh?: number;
  /** true = spectating (no entity in simulation), false = playing */
  isSpectator: boolean;
  /** Finite allowance for an admitted human to finish initial downloads and setup. */
  initialLoadUntilMs?: number;
  /** true = AI bot client (from the bot server), false = human. Used to gate
   *  demo recording and auto-shutdown on the presence of real players. */
  isBot?: boolean;
  /** Switch to a weapon on pickup; false when the player turned it off (`cl_autoswitch 0`). */
  autoSwitch?: boolean;
  /** Verified by a lobby-issued seat ticket; never inferred from playerName. */
  accountId?: number | null;
  seatTeam?: string;
  /** A ticket claim may be restored if this client disconnects before its first spawn. */
  preGameAdmissionGrant?: AdmissionGrant;
  /** Retained only after the ticketed seat actually entered play. */
  playedSeatTokenHash?: string;
  /** Stable across initial/recovery credentials and connection resumes. */
  playedSeatId?: string;
}
