/**
 * Demo recording event-capture regression.
 *
 * Guards the bug where GameServer built the snapshot TWICE per snapshot tick —
 * once for broadcasting, once for recording. buildSnapshot() drains one-shot
 * events (weapon_fire, projectile_*, damage, death, …) as a side effect, so the
 * recorder's second build only ever saw persistent state and demos contained no
 * shooting/impact events.
 *
 * The fix builds the snapshot once and hands the SAME instance to both the
 * broadcaster and the recorder. This test asserts that shared-instance invariant
 * over the real scheduler, so a demo can be a faithful, fully replayable capture.
 */

import * as fs from "fs";
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

import { Deathmatch } from "../gametypes/Deathmatch";
import { GameServer, type GameServerConfig } from "../GameServer";

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

describe("Demo recording captures broadcast events", () => {
  it("records the SAME snapshot instance that is broadcast (built once, events intact)", async () => {
    server = new GameServer(config, new Deathmatch());
    await server.start();

    // biome-ignore lint/suspicious/noExplicitAny: reach into private collaborators for the assertion
    const broadcaster = (server as any).broadcaster;
    const broadcastSpy = vi.spyOn(broadcaster, "broadcast");

    // Recording is normally auto-started on match Active; start it directly here.
    server.startRecording();
    // biome-ignore lint/suspicious/noExplicitAny: private recorder handle
    const recorder = (server as any).demoRecorder;
    const recordSpy = vi.spyOn(recorder, "recordFrame");

    // Let the real scheduler run several snapshot ticks (60Hz → ~17ms each).
    await new Promise((r) => setTimeout(r, 90));

    expect(recordSpy).toHaveBeenCalled();
    expect(broadcastSpy).toHaveBeenCalled();

    // The recorder and broadcaster must receive the exact same GameState object,
    // built once per tick — otherwise the recorder's copy would be missing the
    // one-shot events the first build already drained.
    const recordCalls = recordSpy.mock.calls;
    const broadcastCalls = broadcastSpy.mock.calls;
    const recordedState = recordCalls[recordCalls.length - 1]?.[0] as { events?: unknown[] };
    const broadcastState = broadcastCalls[broadcastCalls.length - 1]?.[1];
    expect(recordedState).toBe(broadcastState);

    // And it is a real snapshot carrying events (match_state is emitted every tick).
    expect(Array.isArray(recordedState.events)).toBe(true);
    expect((recordedState.events as unknown[]).length).toBeGreaterThan(0);

    // Stop recording and remove the throwaway demo this test writes to disk.
    const filepath = await server.stopRecording();
    if (filepath) fs.rmSync(filepath, { force: true });
  });
});
