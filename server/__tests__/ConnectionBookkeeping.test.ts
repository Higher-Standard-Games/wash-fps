/**
 * Per-connection bookkeeping that must not grow or be abused (QA B9):
 * clock-sync pings are answered at a bounded rate, and the lag compensation
 * latency map and the anti-warp record are released when a player leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@engine/server/network/transport/WebSocketTransport", () => {
  class FakeTransport {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    broadcastDatagram(): void {}
    broadcastReliable(): void {}
    sendDatagram(): void {}
    sendReliable(): void {}
    disconnect(): void {}
  }
  return { WebSocketServerTransport: FakeTransport };
});

import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { GameServer, type GameServerConfig } from "../GameServer";
import { Deathmatch } from "../gametypes/Deathmatch";

const config: GameServerConfig = {
  port: 0,
  serverName: "test",
  mapName: "test",
  maxClients: 8,
  tickRate: 125,
  snapshotRate: 60,
  certPath: "",
  keyPath: "",
};

// biome-ignore lint/suspicious/noExplicitAny: reach into private server internals
type Inner = any;

function setup(isSpectator = false) {
  const inner: Inner = new GameServer(config, new Deathmatch());
  const sent: Uint8Array[] = [];
  const connection = { id: "conn_1", latency: 40, close: () => {}, sendDatagram: (d: Uint8Array) => sent.push(d) };
  const client = {
    id: "conn_1",
    connection,
    playerId: 7,
    entityId: 70,
    playerName: "Human",
    isSpectator,
    isBot: false,
    lastInputSeq: 0,
    lastAckedTick: 0,
    ping: 0,
    resumeToken: "",
  };
  inner.clients.set("conn_1", client);
  return { inner, client, connection, sent };
}

describe("connection bookkeeping", () => {
  let now = 1000;
  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers a flood of pings at a bounded rate, and a sync burst in full", () => {
    const { inner, connection, sent } = setup();
    const ping = () => inner.handleDatagram(connection, MessageCodec.encodePing(Date.now()));

    for (let i = 0; i < 100; i++) ping();
    expect(sent).toHaveLength(1);

    // The client's own burst: one every 100 ms, all answered.
    sent.length = 0;
    for (let i = 0; i < 5; i++) {
      now += 100;
      ping();
    }
    expect(sent).toHaveLength(5);
  });

  it("forgets a player's latency when they leave, not when they spectate", () => {
    const { inner, client, connection } = setup();
    const lag = inner.lagCompensation;
    lag.updateClientLatency(client.playerId, 80);
    inner.movementValidator.addClient(client.playerId);

    inner.handleDisconnect(connection, "left", false);
    expect(lag.clientLatencies.has(client.playerId)).toBe(false);
    expect(inner.movementValidator.parked.has(client.playerId)).toBe(false);
  });

  it("forgets a spectator's latency when they leave", () => {
    const { inner, client, connection } = setup(true);
    inner.lagCompensation.updateClientLatency(client.playerId, 80);
    inner.handleDisconnect(connection, "left", false);
    expect(inner.lagCompensation.clientLatencies.has(client.playerId)).toBe(false);
  });
});
