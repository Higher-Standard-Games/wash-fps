import type { Simulation } from "@engine/server/core/Simulation";
import { describe, expect, it } from "vitest";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { GameState, PlayerState } from "../../../../shared/net/GameState";
import { toClientKey } from "../../ClientEntityKey";
import type { ClientInfo } from "../Client";
import { SnapshotBroadcaster } from "../SnapshotBroadcaster";

// Clients 1 and 2 are udon, 3 is soba, 4 is a spectator with no entity in play.
function receivedBars(teamBased: boolean): Map<string, Record<string, [number, number]>> {
  const packets = new Map<string, Uint8Array[]>();
  const simulation = {
    getState: () => ({ getEntity: () => ({ input: { lastProcessedSeq: 0 } }) }),
  } as unknown as Simulation;
  const broadcaster = new SnapshotBroadcaster(simulation);
  const client = (n: number, isSpectator = false): [string, ClientInfo] => {
    packets.set(`c${n}`, []);
    const info = {
      id: `c${n}`,
      playerId: n,
      entityId: n,
      isSpectator,
      lastInputSeq: 0,
      lastAckedTick: 0,
      connection: { sendDatagram: (bytes: Uint8Array) => packets.get(`c${n}`)?.push(bytes) },
    } as unknown as ClientInfo;
    return [`c${n}`, info];
  };
  const clients = new Map([client(1), client(2), client(3), client(4, true)]);

  const state = new GameState();
  state.tick = 1;
  for (const [n, team] of [
    [1, "udon"],
    [2, "udon"],
    [3, "soba"],
  ] as const) {
    const player = new PlayerState();
    player.entityId = toClientKey(n);
    player.team = team;
    state.players.set(toClientKey(n), player);
  }
  state.events = [
    { type: "match_state", teamBased, standings: [], spectators: [] },
    ...[1, 2, 3].map((n) => ({
      type: "combat_state",
      entityId: toClientKey(n),
      health: 50 + n,
      armor: n,
      dead: false,
    })),
  ] as unknown as GameState["events"];
  broadcaster.broadcast(clients, state);

  const out = new Map<string, Record<string, [number, number]>>();
  for (const [id, sent] of packets) {
    const bars: Record<string, [number, number]> = {};
    for (const event of MessageCodec.decodeSnapshot(sent[0]).events) {
      if (event.type === "combat_state") bars[event.entityId] = [event.health, event.armor];
    }
    out.set(id, bars);
  }
  return out;
}

describe("health and armor reach only those who may watch them", () => {
  const [one, two, three] = [1, 2, 3].map((n) => toClientKey(n));

  it("in a team mode: your own, your team's and, for spectators, everyone's", () => {
    const got = receivedBars(true);
    expect(got.get("c1")).toEqual({ [one]: [51, 1], [two]: [52, 2], [three]: [0, 0] });
    expect(got.get("c3")).toEqual({ [one]: [0, 0], [two]: [0, 0], [three]: [53, 3] });
    expect(got.get("c4")).toEqual({ [one]: [51, 1], [two]: [52, 2], [three]: [53, 3] });
  });

  it("in free for all: only your own, as the internal sides are not teams", () => {
    const got = receivedBars(false);
    expect(got.get("c1")).toEqual({ [one]: [51, 1], [two]: [0, 0], [three]: [0, 0] });
    expect(got.get("c4")).toEqual({ [one]: [51, 1], [two]: [52, 2], [three]: [53, 3] });
  });
});
