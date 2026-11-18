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
import { weaponStateSignature } from "../../../shared/net/BinaryProtocol";
import { type AgentDirective, isSide, sameSide } from "../../../shared/server/gametype";
import { toClientKey } from "../ClientEntityKey";
import { chatVisibleTo } from "./ChatRouting";
import type { ClientInfo } from "./Client";
import { debugLog } from "./DebugLog";

const ROSTER_KEY = "roster";
/**
 * Beyond this distance (map units) and out of the PVS, positional one-shot
 * events go only to the players they involve. Past every range bots hear at
 * (BotPerception HEARING_RANGE, 2500 at most); a Normal sound is at about 4%
 * volume there.
 */
export const HEARING_RADIUS = 3000;

type Vec3Like = { x: number; y: number; z: number };
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

/**
 * Whether a client may receive a positional one-shot event: gunfire, a hit or
 * a pickup it involves, or one where it could see or hear it. Everything else
 * passes unchanged.
 */
function perceivable(
  event: SnapshotEvent,
  own: string,
  perceives: (x: number, y: number, z: number) => boolean,
): boolean {
  switch (event.type) {
    case "weapon_fire":
      return event.entityId === own || perceives(event.originX, event.originY, event.originZ);
    case "damage":
      return event.entityId === own || event.attackerId === own || perceives(event.x, event.y, event.z);
    case "item_pickup":
      // The picker arrives as a bare entity id (BotPerception pickerKey)
      return toClientKey(String(event.entityId)) === own || perceives(event.x, event.y, event.z);
    default:
      return true;
  }
}

