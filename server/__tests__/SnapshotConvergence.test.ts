/**
 * Every client ends up seeing what the server holds, however the link treats the snapshots.
 *
 * The real SnapshotBroadcaster sends to real SnapshotReceiver clients over a fake link that drops,
 * delays and reorders snapshots, and delays and reorders acks. While the link misbehaves, players
 * fire, switch weapons, score and die, and people join and leave the spectators. Then the world
 * goes quiet for a short stretch with the link still delaying (but no longer dropping), and every
 * client's view of each player's weapon_state and of the scoreboard roster must equal the
 * server's. The stretch is far shorter than any periodic refresh, so a client may only converge
 * through snapshots and acks, never by waiting for a full resend.
 *
 * This is the safety net for sending per-player and roster state only until a client has it
 * (docs/research/v0.9.25-network-improvements.md). It has to pass before and after that change.
 */

import { entityId, playerId } from "@engine/server/ecs/types";
import { describe, expect, it, vi } from "vitest";
import { SnapshotReceiver } from "../../../../engine/network/client/SnapshotReceiver";
import { BinaryProtocol } from "../../../../shared/net/BinaryProtocol";
import type { GameState } from "../../../../shared/net/GameState";
import { broadcastContext, seededRandom } from "../../bench/fixtures";
import { nextAckedTick } from "../AuthorityGuards";
import type { ClientInfo } from "../Client";
import { SnapshotBroadcaster } from "../SnapshotBroadcaster";
import { buildSnapshot } from "../SnapshotBuilder";

const PLAYERS = 8;

interface Roster {
  standings: unknown;
  spectators: unknown;
}

/** What one client knows: the last weapon_state per player and the roster, as the game keeps them. */
interface ClientView {
  weapons: Map<string, string>;
  roster: Roster;
}

/** The client side of the game's handling of these two events. */
function applyToView(view: ClientView, state: GameState): void {
  for (const event of state.events) {
    if (event.type === "weapon_state") {
      const { type: _type, ...rest } = event;
      view.weapons.set(String(event.entityId), JSON.stringify(rest));
    } else if (event.type === "match_state") {
      view.roster = { standings: event.standings ?? [], spectators: event.spectators ?? [] };
    }
  }
}

/** The same, from the shared snapshot the server built: the truth every client should reach. */
function truthOf(state: GameState): ClientView {
  const view: ClientView = { weapons: new Map(), roster: { standings: [], spectators: [] } };
  applyToView(view, state);
  return view;
}

interface InFlight<T> {
  at: number;
  seq: number;
  item: T;
}

/** A one-way link: each item may be dropped, and is delayed by a random number of ticks, so items overtake each other. */
class Link<T> {
  private items: InFlight<T>[] = [];
  private seq = 0;
  dropRate = 0;
  maxDelay = 0;
  constructor(private readonly random: () => number) {}
  send(item: T, now: number): void {
    if (this.random() < this.dropRate) return;
    const at = now + Math.floor(this.random() * (this.maxDelay + 1));
    this.items.push({ at, seq: this.seq++, item });
  }
  /** Everything due by `now`, in arrival order. */
  deliver(now: number): T[] {
    const due = this.items.filter((entry) => entry.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq);
    this.items = this.items.filter((entry) => entry.at > now);
    return due.map((entry) => entry.item);
  }
}

interface Endpoint {
  client: ClientInfo;
  receiver: SnapshotReceiver;
  down: Link<Uint8Array>;
  up: Link<number>;
  view: ClientView;
}

