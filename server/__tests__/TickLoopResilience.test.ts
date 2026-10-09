/**
 * The tick loop must outlive anything thrown inside it.
 *
 * Each tick schedules the next one at the end of its own timer callback, so a
 * throw anywhere in that callback ends the server: no further tick is ever
 * scheduled, the simulation stops, and the sockets stay open — players hang in
 * a world frozen exactly where it stood, with nothing more written to the log.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@engine/server/network/transport/WebSocketTransport", () => import("./_fakeTransport"));

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
  vi.restoreAllMocks();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// biome-ignore lint/suspicious/noExplicitAny: reach into private server internals
const inner = (s: GameServer) => s as any;
const tickOf = (s: GameServer) => Number(inner(s).simulation.currentTick);

describe("GameServer tick loop", () => {
  it("keeps ticking, and says why, when something in the loop throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    server = new GameServer(config, new Deathmatch());
    await server.start();

    // A housekeeping step that fails on every pass, the worst case for the loop.
    vi.spyOn(inner(server), "logTickRateDiagnostic").mockImplementation(() => {
      throw new Error("boom");
    });

    // A loop that died still coasts through the ticks its last callback had
    // queued, so measure twice: it must still be advancing well after the throw.
    const before = tickOf(server);
    await wait(60);
    const mid = tickOf(server);
    await wait(60);

    expect(mid).toBeGreaterThan(before);
    expect(tickOf(server)).toBeGreaterThan(mid);
    expect(error).toHaveBeenCalledWith("[GameServer]", "Tick failed, the loop continues:", expect.any(Error));
  });

  it("does not spin when the tick itself throws every time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    server = new GameServer(config, new Deathmatch());
    await server.start();

    // A failed tick used to leave its deadline in the past, so the loop retried
    // it at once, back to back at setTimeout(0) speed: a core at 100% and, if
    // the failure came after the simulation stepped, a game running faster
    // than real time. It must keep to the tick rate instead.
    let calls = 0;
    vi.spyOn(inner(server), "tick").mockImplementation(() => {
      calls++;
      throw new Error("boom");
    });
    await wait(200);

    // 125 Hz for 200 ms is 25 ticks; allow for timer slack, not for a spin.
    expect(calls).toBeGreaterThan(5);
    expect(calls).toBeLessThan(60);
  });

  it("survives a playing client that has no connection", async () => {
    const running = new GameServer(config, new Deathmatch());
    server = running;
    await running.start();

    inner(running).clients.set("conn_1", {
      isSpectator: false,
      entityId: "player_1",
      playerId: 1,
      playerName: "Tester",
    });

    expect(() => inner(running).checkClientSilence()).not.toThrow();
  });
});
