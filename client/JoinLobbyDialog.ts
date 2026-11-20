/**
 * JoinLobbyDialog — one field that takes a room link or a room code, and
 * joins that room. A room in another region needs that region's lobby, where
 * the player has a separate account, so the dialog says so before switching.
 */

import { InputSystem } from "../../../engine/input/InputSystem";
import { raiseKey, setRaisedKeyText } from "../../../engine/ui/components/RaisedKey";
import { UINavigation } from "../../../engine/ui/navigation/UINavigation";
import { UIStyles } from "../../../engine/ui/UIStyles";
import type { LobbyClient } from "../../../lobby/LobbyClient";
import { HOSTED_ON } from "./hosted/HostedBuild";
import { setTabRegion } from "./hosted/Regions";
import { type CodeTarget, inThisRegion, parseRoomCode, type RoomRef } from "./LobbyCode";
import { button, el } from "./settings/SettingsFields";
import joinCSS from "./styles/JoinLobbyDialog.css?raw";
import welcomeCSS from "./styles/LobbyWelcomeDialog.css?raw";

const INPUT_CONTEXT = "fps_join_lobby";

/**
 * Open a room in another region: a hosted build reloads its own page in that
 * region, a region's site sends the player to the other region's site. The
 * room is in the address either way, which the lobby joins on start.
 */
export function goToRegionRoom(room: RoomRef, navigate: (url: string) => void = (url) => location.assign(url)): void {
  if (!room.region) return;
  const url = HOSTED_ON ? new URL(location.href) : new URL("/", new URL(room.region.dataUrl).origin);
  url.searchParams.set("lobby", room.lobbyId);
  if (room.inviteToken) url.searchParams.set("invite", room.inviteToken);
  else url.searchParams.delete("invite");
  if (HOSTED_ON) setTabRegion(room.region);
  navigate(url.href);
}

/** What the field's text means, in a sentence. */
function describe(target: CodeTarget | null): string {
  if (!target) return "Paste a room link, or a code like eu:3fa9c2d1.";
  if (target.kind === "elsewhere") return `That link is for ${target.host}, not a Washoi region.`;
  const { room } = target;
  if (inThisRegion(room)) return `Room ${room.lobbyId}${room.inviteToken ? " (private)" : ""}.`;
  return `That room is in ${room.region?.name}, where you play as a separate player. Joining switches region.`;
}

export class JoinLobbyDialog {
  readonly root = el("div", "lobby-guide join-lobby");
  private readonly field = document.createElement("input");
  private readonly status = el("p", "join-lobby__status");
  private readonly join = raiseKey(button("lobby-guide__button"), { label: "Join", variants: ["ink", "inline"] });
  private readonly cancel = raiseKey(button("lobby-guide__button"), { label: "Cancel", variants: ["cream", "inline"] });
  private readonly input = InputSystem.getInstance();
  private readonly previousFocus = document.activeElement as HTMLElement | null;
  private offNavigation: (() => void) | null = null;
  private target: CodeTarget | null = null;
  private disposed = false;

  constructor(private readonly options: { client: LobbyClient; onClose(): void; text?: string }) {
    UIStyles.injectCSS("lobby-guide", welcomeCSS);
    UIStyles.injectCSS("join-lobby", joinCSS);
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-labelledby", "join-lobby-title");
    const card = el("section", "lobby-guide__card join-lobby__card");
    const title = el("h1", "join-lobby__title", "Join lobby");
    title.id = "join-lobby-title";
    this.field.type = "text";
    this.field.className = "join-lobby__field";
    this.field.placeholder = "Room link or code";
    this.field.spellcheck = false;
    this.field.autocomplete = "off";
    this.field.setAttribute("aria-label", "Room link or code");
    this.field.setAttribute("aria-describedby", "join-lobby-status");
    this.status.id = "join-lobby-status";
    this.status.setAttribute("role", "status");
    this.field.addEventListener("input", () => this.read());
    this.join.addEventListener("click", () => this.go());
    this.cancel.addEventListener("click", () => options.onClose());
    const actions = el("div", "join-lobby__actions");
    actions.append(this.join, this.cancel);
    card.append(title, this.field, this.status, actions);
    this.root.append(card);
    this.root.addEventListener("pointerdown", (event) => {
      if (event.target === this.root) options.onClose();
    });
    document.body.append(this.root);
    this.offNavigation = UINavigation.getInstance().push({ root: this.root, back: () => options.onClose() });
    this.input.registerContext({ id: INPUT_CONTEXT, blocking: true, actions: [] });
    this.input.pushContext(INPUT_CONTEXT);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    this.field.value = options.text ?? "";
    this.read();
    this.field.focus();
  }

  private read(): void {
    this.target = parseRoomCode(this.field.value);
    const room = this.target?.kind === "room" ? this.target.room : null;
    this.status.textContent = this.field.value.trim() || this.target ? describe(this.target) : "";
    this.join.disabled = !room;
    setRaisedKeyText(this.join, room && !inThisRegion(room) ? `Switch to ${room.region?.code}` : "Join");
  }

  private go(): void {
    if (this.target?.kind !== "room") return;
    const { room } = this.target;
    if (inThisRegion(room)) {
      this.options.client.joinLobby(room.lobbyId, room.inviteToken);
      this.options.onClose();
    } else {
      goToRegionRoom(room);
    }
  }

  private readonly onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.options.onClose();
      return;
    }
    if (event.key === "Enter" && event.target === this.field) {
      event.preventDefault();
      this.go();
    }
    // Typing stays in the field; lobby hotkeys don't see it
    event.stopPropagation();
  };
  private readonly onKeyUp = (event: KeyboardEvent) => event.stopPropagation();

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offNavigation?.();
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    if (this.input.getActiveContext() === INPUT_CONTEXT) this.input.popContext();
    this.root.remove();
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }
}
