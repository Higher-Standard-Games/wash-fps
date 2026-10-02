// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { MatchLobbyInfo } from "../../../../lobby/types";
import { RoomChatView } from "../RoomChatView";

class FakeClient {
  connected = true;
  roomChatSend = vi.fn();
  private handlers = new Map<string, Array<(message: never) => void>>();

  on(type: string, handler: (message: never) => void): () => void {
    const entries = this.handlers.get(type) ?? [];
    entries.push(handler);
    this.handlers.set(type, entries);
    return () =>
      this.handlers.set(
        type,
        entries.filter((entry) => entry !== handler),
      );
  }

  emit(type: string, message: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(message as never);
  }
}

const room: MatchLobbyInfo = {
  id: "room-a",
  gametype: "duel",
  maps: [],
  players: [],
  chatHistory: [{ from: "Alice", fromId: "a", text: "before join", ts: 1_700_000_000_000 }],
  shareUrl: "",
  config: { maxPlayers: 2, hasTeams: true },
};

describe("RoomChatView", () => {
  it("shows only this room's history and messages, and sends to the current room", () => {
    const client = new FakeClient();
    const view = new RoomChatView(client as never, room, "a");
    document.body.appendChild(view.root);
    expect(view.root.textContent).toContain("before join");
    expect(view.root.textContent).toContain("Room chat");

    client.emit("chat:message", { from: "Lobby", text: "global" });
    client.emit("lobby:chat_message", { lobbyId: "room-b", from: "Bob", fromId: "b", text: "other" });
    expect(view.root.textContent).not.toContain("global");
    expect(view.root.textContent).not.toContain("other");
    client.emit("lobby:chat_message", {
      lobbyId: "room-a",
      from: "Bob",
      fromId: "b",
      text: "in room",
      ts: 1_700_000_000_001,
    });
    expect(view.root.textContent).toContain("in room");

    const input = view.root.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("room chat input missing");
    input.value = "  hello  ";
    view.root.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(client.roomChatSend).toHaveBeenCalledWith("room-a", "hello");
    expect(input.value).toBe("");

    view.destroy();
    client.emit("lobby:chat_message", {
      lobbyId: "room-a",
      from: "Bob",
      fromId: "b",
      text: "after",
      ts: 1_700_000_000_002,
    });
    expect(view.root.textContent).not.toContain("after");
  });

  it("keeps server-provided names as text and disables sending offline", () => {
    const client = new FakeClient();
    const view = new RoomChatView(client as never, { ...room, chatHistory: [] }, "a");
    client.emit("lobby:chat_message", { lobbyId: "room-a", from: "<img src=x>", fromId: "b", text: "hi", ts: 1 });
    expect(view.root.querySelector("img")).toBeNull();
    expect(view.root.textContent).toContain("<img src=x>");
    client.connected = false;
    client.emit("_disconnected", {});
    expect(view.root.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    expect(view.root.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    view.destroy();
  });

  it("does not offer a broken send action with an older lobby server", () => {
    const client = new FakeClient();
    const view = new RoomChatView(client as never, { ...room, chatHistory: undefined }, "a");
    expect(view.root.textContent).toContain("unavailable");
    expect(view.root.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    expect(view.root.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    view.destroy();
  });

  it("says who joins and leaves, counts who is here, and stays quiet about a reconnect", () => {
    const client = new FakeClient();
    const withHost = { ...room, chatHistory: [], players: [{ id: "h", name: "Host", team: "alpha", ready: false }] };
    const view = new RoomChatView(client as never, withHost as MatchLobbyInfo, "h");
    const notes = () => [...view.root.querySelectorAll(".lobby-chat__msg--sys")].map((row) => row.textContent ?? "");
    const here = () => view.root.querySelector(".lobby-chat__online")?.textContent;
    expect(here()).toBe("1 here");

    client.emit("lobby:player_joined", { player: { id: "b", name: "Bot One", team: "bravo", ready: true } });
    client.emit("lobby:player_joined", { player: { id: "b", name: "Bot One", team: "bravo", ready: true } });
    expect(here()).toBe("2 here");
    expect(notes().filter((text) => text.includes("Bot One joined"))).toHaveLength(1);

    // The host comes back from a match on a new connection: a leave and a join under one name
    client.emit("lobby:player_joined", { player: { id: "h2", name: "Host", team: "alpha", ready: false } });
    client.emit("lobby:player_left", { playerId: "h" });
    expect(notes().some((text) => text.includes("Host left"))).toBe(false);

    client.emit("lobby:player_left", { playerId: "b" });
    expect(notes().some((text) => text.includes("Bot One left"))).toBe(true);
    expect(here()).toBe("1 here");
    view.destroy();
  });
});