function world(seed: number) {
  const random = seededRandom(seed);
  const { ctx } = broadcastContext({ players: PLAYERS, projectiles: 4, droppedWeapons: 2, damageEvents: 0 });
  const broadcaster = new SnapshotBroadcaster(ctx.simulation);
  const clients = ctx.clients as Map<string, ClientInfo>;
  const endpoints: Endpoint[] = [];
  let now = 0;

  const attach = (client: ClientInfo) => {
    const endpoint: Endpoint = {
      client,
      receiver: new SnapshotReceiver(),
      down: new Link(random),
      up: new Link(random),
      view: { weapons: new Map(), roster: { standings: [], spectators: [] } },
    };
    (client as { connection: unknown }).connection = {
      latency: 0,
      sendDatagram: (bytes: Uint8Array) => endpoint.down.send(bytes, now),
    };
    endpoints.push(endpoint);
  };
  for (const client of clients.values()) attach(client);

  // A spectator in free fly: a seat on the server with no entity in the world.
  const spectator = {
    id: "client_spectator",
    playerId: playerId(90),
    entityId: entityId(900),
    playerName: "Watcher",
    resumeToken: "",
    lastInputSeq: 0,
    lastAckedTick: -1,
    ping: 40,
    isSpectator: true,
  } as unknown as ClientInfo;
  clients.set(spectator.id, spectator);
  attach(spectator);

  const setLink = (dropRate: number, maxDelay: number) => {
    for (const endpoint of endpoints) {
      endpoint.down.dropRate = dropRate;
      endpoint.down.maxDelay = maxDelay;
      endpoint.up.maxDelay = maxDelay; // acks ride a reliable channel: late, never lost
    }
  };

  /** Something happens in the match, as play would make it happen. */
  const play = () => {
    const roll = random();
    const who = 1 + Math.floor(random() * PLAYERS);
    const weapons = ctx.weaponSystem.getWeaponState(entityId(who));
    if (!weapons) return;
    if (roll < 0.5) {
      // A shot: ammo and the fire tick change.
      const ammo = weapons.ammo.get(weapons.currentWeapon);
      if (ammo) weapons.ammo.set(weapons.currentWeapon, { ...ammo, clip: Math.max(0, ammo.clip - 1) });
      weapons.lastFireTick = Number(ctx.simulation.currentTick);
    } else if (roll < 0.65) {
      weapons.currentWeapon = weapons.weapons[Math.floor(random() * weapons.weapons.length)];
    } else if (roll < 0.75) {
      weapons.reloading = !weapons.reloading;
    } else if (roll < 0.85) {
      const match = ctx.gametypeController.getMatchState();
      match.addScore(playerId(who));
      match.addDeath(playerId(1 + (who % PLAYERS)));
    } else if (roll < 0.9) {
      // Back to a value it had before: A, B, A.
      weapons.reloading = false;
    } else if (roll < 0.95) {
      spectator.isSpectator = true;
      spectator.playerName = `Watcher ${Math.floor(random() * 3)}`;
    }
  };

  let last: GameState | null = null;
  const step = (playing: boolean) => {
    now++;
    ctx.simulation.tick();
    if (playing) for (let i = 0; i < 3; i++) play();
    const state = buildSnapshot(ctx);
    last = state;
    broadcaster.broadcast(ctx.clients, state);
    for (const endpoint of endpoints) {
      for (const bytes of endpoint.down.deliver(now)) {
        const snapshot = endpoint.receiver.receive(bytes);
        if (!snapshot) continue;
        // The engine acks before the game runs the snapshot; both happen for every accepted one.
        endpoint.up.send(snapshot.tick, now);
        applyToView(endpoint.view, snapshot);
      }
      for (const tick of endpoint.up.deliver(now)) {
        endpoint.client.lastAckedTick = nextAckedTick(
          endpoint.client.lastAckedTick,
          tick,
          Number(ctx.simulation.currentTick),
        );
      }
    }
  };

  return {
    endpoints,
    setLink,
    step,
    truth: () => {
      if (!last) throw new Error("nothing sent yet");
      return truthOf(last);
    },
  };
}

describe("snapshot state reaches every client", () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`converges after a lossy, reordering stretch of play (seed ${seed})`, () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { endpoints, setLink, step, truth } = world(seed);

      for (let round = 0; round < 6; round++) {
        setLink(0.25, 6);
        for (let i = 0; i < 150; i++) step(true);
        // Quiet, lossless, still late and out of order: far less than any periodic refresh.
        setLink(0, 6);
        for (let i = 0; i < 30; i++) step(false);

        const expected = truth();
        expect(expected.weapons.size).toBe(PLAYERS);
        for (const endpoint of endpoints) {
          const who = `${endpoint.client.id}, round ${round}`;
          expect(Object.fromEntries(endpoint.view.weapons), who).toEqual(Object.fromEntries(expected.weapons));
          expect(endpoint.view.roster, who).toEqual(expected.roster);
        }
      }
      vi.restoreAllMocks();
    });
  }
});

describe("the snapshot the demo records", () => {
  it("is byte for byte what was built, after it has been sent to every client", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { ctx } = broadcastContext({ players: PLAYERS, projectiles: 4, droppedWeapons: 2, damageEvents: 3 });
    const broadcaster = new SnapshotBroadcaster(ctx.simulation);
    for (let tick = 0; tick < 70; tick++) {
      ctx.simulation.tick();
      const state = buildSnapshot(ctx);
      const before = BinaryProtocol.encodeSnapshot(state);
      const events = JSON.stringify(state.events);
      broadcaster.broadcast(ctx.clients, state);
      for (const client of ctx.clients.values()) client.lastAckedTick = state.tick;
      // DemoRecorder.recordFrame encodes this same object after the broadcast.
      expect(BinaryProtocol.encodeSnapshot(state)).toEqual(before);
      expect(JSON.stringify(state.events)).toBe(events);
    }
    vi.restoreAllMocks();
  });
});
