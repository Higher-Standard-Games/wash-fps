/**
 * Auto-shutdown of a lobby-spawned server once no human is left.
 *
 * Driven through the private disconnect handler with fake timers, since the
 * behaviour is all in when the countdown starts, restarts and fires.
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
  shutdownOnEmpty: true,
};

// biome-ignore lint/suspicious/noExplicitAny: reach into private server internals
type Inner = any;

function server(): { inner: Inner; stop: ReturnType<typeof vi.fn> } {
  const inner: Inner = new GameServer(config, new Deathmatch());
  const stop = vi.fn(async () => {});
  inner.stop = stop;
  inner.hasHadClients = true;
  return { inner, stop };
}

let nextId = 1;
function connect(inner: Inner, isBot: boolean) {
  const id = `conn_${nextId++}`;
  const client = {
    id,
    connection: { id, close: () => {} },
    playerId: 100 + nextId,
    entityId: 200 + nextId,
    playerName: isBot ? "Bot" : "Human",
    isSpectator: true,
    isBot,
    lastInputSeq: 0,
    lastAckedTick: 0,
    ping: 0,
    resumeToken: "",
  };
  inner.clients.set(id, client);
  return client;
}

describe("auto-shutdown when no human is left", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs one countdown however many bots leave", async () => {
    const { inner, stop } = server();
    const bots = [connect(inner, true), connect(inner, true), connect(inner, true)];
    for (const bot of bots) {
      inner.handleDisconnect(bot.connection, "post-game");
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("is cancelled by a human connecting, even after several bots left", async () => {
    const { inner, stop } = server();
    const bots = [connect(inner, true), connect(inner, true)];
    for (const bot of bots) inner.handleDisconnect(bot.connection, "post-game");
    inner.handleConnect({ id: "conn_human", address: "127.0.0.1" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps the server for a human whose seat is held when the countdown ends", async () => {
    const { inner, stop } = server();
    const bot = connect(inner, true);
    inner.handleDisconnect(bot.connection, "post-game");
    // A human drops mid-match after the countdown started: their seat is held.
    const human = connect(inner, false);
    inner.clients.delete(human.id); // gone from the live connections, held in suspension
    inner.suspended.suspend({ ...human, isSpectator: false }, Date.now());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stop).not.toHaveBeenCalled();
  });
});
