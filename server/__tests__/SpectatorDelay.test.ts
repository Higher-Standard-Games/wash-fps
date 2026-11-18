import type { Simulation } from "@engine/server/core/Simulation";
import { describe, expect, it } from "vitest";
import { GameState } from "../../../../shared/net/GameState";
import type { ClientInfo } from "../Client";
import { SnapshotBroadcaster } from "../SnapshotBroadcaster";

const simulation = { getState: () => ({ getEntity: () => undefined }) } as unknown as Simulation;

function stateAt(tick: number): GameState {
  const state = new GameState();
  state.tick = tick;
  return state;
}

function client(id: string, isSpectator: boolean): ClientInfo & { sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  return {
    id,
    playerId: 1,
    entityId: 10,
    isSpectator,
    lastAckedTick: 0,
    lastInputSeq: 0,
    sent,
    connection: { sendDatagram: (bytes: Uint8Array) => sent.push(bytes) },
  } as unknown as ClientInfo & { sent: Uint8Array[] };
}

function ticksSent(info: ClientInfo): number[] {
  return [...(info.sentSnapshots?.keys() ?? [])];
}

describe("SnapshotBroadcaster spectator delay", () => {
  it("sends players the live tick and spectators the tick the delay behind", () => {
    const broadcaster = new SnapshotBroadcaster(simulation);
    broadcaster.setSpectatorDelay(100);
    const player = client("p", false);
    const spectator = client("s", true);
    const clients = new Map<string, ClientInfo>([
      ["p", player],
      ["s", spectator],
    ]);
    for (let tick = 200; tick <= 400; tick += 2) broadcaster.broadcast(clients, stateAt(tick));

    expect(ticksSent(player).at(-1)).toBe(400);
    expect(ticksSent(spectator).at(-1)).toBe(300);
    expect(Math.min(...ticksSent(spectator))).toBeGreaterThanOrEqual(200);
  });

  it("is live for everyone without a delay", () => {
    const broadcaster = new SnapshotBroadcaster(simulation);
    const spectator = client("s", true);
    const clients = new Map<string, ClientInfo>([["s", spectator]]);
    for (let tick = 200; tick <= 400; tick += 2) broadcaster.broadcast(clients, stateAt(tick));
    expect(ticksSent(spectator).at(-1)).toBe(400);
  });

  it("shows the oldest frame in a server's first seconds", () => {
    const broadcaster = new SnapshotBroadcaster(simulation);
    broadcaster.setSpectatorDelay(100);
    const spectator = client("s", true);
    const clients = new Map<string, ClientInfo>([["s", spectator]]);
    broadcaster.broadcast(clients, stateAt(2));
    broadcaster.broadcast(clients, stateAt(4));
    expect(ticksSent(spectator)).toEqual([2]);
  });

  it("holds a player who starts spectating until the delayed feed passes what they saw", () => {
    const broadcaster = new SnapshotBroadcaster(simulation);
    broadcaster.setSpectatorDelay(100);
    const info = client("p", false);
    const clients = new Map<string, ClientInfo>([["p", info]]);
    for (let tick = 200; tick <= 400; tick += 2) broadcaster.broadcast(clients, stateAt(tick));
    expect(ticksSent(info).at(-1)).toBe(400);

    info.isSpectator = true;
    const sentBefore = info.sent.length;
    // Within the hold, nothing older than tick 400 goes out
    for (let tick = 402; tick <= 500; tick += 2) broadcaster.broadcast(clients, stateAt(tick));
    expect(ticksSent(info).at(-1)).toBe(400);
    // Repeats keep the link alive, throttled rather than every snapshot
    expect(info.sent.length - sentBefore).toBeLessThan(5);

    broadcaster.broadcast(clients, stateAt(502));
    expect(ticksSent(info).at(-1)).toBe(402);
  });

  it("takes a spectator live as soon as they play", () => {
    const broadcaster = new SnapshotBroadcaster(simulation);
    broadcaster.setSpectatorDelay(100);
    const info = client("s", true);
    const clients = new Map<string, ClientInfo>([["s", info]]);
    for (let tick = 200; tick <= 400; tick += 2) broadcaster.broadcast(clients, stateAt(tick));
    info.isSpectator = false;
    broadcaster.broadcast(clients, stateAt(402));
    expect(ticksSent(info).at(-1)).toBe(402);
  });
});
