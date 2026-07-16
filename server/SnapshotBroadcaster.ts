/**
 * SnapshotBroadcaster — Builds, encodes, and sends per-client snapshots.
 *
 * Owns:
 * - Snapshot history (ring buffer for delta compression baselines)
 * - Per-client PVS filtering
 * - Delta baseline selection (global history vs per-client PVS baseline)
 * - Encoding and sending snapshot datagrams
 */

import type { Simulation } from "@engine/server/core/Simulation";
import { GameState } from "../../../engine/network/core/GameState";
import { MessageCodec } from "../../../engine/network/protocol/MessageCodec";
import type { ServerPVS } from "../../../engine/server/ServerPVS";
import { toClientKey } from "../ClientEntityKey";
import type { ClientInfo } from "./Client";

export class SnapshotBroadcaster {
  private snapshotHistory: Map<number, GameState> = new Map();
  private readonly SNAPSHOT_HISTORY_SIZE = 64;

  private simulation: Simulation;
  private pvs: ServerPVS | null = null;

  constructor(simulation: Simulation) {
    this.simulation = simulation;
  }

  /** Set PVS data for per-client visibility filtering */
  setPVS(pvs: ServerPVS | null): void {
    this.pvs = pvs;
  }

  /**
   * Encode a prebuilt snapshot per-client (with delta + PVS) and send.
   *
   * The caller builds the GameState (via buildSnapshot) so it can be shared with
   * demo recording — buildSnapshot drains one-shot events, so it must run once.
   */
  broadcast(clients: Map<string, ClientInfo>, gameState: GameState): void {
    if (clients.size === 0) return;

    // Store in snapshot history for delta compression
    const tick = gameState.tick;
    this.snapshotHistory.set(tick, gameState);

    // Prune old snapshots beyond history window
    if (this.snapshotHistory.size > this.SNAPSHOT_HISTORY_SIZE) {
      for (const key of this.snapshotHistory.keys()) {
        if (this.snapshotHistory.size <= this.SNAPSHOT_HISTORY_SIZE) break;
        this.snapshotHistory.delete(key);
      }
    }

    let totalEncodeMs = 0;
    let totalCulled = 0;
    for (const client of clients.values()) {
      try {
        // PVS filtering: build per-client filtered state if PVS is available
        // CRITICAL: Always create a per-client copy for ackedInputSeq.
        // Without this, all clients share the same gameState reference and
        // get the LAST client's lastInputSeq — causing V2NetworkClient to
        // replay wrong inputs → position desync → collision world shift.
        const pvsActive = !!(this.pvs && this.pvs.enabled);
        const clientState = pvsActive ? this.filterStateForClient(gameState, client) : gameState.shallowCopy();

        // Ack the last command the SERVER actually SIMULATED for this client's
        // entity (one-command-per-tick model) — not the last one received — so
        // reconciliation replays exactly the un-simulated inputs. Falls back to
        // the received seq if the entity has no input yet.
        const simEntity = this.simulation.getState().getEntity(client.entityId);
        const processedSeq = (simEntity?.input as { lastProcessedSeq?: number } | undefined)?.lastProcessedSeq;
        clientState.ackedInputSeq = processedSeq ?? client.lastInputSeq;

        // Delta baseline: when PVS is active, use the per-client baseline
        // (the actual filtered state the client received), not the global
        // history which contains entities the client may never have seen.
        let baseline: GameState | undefined;
        if (pvsActive) {
          baseline = client.lastSentState;
        } else {
          baseline = client.lastAckedTick > 0 ? this.snapshotHistory.get(client.lastAckedTick) : undefined;
        }

        const t0 = performance.now();
        const snapshotBytes = MessageCodec.encodeSnapshot(clientState, baseline);
        totalEncodeMs += performance.now() - t0;

        if (pvsActive) {
          totalCulled += gameState.entities.size - clientState.entities.size;
          client.lastSentState = clientState;
        }

        client.connection.sendDatagram(snapshotBytes);
      } catch {
        // Client may have disconnected
      }
    }

    // Perf: log encoding cost periodically
    if (tick % 100 === 0 && clients.size > 0) {
      const pvsInfo = this.pvs?.enabled ? `, pvs_culled: ${totalCulled} entities across ${clients.size} clients` : "";
      console.log(
        `[Perf] snapshot encode: ${totalEncodeMs.toFixed(2)}ms total, ${(totalEncodeMs / clients.size).toFixed(2)}ms/client, clients: ${clients.size}${pvsInfo}`,
      );
    }
  }

  /**
   * Filter a GameState for a specific client based on PVS visibility.
   * Entities not visible from the client's player position are culled.
   *
   * Always includes:
   * - The client's own player entity
   * - All player states (scoreboard)
   * - All events (kill feed, combat_state, projectile_spawn, etc.)
   * - Entities without position data (non-spatial)
   */
  private filterStateForClient(state: GameState, client: ClientInfo): GameState {
    if (!this.pvs) return state;

    // Get client's player position from simulation
    const simState = this.simulation.getState();
    const clientEntity = simState.getEntity(client.entityId);
    if (!clientEntity?.transform) return state;

    const viewerPos = clientEntity.transform.position;

    // Build filtered state — shallow copy with filtered entities
    const filtered = new GameState();
    filtered.tick = state.tick;
    filtered.players = state.players;
    filtered.events = [...state.events];
    filtered.pickupActiveMask = state.pickupActiveMask; // global, not PVS-filtered

    for (const [id, entity] of state.entities) {
      if (id === toClientKey(client.entityId)) {
        filtered.entities.set(id, entity);
        continue;
      }

      const posComp = entity.getComponent("position") as { x: number; y: number; z: number } | undefined;
      if (!posComp) {
        filtered.entities.set(id, entity);
        continue;
      }

      const targetPos = { x: posComp.x, y: posComp.y, z: posComp.z };
      if (this.pvs.isVisible(viewerPos, targetPos)) {
        filtered.entities.set(id, entity);
      }
    }

    return filtered;
  }
}
