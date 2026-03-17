/**
 * Client — Shared types for server client management.
 *
 * ClientInfo tracks the state of a connected player: their connection,
 * player/entity IDs, name, input sequence, delta compression baseline, etc.
 */

import type { PlayerId, EntityId } from '@engine/server/ecs/types';
import type { ClientConnection } from '@engine/server/network/transport/WebSocketTransport';
import type { GameState } from '../../../engine/network/core/GameState';

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
    /** When true, server auto-exits when all clients disconnect (used by lobby spawner) */
    shutdownOnEmpty?: boolean;
}

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
    /** The actual filtered GameState last sent to this client (PVS baseline) */
    lastSentState?: GameState;
    /** true = spectating (no entity in simulation), false = playing */
    isSpectator: boolean;
}
