/**
 * ProfileView — the player's account: their name, the key that opens it from
 * any browser, and the way into another account.
 *
 * The key never leaves the browser except to be copied or saved by the player;
 * the lobby only ever sees it at login. See docs/research/PLAYER_IDENTITY.md.
 */

import { PlayerProfile } from "../../../engine/player/PlayerProfile";
import { createRaisedKey } from "../../../engine/ui/components/RaisedKey";
import { UIStyles } from "../../../engine/ui/UIStyles";
import {
  currentIdentity,
  LoginError,
  renameAccount,
  renameFailureText,
  storedPlayerKey,
} from "../../../lobby/AccountSession";
import type { LobbyClient } from "../../../lobby/LobbyClient";
import { formatKey, KEY_LENGTH } from "../../../lobby/PlayerIdentity";
import { switchFpsAccount } from "./FpsLobbyService";
import { createSlot, judgeName, type Slot, wireKeySlot } from "./IdentityFields";
import identityCSSRaw from "./styles/Identity.css?raw";

const KEY_FILE_LINES = (name: string, key: string) => [
  "Washiki Washoi player key",
  "",
  `Player: ${name}`,
  `Key:    ${key}`,
  "",
  'To play as this player in another browser, open the game, choose "Use my key"',
  "and paste the key. Anyone with this key can play as you. Keep it private.",
  "",
];

interface PasswordCredentialConstructor {
  new (data: { id: string; password: string; name?: string }): Credential;
}

export class ProfileView {
  readonly root: HTMLElement;
  private readonly client: LobbyClient;
  private readonly isInRoom: () => boolean;
  private readonly unsubscribers: (() => void)[] = [];

  private titleEl!: HTMLElement;
  private ghostEl!: HTMLElement;
  private nameSlot!: Slot;
  private renameKey!: HTMLButtonElement;
  private keyCardEl!: HTMLElement;
  private keyNameEl!: HTMLElement;
  private keyGroupsEl!: HTMLElement;
  private keyRevealEl!: HTMLButtonElement;
  private keyMissingEl!: HTMLElement;
  private switchSlot!: Slot;
  private switchKey!: HTMLButtonElement;
  private switching = false;

  constructor(options: { client: LobbyClient; isInRoom: () => boolean }) {
    UIStyles.injectCSS("lobby-identity", identityCSSRaw);
    this.client = options.client;
    this.isInRoom = options.isInRoom;
    this.root = this.build();

    // The account's own messages reach AccountSession through the same client,
    // so read the new name a turn later, once it has taken it
    const later = () => queueMicrotask(() => this.refresh());
    for (const type of ["welcome", "identity:renamed", "_disconnected", "_connected"]) {
      this.unsubscribers.push(this.client.on(type, later));
    }
  }

  private build(): HTMLElement {
    const page = document.createElement("div");
    page.className = "lobby__page lobby__profile";

    const light = document.createElement("div");
    light.className = "lobby__light";
    light.setAttribute("aria-hidden", "true");
    for (const tone of ["violet", "deep", "accent"]) {
      const orb = document.createElement("div");
      orb.className = `lobby__orb lobby__orb--${tone}`;
      light.appendChild(orb);
    }
    this.ghostEl = document.createElement("div");
    this.ghostEl.className = "lobby__ghost";
    this.ghostEl.setAttribute("aria-hidden", "true");
    page.append(light, this.ghostEl);

    const header = document.createElement("header");
    header.className = "lobby__heading";
    const kicker = document.createElement("span");
    kicker.className = "lobby__kicker";
    kicker.textContent = "Profile";
    this.titleEl = document.createElement("h1");
    this.titleEl.className = "lobby__title";
    header.append(kicker, this.titleEl);
    page.appendChild(header);

    const columns = document.createElement("div");
    columns.className = "lobby__profile-columns";
    columns.append(this.buildNameCard(), this.buildKeyCard());
    page.append(columns, this.buildSwitchCard());

    this.refresh();
    return page;
  }

  private card(title: string, hint: string): HTMLElement {
    const card = document.createElement("section");
    card.className = "lobby-card";
    const head = document.createElement("div");
    head.className = "lobby-card__head";
    const heading = document.createElement("h2");
    heading.className = "lobby-card__title";
    heading.textContent = title;
    const note = document.createElement("span");
    note.className = "lobby-card__hint";
    note.textContent = hint;
    head.append(heading, note);
    card.appendChild(head);
    return card;
  }

