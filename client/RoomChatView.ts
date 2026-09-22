/** A match room's member-only chat. The global lobby feed stays on the Play page. */
import { createRaisedKey } from "../../../engine/ui/components/RaisedKey";
import type { LobbyClient } from "../../../lobby/LobbyClient";
import type { ChatMessage, MatchLobbyInfo, RoomChatBroadcastMessage } from "../../../lobby/types";

const MAX_VISIBLE_MESSAGES = 50;

export class RoomChatView {
  readonly root: HTMLElement;
  private readonly lobbyId: string;
  private readonly client: LobbyClient;
  private readonly localPlayerId: string | null;
  private readonly supported: boolean;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly send: HTMLButtonElement;
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
    const context = document.createElement("span");
    context.className = "lobby-chat__online";
    context.textContent = "MEMBERS ONLY";
    head.append(title, context);

    this.log = document.createElement("div");
    this.log.className = "lobby-chat__log";
    this.log.setAttribute("role", "log");
    this.log.setAttribute("aria-live", "polite");

    const form = document.createElement("form");
    form.className = "lobby-chat__form";
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "lobby-chat__input";
    this.input.placeholder = "Message this room…";
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
    for (const message of lobby.chatHistory ?? []) this.appendMessage(message);
    if (this.log.childElementCount === 0) this.showEmpty();
    this.refreshConnection();

    this.unsubscribers.push(
      this.client.on("lobby:chat_message", (message: RoomChatBroadcastMessage) => {
        if (!this.supported || message.lobbyId !== this.lobbyId) return;
        this.log.querySelector(".lobby-chat__empty")?.remove();
        this.appendMessage(message);
      }),
      this.client.on("_disconnected", () => this.refreshConnection()),
      this.client.on("_connected", () => this.refreshConnection()),
    );
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.root.remove();
  }

  private refreshConnection(): void {
    const connected = this.client.connected && this.supported;
    this.input.disabled = !connected;
    this.send.disabled = !connected;
    this.input.placeholder = !this.supported
      ? "Room chat needs a newer lobby server"
      : connected
        ? "Message this room…"
        : "Lobby server offline";
  }

  private showEmpty(): void {
    const empty = document.createElement("p");
    empty.className = "lobby-chat__empty";
    empty.textContent = this.supported ? "No room messages yet." : "Room chat is unavailable on this lobby server.";
    this.log.appendChild(empty);
  }

  private appendMessage(message: ChatMessage): void {
    const following = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    const row = document.createElement("div");
    row.className = "lobby-chat__msg";
    if (message.fromId === this.localPlayerId) row.classList.add("lobby-chat__msg--me");

    const time = document.createElement("span");
    time.className = "lobby-chat__time";
    time.textContent = new Date(message.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const who = document.createElement("span");
    who.className = "lobby-chat__who";
    who.textContent = message.from;
    const text = document.createElement("span");
    text.className = "lobby-chat__text";
    text.textContent = message.text;
    row.append(time, who, text);
    this.log.appendChild(row);
    while (this.log.querySelectorAll(".lobby-chat__msg").length > MAX_VISIBLE_MESSAGES) {
      this.log.querySelector(".lobby-chat__msg")?.remove();
    }
    if (following) this.log.scrollTop = this.log.scrollHeight;
  }
}
