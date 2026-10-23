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
import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "@shared/server/simulation/physics/constants";
import { log } from "../../../engine/core/Log";
import { GameState } from "../../../engine/network/core/GameState";
import { MessageCodec } from "../../../engine/network/protocol/MessageCodec";
import type { ServerPVS } from "../../../engine/server/ServerPVS";
import { type AgentDirective, isSide, sameSide } from "../../../shared/server/gametype";
import { toClientKey } from "../ClientEntityKey";
import { chatVisibleTo } from "./ChatRouting";
import type { ClientInfo } from "./Client";
import { debugLog } from "./DebugLog";

const ROSTER_KEY = "roster";
/** Snapshot key prefix of a dropped weapon (SnapshotBuilder). */
const DROPPED_WEAPON_PREFIX = "item_";
// Looked up for every weapon_state event for every client every snapshot, so
// the key strings are built once per entity rather than each time. Entity ids
// only grow as players come and go; the cap keeps a long-lived server bounded.
const weaponKeys = new Map<string, string>();
function weaponKey(entityId: string): string {
  let key = weaponKeys.get(entityId);
  if (key === undefined) {
    if (weaponKeys.size >= 4096) weaponKeys.clear();
    key = `weapon:${entityId}`;
    weaponKeys.set(entityId, key);
  }
  return key;
}

type SnapshotEvent = GameState["events"][number];

/**
 * Who may read each player's health and armor this snapshot. combat_state goes
 * out for every player because a spectator, or a dead S&D player chasing a
 * teammate, needs the watched player's bars. Everyone else used to receive
 * every opponent's health too, which a modified client could draw over heads.
 */
function healthAudienceOf(state: GameState): { teamBased: boolean; teamOf: Map<string, string> } {
  const teamOf = new Map<string, string>();
  for (const player of state.players.values()) teamOf.set(player.entityId, player.team);
  const match = state.events.find((event) => event.type === "match_state") as { teamBased?: boolean } | undefined;
  return { teamBased: match?.teamBased === true, teamOf };
}

/** This snapshot's lasting state as strings, by key, made once and compared for every client. */
function lastingStateOf(state: GameState): Map<string, string> {
  const lasting = new Map<string, string>();
  for (const event of state.events) {
    if (event.type === "match_state") {
      lasting.set(ROSTER_KEY, JSON.stringify([event.standings, event.spectators]));
    } else if (event.type === "weapon_state") {
      lasting.set(weaponKey(event.entityId), JSON.stringify(event));
    }
  }
  return lasting;
}

export class SnapshotBroadcaster {
  private readonly SNAPSHOT_HISTORY_SIZE = 64;
  private readonly FULL_SNAPSHOT_INTERVAL = 64;
  /**
   * Every 125th snapshot to a client (2 s at one snapshot per two ticks) carries all lasting state
   * again, whatever it acked. A safety net only: leaveOutKnown is correct without it. Separate from the entity full
   * snapshot above, which it does not change.
   */
  private readonly STATE_REFRESH_INTERVAL = TICK_RATE;

