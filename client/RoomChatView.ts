/**
 * A match room's member-only chat, and who comes and goes. The global lobby
 * feed stays on the Play page.
 */
import { createRaisedKey } from "../../../engine/ui/components/RaisedKey";
import type { LobbyClient } from "../../../lobby/LobbyClient";
import type {
  ChatMessage,
  LobbyPlayerJoinedMessage,
  LobbyPlayerLeftMessage,
  MatchLobbyInfo,
  RoomChatBroadcastMessage,
} from "../../../lobby/types";
import { ChatScroll } from "./ChatScroll";

const MAX_VISIBLE_MESSAGES = 50;

/** A steady colour per name, so a player reads the same in every message. */
export function nameColor(name: string): string {
  const hues = [182, 322, 125, 276, 28, 200, 350, 104, 240, 160];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hues[hash % hues.length]} 92% 68%)`;
}

export class RoomChatView {
  readonly root: HTMLElement;
  private readonly lobbyId: string;
  private readonly client: LobbyClient;
  private readonly localPlayerId: string | null;
  private readonly supported: boolean;
  private readonly log: HTMLElement;
  private readonly scroll: ChatScroll;
  private readonly input: HTMLInputElement;
  private readonly send: HTMLButtonElement;
  private readonly here: HTMLElement;
  /** The room's members by id: a leave names only the id. */
  private readonly members = new Map<string, string>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(client: LobbyClient, lobby: MatchLobbyInfo, localPlayerId: string | null) {
    this.client = client;
    this.lobbyId = lobby.id;
    this.localPlayerId = localPlayerId;
    this.supported = Array.isArray(lobby.chatHistory);

    this.root = document.createElement("section");
    this.root.className = "lobby-chat lobby-chat--room";
    this.root.setAttribute("aria-label", "Room chat");

    const head = document.createElement("div");
    head.className = "lobby-chat__head";
    const title = document.createElement("span");
    title.className = "lobby-chat__title";
    title.textContent = "Room chat";
    this.here = document.createElement("span");
    this.here.className = "lobby-chat__online";
    this.here.title = "Only the people in this room see its chat";
    head.append(title, this.here);

    this.log = document.createElement("div");
    this.log.className = "lobby-chat__log";
    this.log.setAttribute("role", "log");
    this.log.setAttribute("aria-live", "polite");
    this.scroll = new ChatScroll(this.log);

    const form = document.createElement("form");
    form.className = "lobby-chat__form";
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "lobby-chat__input";
    this.input.placeholder = "Say something…";
    this.input.maxLength = 500;
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.setAttribute("aria-label", "Message this room");
    this.input.addEventListener("keydown", (event) => event.stopPropagation());
    this.send = createRaisedKey({ label: "Send", variants: ["sm", "inline", "send"] });
    this.send.type = "submit";
    form.append(this.input, this.send);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      if (!text || !this.client.connected) return;
      this.client.roomChatSend(this.lobbyId, text);
      this.input.value = "";
    });

    this.root.append(head, this.log, form);
    for (const player of lobby.players) this.members.set(player.id, player.name);
    this.refreshHere();
    for (const message of lobby.chatHistory ?? []) this.appendMessage(message);
    if (this.log.childElementCount === 0) this.showEmpty();
    this.scroll.toBottom();
    this.refreshConnection();

    this.unsubscribers.push(
      this.client.on("lobby:chat_message", (message: RoomChatBroadcastMessage) => {
        if (!this.supported || message.lobbyId !== this.lobbyId) return;
        this.log.querySelector(".lobby-chat__empty")?.remove();
        this.appendMessage(message);
      }),
      this.client.on("lobby:player_joined", (message: LobbyPlayerJoinedMessage) => {
        // A player the room already has is announced again on a reconnect
        if (this.members.has(message.player.id)) return;
        this.members.set(message.player.id, message.player.name);
        this.refreshHere();
        this.appendNote(`${message.player.name} joined`);
      }),
      this.client.on("lobby:player_left", (message: LobbyPlayerLeftMessage) => {
        const name = this.members.get(message.playerId);
        if (name === undefined) return;
        this.members.delete(message.playerId);
        this.refreshHere();
        // Someone coming back from a match leaves on the old connection and joins on
        // the new one: that is not news, so only a name that is really gone is said
        if (![...this.members.values()].includes(name)) this.appendNote(`${name} left`);
      }),
      this.client.on("_disconnected", () => this.refreshConnection()),
      this.client.on("_connected", () => this.refreshConnection()),
    );
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.scroll.destroy();
    this.root.remove();
  }

  private refreshConnection(): void {
    const connected = this.client.connected && this.supported;
    this.input.disabled = !connected;
    this.send.disabled = !connected;
    this.input.placeholder = !this.supported
      ? "Room chat needs a newer lobby server"
      : connected
        ? "Say something…"
        : "Lobby server offline";
  }

  private showEmpty(): void {
    const empty = document.createElement("p");
    empty.className = "lobby-chat__empty";
    empty.textContent = this.supported
      ? "No messages yet. Only the people in this room see them."
      : "Room chat is unavailable on this lobby server.";
    this.log.appendChild(empty);
  }

  private refreshHere(): void {
    this.here.textContent = `${this.members.size} here`;
  }

  /** A line of the room's own: someone came or went. */
  private appendNote(text: string): void {
    this.log.querySelector(".lobby-chat__empty")?.remove();
    const row = document.createElement("div");
    row.className = "lobby-chat__msg lobby-chat__msg--sys";
    const time = document.createElement("span");
    time.className = "lobby-chat__time";
    time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const line = document.createElement("span");
    line.className = "lobby-chat__text";
    line.textContent = text;
    row.append(time, line);
    this.log.appendChild(row);
    this.trim();
    this.scroll.follow();
  }

  private trim(): void {
    while (this.log.querySelectorAll(".lobby-chat__msg").length > MAX_VISIBLE_MESSAGES) {
      this.log.querySelector(".lobby-chat__msg")?.remove();
    }
  }

  private appendMessage(message: ChatMessage): void {
    const row = document.createElement("div");
    row.className = "lobby-chat__msg";
    if (message.fromId === this.localPlayerId) row.classList.add("lobby-chat__msg--me");

    const time = document.createElement("span");
    time.className = "lobby-chat__time";
    time.textContent = new Date(message.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const who = document.createElement("span");
    who.className = "lobby-chat__who";
    who.textContent = message.from;
    if (message.fromId !== this.localPlayerId) who.style.setProperty("--who", nameColor(message.from));
    const text = document.createElement("span");
    text.className = "lobby-chat__text";
    text.textContent = message.text;
    row.append(time, who, text);
    this.log.appendChild(row);
    this.trim();
    this.scroll.follow();
  }
}
