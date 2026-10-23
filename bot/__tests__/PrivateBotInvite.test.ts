import { once } from "node:events";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { GameServerSpawner } from "../../../../lobby/GameServerSpawner";
import { LobbyServer } from "../../../../lobby/LobbyServer";
import { BOT_SECRET_HEADER } from "../../../../lobby/ServerData";
import type { MatchLobbyInfo } from "../../../../lobby/types";
import { BotServer } from "../BotServer";

async function unusedPort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

describe("private room bot invite", () => {
  it("passes the room token to the bot and reports a refused join instead of acknowledging it", async () => {
    const secret = "private-bot-integration-secret";
    const botServer = new BotServer(0, { secret });
    await botServer.start();
    const lobbyPort = await unusedPort();
    const lobby = new LobbyServer(lobbyPort, new GameServerSpawner(), {
      botSecret: secret,
      botServerUrl: `ws://127.0.0.1:${botServer.port}`,
    });
    const messages: Array<Record<string, unknown>> = [];
    let host: WebSocket | undefined;
    let control: WebSocket | undefined;
    try {
      await lobby.start();
      host = new WebSocket(`ws://127.0.0.1:${lobbyPort}`);
      host.on("message", (data) => messages.push(JSON.parse(data.toString())));
      await once(host, "open");
      const waitFor = (type: string) =>
        vi.waitFor(() => {
          const message = messages.find((candidate) => candidate.type === type);
          if (!message) throw new Error(`Waiting for ${type}`);
          return message;
        });

      host.send(JSON.stringify({ type: "auth" }));
      await waitFor("welcome");
      host.send(JSON.stringify({ type: "lobby:create", gametype: "duel", visibility: "private" }));
      const room = (await waitFor("lobby:created")).lobby as MatchLobbyInfo;
      const inviteToken = new URL(room.shareUrl, "https://example.invalid").searchParams.get("invite");
      expect(inviteToken).toMatch(/^[A-Za-z0-9_-]{32}$/);

      control = new WebSocket(`ws://127.0.0.1:${botServer.port}`, {
        headers: { [BOT_SECRET_HEADER]: secret },
      });
      const controlReplies: Array<Record<string, unknown>> = [];
      control.on("message", (data) => controlReplies.push(JSON.parse(data.toString())));
      await once(control, "open");
      control.send(
        JSON.stringify({
          type: "add_lobby_bot",
          lobbyUrl: `ws://127.0.0.1:${lobbyPort}`,
          lobbyId: room.id,
          gametype: "duel",
          inviteToken: "wrong",
        }),
      );
      await vi.waitFor(() =>
        expect(controlReplies.at(-1)).toMatchObject({
          type: "error",
          error: "Failed to add lobby bot: That room is gone, or the invite link is wrong.",
        }),
      );
      expect(messages.some((message) => message.type === "lobby:player_joined")).toBe(false);

      host.send(JSON.stringify({ type: "lobby:invite_bot", lobbyId: room.id }));
      const joined = await waitFor("lobby:player_joined");
      // An invite that names no level fields the one nearest the inviter: with
      // no results kept here, Medium. The room shows the bot's level on its seat.
      expect(joined.player).toMatchObject({ id: expect.any(String), name: expect.any(String), botLevel: "hard" });
      expect(await waitFor("lobby:bot_invited")).toMatchObject({ lobbyId: room.id, difficulty: "hard" });
      expect(botServer.getStatus()).toHaveLength(1);
    } finally {
      control?.close();
      host?.close();
      await botServer.removeAllBots();
      await botServer.stop();
      await lobby.stop();
    }
  }, 20_000);

  it("makes a public room private when a bot is added", async () => {
    const secret = "public-bot-integration-secret";
    const botServer = new BotServer(0, { secret });
    await botServer.start();
    const lobbyPort = await unusedPort();
    const lobby = new LobbyServer(lobbyPort, new GameServerSpawner(), {
      botSecret: secret,
      botServerUrl: `ws://127.0.0.1:${botServer.port}`,
    });
    const messages: Array<Record<string, unknown>> = [];
    let host: WebSocket | undefined;
    try {
      await lobby.start();
      host = new WebSocket(`ws://127.0.0.1:${lobbyPort}`);
      host.on("message", (data) => messages.push(JSON.parse(data.toString())));
      await once(host, "open");
      const waitFor = (type: string) =>
        vi.waitFor(() => {
          const message = messages.find((candidate) => candidate.type === type);
          if (!message) throw new Error(`Waiting for ${type}`);
          return message;
        });

      host.send(JSON.stringify({ type: "auth" }));
      await waitFor("welcome");
      host.send(JSON.stringify({ type: "lobby:create", gametype: "duel", visibility: "public" }));
      const room = (await waitFor("lobby:created")).lobby as MatchLobbyInfo;

      expect(room.visibility).toBe("public");
      host.send(JSON.stringify({ type: "lobby:invite_bot", lobbyId: room.id }));
      const madePrivate = await waitFor("lobby:made_private");
      const inviteToken = new URL(madePrivate.shareUrl as string, "https://example.invalid").searchParams.get("invite");
      expect(madePrivate.lobbyId).toBe(room.id);
      expect(inviteToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
      // The bot joins with the new invite, and the room leaves the public list
      expect((await waitFor("lobby:player_joined")).player).toMatchObject({ botLevel: "hard" });
      expect(await waitFor("lobby:bot_invited")).toMatchObject({ lobbyId: room.id });
      expect(botServer.getStatus()).toHaveLength(1);
      await vi.waitFor(() => {
        const updates = messages.filter((message) => message.type === "matches:update");
        const latest = updates.at(-1)?.matches as Array<{ id: string }> | undefined;
        expect(latest?.some((match) => match.id === room.id)).toBe(false);
      });

      // Joining by the old public link no longer works; the invite does
      const stranger = new WebSocket(`ws://127.0.0.1:${lobbyPort}`);
      const strangerMessages: Array<Record<string, unknown>> = [];
      stranger.on("message", (data) => strangerMessages.push(JSON.parse(data.toString())));
      await once(stranger, "open");
      try {
        stranger.send(JSON.stringify({ type: "auth" }));
        await vi.waitFor(() => expect(strangerMessages.some((m) => m.type === "welcome")).toBe(true));
        stranger.send(JSON.stringify({ type: "lobby:join", lobbyId: room.id }));
        await vi.waitFor(() =>
          expect(strangerMessages.find((m) => m.type === "lobby:error")).toMatchObject({
            error: "That room is gone, or the invite link is wrong.",
          }),
        );
      } finally {
        stranger.close();
      }
    } finally {
      host?.close();
      await botServer.removeAllBots();
      await botServer.stop();
      await lobby.stop();
    }
  }, 20_000);
});
