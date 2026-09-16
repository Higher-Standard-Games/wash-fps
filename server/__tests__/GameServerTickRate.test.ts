/**
 * GameServer wall-clock tick-rate regression.
 *
 * Guards against the scheduler bug where scheduleNextTick measured `elapsed` as
 * the tick's work time (not the inter-tick interval) and scheduled ~2×tickMs
 * apart — running a 125Hz server at ~62.5Hz, i.e. half real-time (a "1s" game
 * timer took ~2 real seconds).
 *
 * Runs the REAL GameServer scheduler over real wall-clock time with a no-op
 * transport (no port binding) and asserts the simulation advances at close to
 * the configured rate, not half.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the WebSocket transport so the server starts without binding a port.
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
};

let server: GameServer | null = null;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

describe("GameServer tick rate (wall clock)", () => {
  it("advances the simulation at ~125Hz over real time (not ~62.5Hz)", async () => {
    server = new GameServer(config, new Deathmatch());
    await server.start();

    // biome-ignore lint/suspicious/noExplicitAny: read the private simulation tick for the assertion
    const tickOf = () => (server as any).simulation.currentTick as number;
    const RUN_MS = 480;
    const startTick = tickOf();
    await new Promise((r) => setTimeout(r, RUN_MS));
    const endTick = tickOf();

    const ticks = endTick - startTick;
    const hz = (ticks * 1000) / RUN_MS;

    // At 125Hz we expect ~60 ticks in 480ms. The old bug produced ~30 (62.5Hz).
    // Generous bounds tolerate timer jitter / slow CI while still failing the
    // half-rate regression.
    expect(hz).toBeGreaterThan(95); // would be ~62 under the bug
    expect(hz).toBeLessThan(160);
  });
});
