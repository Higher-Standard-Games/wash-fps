/**
 * SnapshotBroadcaster — Builds, encodes, and sends per-client snapshots.
 *
 * Owns:
 * - Bounded per-client snapshot history for acknowledged delta baselines
 * - Per-client PVS filtering
 * - Baseline selection and periodic full recovery snapshots
 * - Encoding and sending snapshot datagrams
 */

import type { Simulation } from "@engine/server/core/Simulation";
import { log } from "../../../engine/core/Log";
import { GameState } from "../../../engine/network/core/GameState";
import { MessageCodec } from "../../../engine/network/protocol/MessageCodec";
import type { ServerPVS } from "../../../engine/server/ServerPVS";
import type { AgentDirective } from "../../../shared/server/gametype";
import { toClientKey } from "../ClientEntityKey";
import type { ClientInfo } from "./Client";

export class SnapshotBroadcaster {
  private readonly SNAPSHOT_HISTORY_SIZE = 64;
  private readonly FULL_SNAPSHOT_INTERVAL = 64;

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
  broadcast(
    clients: Map<string, ClientInfo>,
    gameState: GameState,
    agentDirectives?: Map<string, AgentDirective[]>,
  ): void {
    if (clients.size === 0) return;

    const tick = gameState.tick;

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

        // Agent directives are addressed to ONE client. Appending them here —
        // rather than broadcasting every player's orders in the shared snapshot
        // — keeps tactics private, which matters the moment a mode issues
        // anything a human opponent could exploit ("flank left", "he is low").
        // `shallowCopy()` shares the events array, so it must be cloned first.
        const clientDirectives = agentDirectives?.get(toClientKey(client.entityId));
        if (clientDirectives && clientDirectives.length > 0) {
          clientState.events = [
            ...clientState.events,
            {
              type: "agent_directives",
              entityId: toClientKey(client.entityId),
              directives: clientDirectives,
            },
          ];
        }

        // ACKs arrive later than snapshots. Name the exact acknowledged state
        // on the wire; never assume the last sent state was received (N01/N02).
        // Per-client history also preserves the exact prior PVS visibility set.
        client.sentSnapshots ??= new Map();
        const history = client.sentSnapshots;
        const forceFull = (client.snapshotsSinceFull ?? 0) >= this.FULL_SNAPSHOT_INTERVAL - 1;
        const baseline = forceFull ? undefined : history.get(client.lastAckedTick);

        const t0 = performance.now();
        const snapshotBytes = MessageCodec.encodeSnapshot(clientState, baseline);
        totalEncodeMs += performance.now() - t0;

        if (pvsActive) {
          totalCulled += gameState.entities.size - clientState.entities.size;
        }

        client.connection.sendDatagram(snapshotBytes);
        // Do not advance history after a synchronous send failure. Asynchronous
        // loss is safe too: a lost packet cannot become an ACKed dependency.
        // Events and match/pickup payloads are always full and aren't baseline
        // inputs. Avoid retaining those potentially large per-frame arrays.
        const retained = new GameState();
        retained.tick = tick;
        retained.entities = clientState.entities;
        retained.players = clientState.players;
        history.set(tick, retained);
        while (history.size > this.SNAPSHOT_HISTORY_SIZE) history.delete(history.keys().next().value!);
        client.snapshotsSinceFull = baseline ? (client.snapshotsSinceFull ?? 0) + 1 : 0;
      } catch (err) {
        // Usually a disconnected client — but a persistent encode/send fault
        // here must be visible, not silent (QA-16). Rate-limited: hot path.
        log.warnRateLimited("SnapshotBroadcaster", `snapshot send failed for ${client.id}:`, err);
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
    if (!this.pvs) return state.shallowCopy();

    // Get client's player position from simulation
    const simState = this.simulation.getState();
    const clientEntity = simState.getEntity(client.entityId);
    if (!clientEntity?.transform) return state.shallowCopy();

    const viewerPos = clientEntity.transform.position;

    // Build filtered state — shallow copy with filtered entities
    const filtered = new GameState();
    filtered.tick = state.tick;
    filtered.serverTimestamp = state.serverTimestamp;
    filtered.ackedInputSeq = state.ackedInputSeq;
    filtered.players = state.players;
    filtered.events = [...state.events];
    filtered.pickupActiveMask = state.pickupActiveMask; // global, not PVS-filtered
    filtered.matchSnapshot = state.matchSnapshot;

    // A dead S&D player may chase teammates. Keep enemies PVS-filtered from the
    // corpse viewpoint, but always replicate living/dead teammates so cycling
    // the spectator camera cannot land on an entity missing from the snapshot.
    const ownPlayer = state.players.get(toClientKey(client.playerId));
    const teammateEntityIds = new Set<string>();
    if (clientEntity.health?.dead && ownPlayer?.team && ownPlayer.team !== "spectator") {
      for (const player of state.players.values()) {
        if (player.team === ownPlayer.team) teammateEntityIds.add(player.entityId);
      }
    }

    for (const [id, entity] of state.entities) {
      if (id === toClientKey(client.entityId)) {
        filtered.entities.set(id, entity);
        continue;
      }

      if (teammateEntityIds.has(id)) {
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