/** This snapshot's lasting state as strings, by key, made once and compared for every client. */
function lastingStateOf(state: GameState): Map<string, string> {
  const lasting = new Map<string, string>();
  for (const event of state.events) {
    if (event.type === "match_state") {
      lasting.set(ROSTER_KEY, JSON.stringify([event.standings, event.spectators]));
    } else if (event.type === "weapon_state") {
      lasting.set(weaponKey(event.entityId), weaponStateSignature(event));
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

  /** How often a held spectator's last snapshot is repeated (ms). */
  private static readonly HOLD_REPEAT_MS = 250;

  private simulation: Simulation;
  private pvs: ServerPVS | null = null;
  /** Ticks spectators are held behind the match; 0 = live. */
  private spectatorDelayTicks = 0;
  /** Built snapshots kept for the delayed spectator feed, oldest first. */
  private readonly frames: GameState[] = [];
  /** The delayed frame last picked, with its lasting state and health audience. */
  private delayedCache: {
    state: GameState;
    lasting: Map<string, string>;
    health: ReturnType<typeof healthAudienceOf>;
  } | null = null;
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
    if (this.spectatorDelayTicks > 0) this.keepFrame(gameState);

    const totals = { encodeMs: 0, culled: 0 };
    const live = { state: gameState, lasting: lastingStateOf(gameState), health: healthAudienceOf(gameState) };
    let delayed: typeof live | null | undefined;
    this.clusterOf.clear();
    for (const client of clients.values()) {
      if (this.spectatorDelayTicks > 0 && client.isSpectator) {
        // Spectators watch the match some seconds late, so a second connection
        // cannot call out where everyone is right now (ghosting). The frame is
        // picked once per broadcast and shared by every delayed spectator.
        if (delayed === undefined) delayed = this.delayedFrame(tick);
        if (!delayed) continue;
        if ((client.newestSentTick ?? -1) >= delayed.state.tick) {
          // Newer than the delayed feed already reached this client (it was
          // playing until now). Its view holds until the feed passes that
          // tick; repeating what it holds keeps its stall watchdog quiet.
          this.repeatHeld(client);
          continue;
        }
        if (client.sentSnapshots?.has(delayed.state.tick)) continue;
        this.sendTo(client, delayed.state, delayed.lasting, delayed.health, undefined, totals);
        continue;
      }
      this.sendTo(client, gameState, live.lasting, live.health, agentDirectives, totals);
    }

    // Perf: log encoding cost periodically
    if (tick % 100 === 0 && clients.size > 0) {
      const pvsInfo = this.pvs?.enabled ? `, pvs_culled: ${totals.culled} entities across ${clients.size} clients` : "";
      debugLog(
        "perf",
        () =>
          `[Perf] snapshot encode: ${totals.encodeMs.toFixed(2)}ms total, ${(totals.encodeMs / clients.size).toFixed(2)}ms/client, clients: ${clients.size}${pvsInfo}`,
      );
    }
  }

  /**
   * Hold spectators this many ticks behind the match (0 = live). Players are
   * never delayed; a spectator who takes a seat goes live from their next
   * snapshot, and a player who starts spectating holds until the delayed feed
   * passes what they last saw.
   */
  setSpectatorDelay(ticks: number): void {
    this.spectatorDelayTicks = Math.max(0, Math.floor(ticks));
    if (this.spectatorDelayTicks === 0) this.frames.length = 0;
  }

  /** Keep a built snapshot for the delayed spectator feed, once per tick. */
  private keepFrame(state: GameState): void {
    const newest = this.frames[this.frames.length - 1];
    if (newest && newest.tick >= state.tick) return;
    this.frames.push(state);
    // Keep one frame older than the delay, so there is always one to show
    const oldestNeeded = state.tick - this.spectatorDelayTicks;
    while (this.frames.length > 1 && this.frames[1].tick <= oldestNeeded) this.frames.shift();
  }

  /**
   * The newest kept frame at least the delay old. In a server's first seconds
   * there is none yet; the oldest frame is shown then, which is warmup.
   */
  private delayedFrame(
    tick: number,
  ): { state: GameState; lasting: Map<string, string>; health: ReturnType<typeof healthAudienceOf> } | null {
    const target = tick - this.spectatorDelayTicks;
    let frame: GameState | undefined;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].tick <= target) {
        frame = this.frames[i];
        break;
      }
    }
    if (!frame && target < 0) frame = this.frames[0];
    if (!frame) return null;
    if (this.delayedCache?.state !== frame) {
      this.delayedCache = { state: frame, lasting: lastingStateOf(frame), health: healthAudienceOf(frame) };
    }
    return this.delayedCache;
  }

  /** Re-send a held spectator's last snapshot, a few times a second. */
  private repeatHeld(client: ClientInfo): void {
    const bytes = client.lastSnapshotBytes;
    if (!bytes) return;
    const now = performance.now();
    if (now - (client.lastSnapshotSentMs ?? 0) < SnapshotBroadcaster.HOLD_REPEAT_MS) return;
    client.lastSnapshotSentMs = now;
    try {
      client.connection.sendDatagram(bytes);
    } catch (err) {
      log.warnRateLimited("SnapshotBroadcaster", `snapshot send failed for ${client.id}:`, err);
    }
  }

  /** Filter, encode and send one client's snapshot of `gameState`. */
  private sendTo(
    client: ClientInfo,
    gameState: GameState,
    lasting: Map<string, string>,
    healthAudience: ReturnType<typeof healthAudienceOf>,
    agentDirectives: ReadonlyMap<string, AgentDirective[]> | undefined,
    totals: { encodeMs: number; culled: number },
  ): void {
    const tick = gameState.tick;
    try {
      // PVS filtering: build per-client filtered state if PVS is available
      // CRITICAL: Always create a per-client copy for ackedInputSeq.
      // Without this, all clients share the same gameState reference and
      // get the LAST client's lastInputSeq — causing V2NetworkClient to
      // replay wrong inputs → position desync → collision world shift.
      const pvsActive = !!this.pvs?.enabled;
      const view = pvsActive ? this.viewpointsOf(gameState, client) : null;
      const clientState = pvsActive ? this.filterStateForClient(gameState, client, view) : gameState.shallowCopy();

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
      const perceives = view ? (x: number, y: number, z: number) => this.perceives(view, x, y, z) : undefined;
      clientState.events = this.leaveOutKnown(client, clientState.events, lasting, tick, seesHealthOf, perceives);

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
      totals.encodeMs += performance.now() - t0;

      if (pvsActive) {
        totals.culled += gameState.entities.size - clientState.entities.size;
      }

      client.connection.sendDatagram(snapshotBytes);
      if (this.spectatorDelayTicks > 0) {
        // What a spectator holds on to if it starts spectating after this
        client.newestSentTick = Math.max(client.newestSentTick ?? -1, tick);
        client.lastSnapshotBytes = snapshotBytes;
        client.lastSnapshotSentMs = performance.now();
      }
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
    perceives?: (x: number, y: number, z: number) => boolean,
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
      if (perceives && !perceivable(event, own, perceives)) continue;
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
  /**
   * Where a client sees and hears the match from: its own position and, for a
   * dead S&D player, every teammate's, since it watches through their eyes.
   * Null when it has no position in the world (a spectator) or there is no PVS.
   *
   * A dead S&D player watches teammates through their eyes. Teammates are
   * always replicated, so cycling the camera cannot land on an entity missing
   * from the snapshot; enemies are sent when the corpse or any teammate can
   * see them, which is what watching that teammate shows. From the corpse
   * alone, the teammate being watched shot at enemies the snapshot left out.
   */
  private viewpointsOf(
    state: GameState,
    client: ClientInfo,
  ): { own: string; clusters: number[]; positions: Vec3Like[]; teammateEntityIds: Set<string> } | null {
    if (!this.pvs) return null;
    const clientEntity = this.simulation.getState().getEntity(client.entityId);
    if (!clientEntity?.transform) return null;
    const own = toClientKey(client.entityId);
    const ownAt = clientEntity.transform.position;
    const clusters = [this.pvs.getCluster(ownAt)];
    const positions: Vec3Like[] = [ownAt];
    const ownPlayer = state.players.get(toClientKey(client.playerId));
    const teammateEntityIds = new Set<string>();
    if (clientEntity.health?.dead && isSide(ownPlayer?.team)) {
      for (const player of state.players.values()) {
        if (!sameSide(player.team, ownPlayer.team)) continue;
        teammateEntityIds.add(player.entityId);
        const at = state.entities.get(player.entityId)?.getComponent("position") as Vec3Like | undefined;
        if (!at || player.entityId === own) continue;
        const cluster = this.clusterOf.get(player.entityId) ?? this.pvs.getCluster(at);
        this.clusterOf.set(player.entityId, cluster);
        positions.push(at);
        if (!clusters.includes(cluster)) clusters.push(cluster);
      }
    }
    return { own, clusters, positions, teammateEntityIds };
  }

  /**
   * Whether a point is something this client could see or hear: in the PVS of
   * one of its viewpoints, or within HEARING_RADIUS of one. Gunfire, pain and
   * pickups farther than that carry nothing a player could perceive, and their
   * exact coordinates are all a radar needs.
   */
  private perceives(view: { clusters: number[]; positions: Vec3Like[] }, x: number, y: number, z: number): boolean {
    for (const at of view.positions) {
      const dx = at.x - x;
      const dy = at.y - y;
      const dz = at.z - z;
      if (dx * dx + dy * dy + dz * dz <= HEARING_RADIUS * HEARING_RADIUS) return true;
    }
    const pvs = this.pvs;
    if (!pvs) return true;
    const cluster = pvs.getCluster({ x, y, z });
    return view.clusters.some((viewer) => pvs.isClusterVisibleFrom(viewer, cluster));
  }

  private filterStateForClient(
    state: GameState,
    client: ClientInfo,
    view: ReturnType<SnapshotBroadcaster["viewpointsOf"]> = this.viewpointsOf(state, client),
  ): GameState {
    if (!this.pvs || !view) return state.shallowCopy();
    const { own, clusters: viewerClusters, teammateEntityIds } = view;

    // Build filtered state — shallow copy with filtered entities
    const filtered = new GameState();
    filtered.tick = state.tick;
    filtered.serverTimestamp = state.serverTimestamp;
    filtered.ackedInputSeq = state.ackedInputSeq;
    filtered.players = state.players;
    filtered.events = state.events; // shared; leaveOutKnown builds each client's own list
    filtered.pickupActiveMask = state.pickupActiveMask; // global, not PVS-filtered
    filtered.matchSnapshot = state.matchSnapshot;

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
      const cluster = targetCluster;
      if (viewerClusters.some((viewer) => this.pvs?.isClusterVisibleFrom(viewer, cluster))) {
        filtered.entities.set(id, entity);
      }
    }

    return filtered;
  }
}
