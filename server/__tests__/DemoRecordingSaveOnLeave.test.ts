/**
 * Demo save-on-leave regression.
 *
 * A recording should be finalized as soon as the last playing client leaves —
 * so recording a demo is just "play a match, then leave", without waiting for
 * the frag/time limit to end the match.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
  // Defensive: remove any throwaway demo (won't exist — <10s is discarded).
  const dir = path.join(process.cwd(), "public", "data", "demos");
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith("test_deathmatch_")) fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {
    /* ignore */
  }
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Demo recording save-on-leave", () => {
  it("finalizes the recording when the last playing client disconnects", async () => {
    server = new GameServer(config, new Deathmatch());
    await server.start();

    // Inject a playing client and begin recording (as Active-phase auto-record would).
    const conn = { id: "conn_1" } as unknown as Parameters<
      // biome-ignore lint/suspicious/noExplicitAny: private method signature
      (GameServer & { handleDisconnect: any })["handleDisconnect"]
    >[0];
    // biome-ignore lint/suspicious/noExplicitAny: reach into private client map
    (server as any).clients.set("conn_1", {
      isSpectator: false,
      entityId: "player_1",
      playerId: 1,
      playerName: "Tester",
    });

    server.startRecording();
    // biome-ignore lint/suspicious/noExplicitAny: private recorder handle
    expect((server as any).demoRecorder?.isRecording).toBe(true);

    await wait(50); // record a few frames

    // Player leaves → recording should finalize (fire-and-forget async stop).
    // biome-ignore lint/suspicious/noExplicitAny: private method
    (server as any).handleDisconnect(conn, "left");

    // Wait for the async stopRecording to settle.
    for (let i = 0; i < 20; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: private recorder handle
      if (!(server as any).demoRecorder?.isRecording) break;
      await wait(10);
    }
    // biome-ignore lint/suspicious/noExplicitAny: private recorder handle
    expect((server as any).demoRecorder?.isRecording ?? false).toBe(false);
  });
});
