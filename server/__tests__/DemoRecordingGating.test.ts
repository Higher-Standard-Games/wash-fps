/**
 * Demo recording phase-gating regression.
 *
 * Recording must span ONLY the actual match (Active → PostGame), never warmup
 * or countdown, so demos aren't flooded with pre-match idling.
 *
 * Drives a real GameServer and forces match-phase transitions directly, then
 * asserts the recorder only runs during Active.
 */

import * as fs from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { MatchPhase } from "@shared/server/gametype";
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
    // Remove any demo this test may have written.
    const rec = (server as unknown as { demoRecorder: { stop: () => Promise<string> } | null }).demoRecorder;
    await server.stop();
    if (rec) {
      try {
        const fp = await rec.stop();
        if (fp) fs.rmSync(fp, { force: true });
      } catch {
        /* already stopped */
      }
    }
    server = null;
  }
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Demo recording is gated to the active match", () => {
  it("does not record during warmup, records during Active, stops at PostGame", async () => {
    server = new GameServer(config, new Deathmatch());
    await server.start();
    server.spawnBot(); // totalPlayers > 0 so warmup persists (no human to ready up)

    // biome-ignore lint/suspicious/noExplicitAny: reach into private match state
    const matchState = (server as any).gametypeController.matchState;
    const isRecording = () =>
      // biome-ignore lint/suspicious/noExplicitAny: private recorder handle
      !!(server as any).demoRecorder?.isRecording;

    // 1. Warmup — must NOT record.
    await wait(60);
    expect(matchState.phase).toBe(MatchPhase.Warmup);
    expect(isRecording()).toBe(false);

    // 2. Force the match Active — recording must start.
    matchState.transition(MatchPhase.Active);
    await wait(60);
    expect(isRecording()).toBe(true);

    // 3. Force PostGame — recording must stop.
    matchState.transition(MatchPhase.PostGame);
    await wait(60);
    expect(isRecording()).toBe(false);
  });
});
