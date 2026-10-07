/**
 * What a healthy server prints on its own. Lines that repeat every few seconds or on every death
 * are behind SHAG_DEBUG topics; the tick rate still speaks up when the server falls behind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@engine/server/network/transport/WebSocketTransport", () => {
  class FakeTransport {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }
  return { WebSocketServerTransport: FakeTransport };
});

import { GameServer, type GameServerConfig, isBehind } from "../GameServer";
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

/** Five seconds of ticks at `hz`, with the slowest tick taking `maxTickMs`, ready to report. */
function sampled(hz: number, maxTickMs: number): Inner {
  const inner: Inner = new GameServer(config, new Deathmatch());
  inner.diagLastLog = performance.now() - 5000;
  inner.diagTickCount = Math.round(hz * 5);
  inner.diagMaxTickMs = maxTickMs;
  // A playing client with input on record, the case that used to print a [Telemetry] line.
  inner.clients.set("c1", { playerId: 7, entityId: 8, isSpectator: false });
  inner.telemetry.get = () => ({
    inputs: 600,
    inputLoss: 0,
    jitterMs: 1,
    viewSpeedDps: 0,
    peakViewSpeedDps: 0,
    flickHistogram: [0],
    rejectedCmds: 0,
    clampedCmds: 0,
  });
  return inner;
}

describe("server console", () => {
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("says nothing every 5 s while the tick rate is on target", () => {
    const inner = sampled(125, 2);
    log.mockClear();
    warn.mockClear(); // construction can warn about the test's missing map
    inner.logTickRateDiagnostic();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once when the server falls behind, without the per-client telemetry", () => {
    const inner = sampled(100, 2);
    log.mockClear();
    warn.mockClear(); // construction can warn about the test's missing map
    inner.logTickRateDiagnostic();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/tickrate: 100\.0Hz .*\(behind\)$/);
    expect(log).not.toHaveBeenCalled();
  });

  it("says nothing on a kill", () => {
    const dm = new Deathmatch();
    dm.onDeath({ ownerId: 1 } as never, { ownerId: 2 } as never, {} as never);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("falling behind", () => {
  it("is under 95% of the target rate", () => {
    expect(isBehind(125, 125, 1)).toBe(false);
    expect(isBehind(119, 125, 1)).toBe(false);
    expect(isBehind(118, 125, 1)).toBe(true);
  });

  it("is a tick whose work took longer than two ticks, not one GC pause over budget", () => {
    expect(isBehind(125, 125, 12)).toBe(false);
    expect(isBehind(125, 125, 17)).toBe(true);
  });
});