  private simulation: Simulation;
  private pvs: ServerPVS | null = null;
  /** BSP cluster of each entity this snapshot, looked up once rather than once per client. */
  private readonly clusterOf = new Map<string, number>();
  /** match_state without the roster, per snapshot's match_state event. */
  private readonly rosterOmitted = new WeakMap<SnapshotEvent, SnapshotEvent>();
  /** combat_state with the bars zeroed, for clients that may not read them. */
  private readonly healthHidden = new WeakMap<SnapshotEvent, SnapshotEvent>();

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
    agentDirectives?: ReadonlyMap<string, AgentDirective[]>,
  ): void {
    if (clients.size === 0) return;

    const tick = gameState.tick;

    let totalEncodeMs = 0;
    let totalCulled = 0;
    const lasting = lastingStateOf(gameState);
    const healthAudience = healthAudienceOf(gameState);
    this.clusterOf.clear();
    for (const client of clients.values()) {
      try {
        // PVS filtering: build per-client filtered state if PVS is available
        // CRITICAL: Always create a per-client copy for ackedInputSeq.
        // Without this, all clients share the same gameState reference and
        // get the LAST client's lastInputSeq — causing V2NetworkClient to
        // replay wrong inputs → position desync → collision world shift.
        const pvsActive = !!this.pvs?.enabled;
        const clientState = pvsActive ? this.filterStateForClient(gameState, client) : gameState.shallowCopy();

        // Ack the last command the SERVER actually SIMULATED for this client's
        // entity (one-command-per-tick model) — not the last one received — so
        // reconciliation replays exactly the un-simulated inputs. Falls back to
        // the received seq if the entity has no input yet.
        const simEntity = this.simulation.getState().getEntity(client.entityId);
        const processedSeq = (simEntity?.input as { lastProcessedSeq?: number } | undefined)?.lastProcessedSeq;
        clientState.ackedInputSeq = processedSeq ?? client.lastInputSeq;
        const ownKey = toClientKey(client.entityId);
        // Spectators see everyone's bars; a player sees their own and, in a
        // team mode, their team's (the ones they can watch once dead)
        const ownTeam = healthAudience.teamOf.get(ownKey);
        const seesAllHealth = client.isSpectator || ownTeam === undefined || ownTeam === "spectator";
        const seesHealthOf = (entityId: string) =>
          seesAllHealth ||
          entityId === ownKey ||
          (healthAudience.teamBased && healthAudience.teamOf.get(entityId) === ownTeam);
        // One pass builds this client's events: it was a copy, a filter and a
        // rebuild per client per snapshot, over a list a few events per player long
        clientState.events = this.leaveOutKnown(client, clientState.events, lasting, tick, seesHealthOf);

        // Agent directives are addressed to ONE client. Appending them here —
        // rather than broadcasting every player's orders in the shared snapshot
        // — keeps tactics private, which matters the moment a mode issues
        // anything a human opponent could exploit ("flank left", "he is low").
        // leaveOutKnown returned this client's own array, so it can take them.
        const clientDirectives = agentDirectives?.get(ownKey);
        if (clientDirectives && clientDirectives.length > 0) {
          clientState.events.push({
            type: "agent_directives",
            entityId: ownKey,
            directives: clientDirectives,
          });
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
        client.snapshotsSinceRefresh = this.isRefresh(client) ? 0 : (client.snapshotsSinceRefresh ?? 0) + 1;
      } catch (err) {
        // Usually a disconnected client — but a persistent encode/send fault
        // here must be visible, not silent (QA-16). Rate-limited: hot path.
        log.warnRateLimited("SnapshotBroadcaster", `snapshot send failed for ${client.id}:`, err);
      }
    }

    // Perf: log encoding cost periodically
    if (tick % 100 === 0 && clients.size > 0) {
      const pvsInfo = this.pvs?.enabled ? `, pvs_culled: ${totalCulled} entities across ${clients.size} clients` : "";
      debugLog(
        "perf",
        () =>
          `[Perf] snapshot encode: ${totalEncodeMs.toFixed(2)}ms total, ${(totalEncodeMs / clients.size).toFixed(2)}ms/client, clients: ${clients.size}${pvsInfo}`,
      );
    }
  }

  private isRefresh(client: ClientInfo): boolean {
    return (client.snapshotsSinceRefresh ?? this.STATE_REFRESH_INTERVAL) >= this.STATE_REFRESH_INTERVAL - 1;
  }

  /**
   * Leave out lasting state this client already holds: the scoreboard roster in match_state, and
   * other players' weapon_state. The client's own weapon_state always goes out; its HUD and
   * prediction reconcile against it every snapshot.
   *
   * A value goes out in every snapshot until the client acks one that carried it, then stays out
   * until it changes. The client stores these values before anything else in a snapshot runs
   * (client/SnapshotStateStore.ts), so an ack means it holds them. Each change restarts the count
   * from its own tick, so a value that changes and changes back is sent again. Unacked snapshots
   * (lost, late, rejected) never make a value count as delivered. Plan and reasoning:
   * docs/research/v0.9.25-network-improvements.md.
   *
   * Also drops what is not this client's: chat addressed to others and other players'
   * knockback_state. Returns a new array the caller owns.
   *
   * The shared events are never changed (the demo records them after the broadcast); a client
   * that is left without the roster gets a copied match_state saying so with `rosterOmitted`.
   */
  private leaveOutKnown(
    client: ClientInfo,
    events: GameState["events"],
    lasting: Map<string, string>,
    tick: number,
    seesHealthOf: (entityId: string) => boolean = () => true,
  ): GameState["events"] {
    client.sentState ??= new Map();
    const sent = client.sentState;
    for (const key of sent.keys()) if (!lasting.has(key)) sent.delete(key);
    const refresh = this.isRefresh(client);
    const needs = (key: string): boolean => {
      const value = lasting.get(key);
      if (value === undefined) return true;
      const kept = sent.get(key);
      if (!kept || kept.value !== value) {
        sent.set(key, { value, since: tick });
        return true;
      }
      return refresh || client.lastAckedTick < kept.since;
    };

    const own = toClientKey(client.entityId);
    const out: GameState["events"] = [];
    for (const event of events) {
      // Addressed chat goes to its recipients; knockback only to its owner
      if (!chatVisibleTo(event, own)) continue;
      if (event.type === "knockback_state" && event.entityId !== own) continue;
      if (event.type === "weapon_state" && event.entityId !== own && !needs(weaponKey(event.entityId))) {
        continue;
      }
      if (event.type === "combat_state" && !seesHealthOf(event.entityId)) {
        // Whether they are dead is public (the kill feed says so); the bars are not
        let hidden = this.healthHidden.get(event);
        if (!hidden) {
          hidden = { ...event, health: 0, armor: 0 };
          this.healthHidden.set(event, hidden);
        }
        out.push(hidden);
        continue;
      }
      if (event.type === "match_state" && !needs(ROSTER_KEY)) {
        // One copy per snapshot, shared by every client that has the roster, so
        // its JSON is built once (BinaryProtocol caches it per event object)
        let omitted = this.rosterOmitted.get(event);
        if (!omitted) {
          const { standings: _standings, spectators: _spectators, ...rest } = event;
          omitted = { ...rest, rosterOmitted: true };
          this.rosterOmitted.set(event, omitted);
        }
        out.push(omitted);
      } else {
        out.push(event);
      }
    }
    return out;
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
   * - Dropped weapons, so a missing one means it is gone, not out of view
   */
  private filterStateForClient(state: GameState, client: ClientInfo): GameState {
    if (!this.pvs) return state.shallowCopy();

    // Get client's player position from simulation
    const simState = this.simulation.getState();
    const clientEntity = simState.getEntity(client.entityId);
    if (!clientEntity?.transform) return state.shallowCopy();

    const viewerCluster = this.pvs.getCluster(clientEntity.transform.position);
    const own = toClientKey(client.entityId);

    // Build filtered state — shallow copy with filtered entities
    const filtered = new GameState();
    filtered.tick = state.tick;
    filtered.serverTimestamp = state.serverTimestamp;
    filtered.ackedInputSeq = state.ackedInputSeq;
    filtered.players = state.players;
    filtered.events = state.events; // shared; leaveOutKnown builds each client's own list
    filtered.pickupActiveMask = state.pickupActiveMask; // global, not PVS-filtered
    filtered.matchSnapshot = state.matchSnapshot;

    // A dead S&D player may chase teammates. Keep enemies PVS-filtered from the
    // corpse viewpoint, but always replicate living/dead teammates so cycling
    // the spectator camera cannot land on an entity missing from the snapshot.
    const ownPlayer = state.players.get(toClientKey(client.playerId));
    const teammateEntityIds = new Set<string>();
    if (clientEntity.health?.dead && isSide(ownPlayer?.team)) {
      for (const player of state.players.values()) {
        if (sameSide(player.team, ownPlayer.team)) teammateEntityIds.add(player.entityId);
      }
    }

    for (const [id, entity] of state.entities) {
      if (id === own) {
        filtered.entities.set(id, entity);
        continue;
      }

      if (teammateEntityIds.has(id)) {
        filtered.entities.set(id, entity);
        continue;
      }

      // Dropped weapons go to everyone. Filtered, a weapon out of view looked
      // picked up, and the client rebuilt it (new model, new toss) every time it
      // came back into view. They lie still, so delta compression makes them
      // nearly free; the client hides the ones it cannot see itself
      // (DroppedWeaponRenderer). Players and projectiles stay filtered.
      if (id.startsWith(DROPPED_WEAPON_PREFIX)) {
        filtered.entities.set(id, entity);
        continue;
      }

      const posComp = entity.getComponent("position") as { x: number; y: number; z: number } | undefined;
      if (!posComp) {
        filtered.entities.set(id, entity);
        continue;
      }

      let targetCluster = this.clusterOf.get(id);
      if (targetCluster === undefined) {
        targetCluster = this.pvs.getCluster(posComp);
        this.clusterOf.set(id, targetCluster);
      }
      if (this.pvs.isClusterVisibleFrom(viewerCluster, targetCluster)) {
        filtered.entities.set(id, entity);
      }
    }

    return filtered;
  }
}