  private buildNameCard(): HTMLElement {
    const card = this.card("Your name", "Yours alone");
    this.nameSlot = createSlot({
      id: "profile-name",
      label: "Your player name",
      maxLength: 16,
      counted: true,
      say: "2–16 characters: letters, numbers, _ and -",
    });
    this.renameKey = createRaisedKey({ label: "Save name", variants: ["sm", "inline"] });
    this.renameKey.type = "submit";

    const form = document.createElement("form");
    form.className = "lobby-card__form";
    form.append(this.nameSlot.root, this.renameKey);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.rename();
    });
    this.nameSlot.input.addEventListener("input", () => this.refreshNameState());
    card.appendChild(form);
    return card;
  }

  private buildKeyCard(): HTMLElement {
    const card = this.card("Your player key", "Never shown to the lobby");
    this.keyCardEl = card;

    const plate = document.createElement("div");
    plate.className = "keyplate keyplate--hidden";
    const who = document.createElement("div");
    who.className = "keyplate__who";
    who.append("Player ");
    this.keyNameEl = document.createElement("b");
    who.appendChild(this.keyNameEl);
    const prefix = document.createElement("span");
    prefix.className = "keyplate__prefix";
    prefix.textContent = "WASHOI-";
    this.keyGroupsEl = document.createElement("div");
    this.keyGroupsEl.className = "keyplate__groups";
    this.keyRevealEl = document.createElement("button");
    this.keyRevealEl.type = "button";
    this.keyRevealEl.className = "keyplate__reveal";
    this.keyRevealEl.textContent = "Show";
    // Hidden until asked, so a stream or a screenshot doesn't give it away
    this.keyRevealEl.addEventListener("click", () => {
      const hidden = plate.classList.toggle("keyplate--hidden");
      this.keyRevealEl.textContent = hidden ? "Show" : "Hide";
      this.keyRevealEl.setAttribute("aria-pressed", String(!hidden));
    });
    plate.append(who, prefix, this.keyGroupsEl, this.keyRevealEl);
    card.appendChild(plate);

    const actions = document.createElement("div");
    actions.className = "lobby-card__actions";
    const copy = createRaisedKey({ label: "Copy key", variants: ["sm", "cream", "inline"] });
    copy.addEventListener("click", () => void this.copyKey(copy));
    const save = createRaisedKey({ label: "Save as file", variants: ["sm", "cream", "inline"] });
    save.addEventListener("click", () => this.saveKeyFile());
    actions.append(copy, save);

    // Chromium's own password manager takes a credential directly, and syncs it
    if (this.passwordCredential()) {
      const store = createRaisedKey({ label: "Save in browser", variants: ["sm", "cream", "inline"] });
      store.addEventListener("click", () => void this.saveKeyInBrowser(store));
      actions.appendChild(store);
    }
    card.appendChild(actions);

    const warn = document.createElement("p");
    warn.className = "identity-warn";
    const strong = document.createElement("b");
    strong.textContent = "This key is you.";
    warn.append(strong, " Anyone who has it can play as you, and nobody can get it back for you if it's lost.");
    card.appendChild(warn);

    this.keyMissingEl = document.createElement("p");
    this.keyMissingEl.className = "lobby-card__empty";
    this.keyMissingEl.textContent = "Your key is made the first time you reach the lobby.";
    card.appendChild(this.keyMissingEl);
    return card;
  }

  private buildSwitchCard(): HTMLElement {
    const card = this.card("Play as someone else", "One key, one player");
    card.classList.add("lobby-card--switch");
    this.switchSlot = createSlot({
      id: "profile-key",
      label: "The player key to use",
      placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
      prefix: "WASHOI-",
      say: `${KEY_LENGTH} characters. Dashes and spaces don't matter.`,
    });
    this.switchKey = createRaisedKey({ label: "Use this key", variants: ["sm", "cream", "inline"] });
    this.switchKey.type = "submit";
    this.switchKey.disabled = true;
    wireKeySlot(this.switchSlot, (_key, whole) => {
      this.switchKey.disabled = !whole || this.isInRoom() || this.switching;
    });

    const form = document.createElement("form");
    form.className = "lobby-card__form";
    form.append(this.switchSlot.root, this.switchKey);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.switchAccount();
    });
    card.appendChild(form);

    const note = document.createElement("p");
    note.className = "lobby-card__note";
    note.textContent = "This browser forgets its own key when it switches, so save that key first.";
    card.appendChild(note);
    return card;
  }

  /** Show the account as it stands: the name, the key, and what can be done now. */
  refresh(): void {
    const name = currentIdentity()?.name ?? PlayerProfile.load().name;
    this.titleEl.textContent = name;
    this.ghostEl.textContent = name.toUpperCase();
    this.keyNameEl.textContent = name;

    const key = storedPlayerKey();
    const groups = key ? (formatKey(key).split("-").slice(1) ?? []) : [];
    this.keyGroupsEl.replaceChildren(
      ...groups.map((group) => {
        const span = document.createElement("span");
        span.textContent = group;
        return span;
      }),
    );
    this.keyCardEl.classList.toggle("lobby-card--empty", !key);
    this.keyMissingEl.hidden = !!key;

    if (document.activeElement !== this.nameSlot.input) this.nameSlot.setValue(name);
    this.refreshNameState();
    this.switchKey.disabled = this.switching || this.isInRoom() || !this.client.connected;
    if (this.switching) return;
    if (this.isInRoom()) this.switchSlot.tell("Leave your room before switching player.");
    else if (!this.client.connected) this.switchSlot.tell("The lobby is offline.");
    else this.switchSlot.tell(`${KEY_LENGTH} characters. Dashes and spaces don't matter.`);
  }

  /** `quiet` leaves the status line alone, for an answer that is already there. */
  private refreshNameState(quiet = false): void {
    const typed = this.nameSlot.input.value.trim();
    const current = currentIdentity()?.name ?? "";
    const verdict = judgeName(typed);
    const inRoom = this.isInRoom();
    const offline = !this.client.connected || !currentIdentity();

    this.nameSlot.input.disabled = inRoom || offline;
    this.renameKey.disabled = inRoom || offline || !verdict.ok || typed === current;

    if (quiet) return;
    if (inRoom) this.nameSlot.tell("Leave your room to change your name.");
    else if (offline) this.nameSlot.tell("Connect to the lobby to change your name.");
    else if (typed === current) this.nameSlot.tell("This is your name.");
    else this.nameSlot.tell(verdict.text, verdict.tone);
  }

  private async rename(): Promise<void> {
    const name = this.nameSlot.input.value.trim();
    if (!judgeName(name).ok) return;
    this.renameKey.disabled = true;
    this.nameSlot.tell("Asking the lobby…");
    const outcome = await renameAccount(name);
    if (outcome.ok) {
      this.refresh();
      this.nameSlot.tell(`You're ${outcome.identity.name} now`, "ok");
    } else {
      this.refreshNameState(true);
      this.nameSlot.tell(renameFailureText(outcome.code), "bad");
    }
  }

  private async switchAccount(): Promise<void> {
    const pasted = this.switchSlot.input.value;
    this.switching = true;
    this.switchKey.disabled = true;
    this.switchSlot.tell("Asking the lobby…");
    try {
      const welcome = await switchFpsAccount(pasted);
      this.switchSlot.input.value = "";
      this.refresh();
      this.switchSlot.tell(`Welcome back, ${welcome.identity?.name ?? "player"}`, "ok");
    } catch (err) {
      const text =
        err instanceof LoginError
          ? err.code === "unknown_key"
            ? "No player has that key. Check it, or keep the player you have."
            : "Too many tries. Wait a minute, then try again."
          : "The lobby didn't answer. Try again.";
      this.switchSlot.tell(text, "bad");
    } finally {
      this.switching = false;
      const answer = this.switchSlot.say.textContent ?? "";
      const tone = this.switchSlot.say.classList.contains("identity-say--bad") ? "bad" : "ok";
      this.refresh();
      this.switchSlot.tell(answer, tone);
    }
  }

  private passwordCredential(): PasswordCredentialConstructor | undefined {
    return (window as unknown as { PasswordCredential?: PasswordCredentialConstructor }).PasswordCredential;
  }

  private said(key: HTMLButtonElement, text: string): void {
    const label = key.querySelector(".raised-key__label");
    if (!label) return;
    const was = label.textContent;
    label.textContent = text;
    setTimeout(() => {
      label.textContent = was;
    }, 1600);
  }

  private async copyKey(button: HTMLButtonElement): Promise<void> {
    const key = storedPlayerKey();
    if (!key) return;
    try {
      await navigator.clipboard.writeText(formatKey(key));
      this.said(button, "Copied ✓");
    } catch {
      this.said(button, "Copy blocked");
    }
  }

  private saveKeyFile(): void {
    const key = storedPlayerKey();
    if (!key) return;
    const name = currentIdentity()?.name ?? PlayerProfile.load().name;
    const blob = new Blob([KEY_FILE_LINES(name, formatKey(key)).join("\n")], { type: "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `washoi-key-${name}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  private async saveKeyInBrowser(button: HTMLButtonElement): Promise<void> {
    const key = storedPlayerKey();
    const Credentials = this.passwordCredential();
    if (!key || !Credentials) return;
    const name = currentIdentity()?.name ?? PlayerProfile.load().name;
    try {
      await navigator.credentials.store(new Credentials({ id: name, password: formatKey(key), name }));
      this.said(button, "Offered ✓");
    } catch {
      this.said(button, "Browser said no");
    }
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.root.remove();
  }
}
