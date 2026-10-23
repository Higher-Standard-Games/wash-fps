/**
 * The bot server's control port: only callers that send the shared bot secret
 * get to use it, and it listens on this machine only.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { BOT_SECRET_HEADER } from "../../../../lobby/ServerData";
import { BotLobbyClient } from "../BotLobbyClient";
import { BotServer } from "../BotServer";

const SECRET = "test-bot-secret";
let server: BotServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
  vi.restoreAllMocks();
});

async function startServer(): Promise<BotServer> {
  server = new BotServer(0, { secret: SECRET });
  await server.start();
  return server;
}

/** Resolves with the close code, or with the first message the server sends. */
function exchange(port: number, headers: Record<string, string>): Promise<{ closed?: number; reply?: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.on("open", () => ws.send(JSON.stringify({ type: "status" })));
    ws.on("message", (data) => {
      resolve({ reply: JSON.parse(data.toString()) });
      ws.close();
    });
    ws.on("close", (code) => resolve({ closed: code }));
    ws.on("error", reject);
  });
}

describe("BotServer control port", () => {
  it("announces preparation and cancels it when its requesting control connection closes", async () => {
    let cancelled = false;
    vi.spyOn(BotLobbyClient.prototype, "connect").mockImplementation(async (_url, _mode, _room, _invite, signal) => {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => {
          cancelled = true;
          reject(new Error("cancelled"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    });
    const active = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${active.port}`, { headers: { [BOT_SECRET_HEADER]: SECRET } });
    const replies: Array<{ type: string }> = [];
    ws.on("message", (data) => replies.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.send(
      JSON.stringify({ type: "add_lobby_bot", lobbyUrl: "ws://127.0.0.1:9000", lobbyId: "room", gametype: "duel" }),
    );
    await vi.waitFor(() => expect(replies).toContainEqual({ type: "bot_preparing" }));
    ws.close();
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(active.getStatus()).toEqual([]);
  });
  it("refuses to start without the shared secret", async () => {
    await expect(new BotServer(0).start()).rejects.toThrow(/secret/);
  });

  it("closes a connection that doesn't send the secret", async () => {
    const { port } = await startServer();
    expect(await exchange(port, {})).toEqual({ closed: 1008 });
  });

  it("closes a connection that sends the wrong secret", async () => {
    const { port } = await startServer();
    expect(await exchange(port, { [BOT_SECRET_HEADER]: "guess" })).toEqual({ closed: 1008 });
  });

  it("answers a caller that sends the secret", async () => {
    const { port } = await startServer();
    expect(await exchange(port, { [BOT_SECRET_HEADER]: SECRET })).toEqual({ reply: { type: "status", bots: [] } });
  });
});
