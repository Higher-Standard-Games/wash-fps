import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { BotLobbyClient } from "../BotLobbyClient";

let server: WebSocketServer;
let bot: BotLobbyClient | undefined;
afterEach(async () => {
  await bot?.disconnect();
  bot = undefined;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
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
  it("authenticates a resolved preset and explicit arbiter and disconnects cleanly", async () => {
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
});
