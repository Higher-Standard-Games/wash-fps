import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { BotLobbyClient } from "../BotLobbyClient";
import { modelDigest } from "../BotRatingIdentity";

const model = vi.hoisted(() => ({ release: undefined as (() => void) | undefined, disposed: 0 }));
vi.mock("../HybridBrain", () => ({
  HybridBrain: class {
    tacticalModel: object | null = null;
    combatModel: object | null = null;
    async loadModels() {
      await new Promise<void>((resolve) => {
        model.release = resolve;
      });
      this.tacticalModel = {};
      return true;
    }
    dispose() {
      model.disposed++;
    }
  },
}));

let server: WebSocketServer;
let bot: BotLobbyClient | undefined;
let dir: string | undefined;
afterEach(async () => {
  await bot?.disconnect();
  bot = undefined;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dir) {
    const target = path.resolve(dir);
    if (
      !target.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
      !path.basename(target).startsWith("shag-lobby-reference-")
    )
      throw new Error("Unsafe cleanup");
    fs.rmSync(target, { recursive: true, force: true });
    dir = undefined;
  }
});

async function lobby() {
  const messages: Array<Record<string, unknown>> = [];
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (message.type === "auth") socket.send(JSON.stringify({ type: "welcome", playerId: "bot" }));
      if (message.type === "lobby:join")
        socket.send(
          JSON.stringify({ type: "lobby:created", lobby: { id: "room", players: [{ id: "bot", team: "bravo" }] } }),
        );
    }),
  );
  return { messages, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}` };
}

describe("bot service to lobby metadata", () => {
  it("cancels a stalled model without authenticating and disposes its eventual load", async () => {
    const peer = await lobby();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shag-lobby-reference-"));
    model.release = undefined;
    model.disposed = 0;
    bot = new BotLobbyClient({ name: "Cancelled", modelDir: dir }, "secret");
    const controller = new AbortController();
    const connection = bot.connect(peer.url, "duel", "room", undefined, controller.signal);
    const rejected = expect(connection).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(model.release).toBeTypeOf("function"));
    controller.abort();
    await rejected;
    await bot.disconnect();
    expect(peer.messages).toEqual([]);
    model.release!();
    await vi.waitFor(() => expect(model.disposed).toBe(1));
    expect(peer.messages).toEqual([]);
  });
  it("authenticates a resolved preset and explicit arbiter and cleans up prepared clients", async () => {
    const peer = await lobby();
    bot = new BotLobbyClient({ name: "Reference", difficulty: "hard", goalArbiter: "legacy" }, "secret");
    await bot.connect(peer.url, "duel", "room");
    expect(peer.messages[0]).toMatchObject({
      type: "auth",
      isBot: true,
      botReference: { preset: "hard", goalArbiter: "legacy", model: { status: "none" } },
    });
    await bot.disconnect();
    expect(bot.state).toBe("disconnected");
  });

  it("waits for actual model loading before authenticating and sends content identity rather than a path", async () => {
    const peer = await lobby();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shag-lobby-reference-"));
    fs.mkdirSync(path.join(dir, "tactical"));
    fs.writeFileSync(path.join(dir, "tactical", "model.json"), "{}");
    model.release = undefined;
    model.disposed = 0;
    bot = new BotLobbyClient({ name: "Model", difficulty: "medium", modelDir: dir }, "secret");
    const connected = bot.connect(peer.url, "duel", "room");
    await vi.waitFor(() => expect(model.release).toBeTypeOf("function"));
    expect(peer.messages).toEqual([]);
    model.release!();
    await connected;
    expect(peer.messages[0]).toMatchObject({
      botReference: { model: { status: "loaded", digest: modelDigest(dir), tactical: true, combat: false } },
    });
    expect(JSON.stringify(peer.messages)).not.toContain(dir);
    await bot.disconnect();
    expect(model.disposed).toBe(1);
  });
});
