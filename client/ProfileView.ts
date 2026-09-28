/**
 * ProfileView — the player's account, on the gold panel the Welcome screen uses:
 * the key that opens it from any browser first, then changing the name and
 * playing as someone else as screens of their own. The ranked record sits on
 * the stage beside the panel.
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
import type { GametypeInfo } from "../../../lobby/types";
import { switchFpsAccount } from "./FpsLobbyService";
import { createSlot, judgeName, type Slot, wireKeySlot } from "./IdentityFields";
import { buildIdentityFrame, identityScreen, narrowOntoRail, widenFromRail } from "./IdentityFrame";
import { type LeaderboardPage, newUiApi } from "./NewUiApi";
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

export type ProfileScreen = "key" | "name" | "switch";

export interface ProfileOptions {
  client: LobbyClient;
  isInRoom: () => boolean;
  modes: () => readonly GametypeInfo[];
  /** The panel has narrowed back onto the rail. */
  onClose?: () => void;
}

export class ProfileView {
  readonly root: HTMLElement;
  private readonly client: LobbyClient;
  private readonly isInRoom: () => boolean;
  private readonly modes: () => readonly GametypeInfo[];
  private readonly onClose: () => void;
  private readonly unsubscribers: (() => void)[] = [];
  private opened = false;
  private closing = false;

  private ghostEl!: HTMLElement;
  private screens = new Map<ProfileScreen, HTMLElement>();
  private leadNameEl!: HTMLElement;
  private keyNameEl!: HTMLElement;
  private keyGroupsEl!: HTMLElement;
  private keyPlateEl!: HTMLElement;
  private keyActionsEl!: HTMLElement;
  private keyWarnEl!: HTMLElement;
  private keyMissingEl!: HTMLElement;
  private doneKey!: HTMLButtonElement;
  private nameSlot!: Slot;
  private renameKey!: HTMLButtonElement;
  private switchSlot!: Slot;
  private switchKey!: HTMLButtonElement;
  private switching = false;
  private recordStatusEl!: HTMLElement;
  private recordRowsEl!: HTMLElement;
  private recordSeq = 0;
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !this.opened) return;
    event.stopPropagation();
    // Esc steps back to the key, and from the key back to the lobby
    if (this.screens.get("key")?.hidden) this.show("key");
    else this.close();
  };

  constructor(options: ProfileOptions) {
    UIStyles.injectCSS("lobby-identity", identityCSSRaw);
    this.client = options.client;
    this.isInRoom = options.isInRoom;
    this.modes = options.modes;
    this.onClose = options.onClose ?? (() => {});
    this.root = this.build();

    // The account's own messages reach AccountSession through the same client,
    // so read the new name a turn later, once it has taken it
    const later = () => queueMicrotask(() => this.refresh());
    for (const type of ["welcome", "identity:renamed", "_disconnected", "_connected"]) {
      this.unsubscribers.push(this.client.on(type, later));
    }
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Widen out of the rail onto `parent`, at the key unless asked otherwise. */
  open(parent: HTMLElement, screen: ProfileScreen = "key"): void {
    this.closing = false;
    this.root.classList.remove("welcome--leaving");
    parent.appendChild(this.root);
    this.opened = true;
    document.addEventListener("keydown", this.onKeyDown, true);
    widenFromRail(this.root);
    this.refresh();
    this.show(screen);
  }

  /** Narrow back onto the rail. */
  close(): void {
    if (!this.opened || this.closing) return;
    this.closing = true;
    this.opened = false;
    document.removeEventListener("keydown", this.onKeyDown, true);
    narrowOntoRail(this.root, () => {
      this.closing = false;
      this.onClose();
    });
  }

  private build(): HTMLElement {
    const frame = buildIdentityFrame("Profile", "");
    this.ghostEl = frame.ghost;
    frame.inner.append(this.buildKeyScreen(), this.buildNameScreen(), this.buildSwitchScreen());
    frame.stage.append(this.buildRecord());
    frame.root.classList.add("welcome--profile");
    this.refresh();
    return frame.root;
  }

  private show(screen: ProfileScreen): void {
    for (const [id, element] of this.screens) element.hidden = id !== screen;
    if (screen === "key") this.doneKey.focus();
    else if (screen === "name") {
      this.nameSlot.setValue(currentIdentity()?.name ?? "");
      this.refreshNameState();
      this.nameSlot.input.focus();
    } else {
      this.refreshSwitchState();
      this.switchSlot.input.focus();
    }
  }

  /** A row of small keys under a screen: a question, then where it leads. */
  private altRow(text: string, keys: Array<[string, () => void]>): HTMLElement {
    const alt = document.createElement("div");
    alt.className = "welcome__alt";
    alt.append(text);
    for (const [label, go] of keys) {
      const key = createRaisedKey({ label, variants: ["sm", "cream", "inline"] });
      key.addEventListener("click", go);
      alt.appendChild(key);
    }
    return alt;
  }

  private buildKeyScreen(): HTMLElement {
    this.leadNameEl = document.createElement("b");
    const screen = identityScreen("Keep your name", "Your player key", [
      "Paste it on any computer to play as ",
      this.leadNameEl,
      ".",
    ]);
    screen.addEventListener("submit", (event) => event.preventDefault());

    const plate = document.createElement("div");
    plate.className = "keyplate keyplate--hidden";
    this.keyPlateEl = plate;
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
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "keyplate__reveal";
    reveal.textContent = "Show";
    reveal.setAttribute("aria-pressed", "false");
    // Hidden until asked, so a stream or a screenshot doesn't give it away
    reveal.addEventListener("click", () => {
      const hidden = plate.classList.toggle("keyplate--hidden");
      reveal.textContent = hidden ? "Show" : "Hide";
      reveal.setAttribute("aria-pressed", String(!hidden));
    });
    plate.append(who, prefix, this.keyGroupsEl, reveal);

    const actions = document.createElement("div");
    actions.className = "welcome__actions";
    this.keyActionsEl = actions;
    const copy = createRaisedKey({ label: "Copy key", variants: ["cream", "inline"] });
    copy.addEventListener("click", () => void this.copyKey(copy));
    const save = createRaisedKey({ label: "Save as file", variants: ["cream", "inline"] });
    save.addEventListener("click", () => this.saveKeyFile());
    actions.append(copy, save);
    // Chromium's own password manager takes a credential directly, and syncs it
    if (this.passwordCredential()) {
      const store = createRaisedKey({ label: "Save in browser", variants: ["cream", "inline"] });
      store.addEventListener("click", () => void this.saveKeyInBrowser(store));
      actions.appendChild(store);
    }

    const warn = document.createElement("p");
    warn.className = "identity-warn";
    this.keyWarnEl = warn;
    const strong = document.createElement("b");
    strong.textContent = "This key is you.";
    warn.append(strong, " Anyone who has it can play as you, and nobody can get it back for you if it's lost.");

    this.keyMissingEl = document.createElement("p");
    this.keyMissingEl.className = "welcome__lead";
    this.keyMissingEl.textContent = "Your key is made the first time you reach the lobby.";

    this.doneKey = createRaisedKey({ label: "Done", hint: "Back to the lobby", variants: ["ink", "go"] });
    this.doneKey.addEventListener("click", () => this.close());
    const go = document.createElement("div");
    go.className = "welcome__go";
    go.appendChild(this.doneKey);

    screen.append(
      plate,
      actions,
      warn,
      this.keyMissingEl,
      go,
      this.altRow("Not right?", [
        ["Change name", () => this.show("name")],
        ["Use another key", () => this.show("switch")],
      ]),
    );
    this.screens.set("key", screen);
    return screen;
  }

  private buildNameScreen(): HTMLElement {
    const form = identityScreen(
      "Change your name",
      "Who are you?",
      "Everyone sees it: in rooms, chat and the rankings.",
    );
    this.nameSlot = createSlot({
      id: "profile-name",
      label: "Your player name",
      maxLength: 16,
      counted: true,
      say: "2–16 characters: letters, numbers, _ and -",
    });
    this.renameKey = createRaisedKey({ label: "Save →", hint: "Yours alone", variants: ["ink", "go"] });
    this.renameKey.type = "submit";
    const go = document.createElement("div");
    go.className = "welcome__go";
    go.appendChild(this.renameKey);
    this.nameSlot.input.addEventListener("input", () => this.refreshNameState());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.rename();
    });
    form.append(
      this.nameSlot.root,
      go,
      this.altRow("Keep the one you have?", [["Back to your key", () => this.show("key")]]),
    );
    form.hidden = true;
    this.screens.set("name", form);
    return form;
  }

  private buildSwitchScreen(): HTMLElement {
    const form = identityScreen(
      "Play as someone else",
      "Paste a key",
      "This browser forgets its own key when it switches, so save that key first.",
    );
    this.switchSlot = createSlot({
      id: "profile-key",
      label: "The player key to use",
      placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
      prefix: "WASHOI-",
      say: `${KEY_LENGTH} characters. Dashes and spaces don't matter.`,
    });
    this.switchKey = createRaisedKey({ label: "Use it →", hint: "One key, one player", variants: ["ink", "go"] });
    this.switchKey.type = "submit";
    this.switchKey.disabled = true;
    wireKeySlot(this.switchSlot, (_key, whole) => {
      this.switchKey.disabled = !whole || this.isInRoom() || this.switching || !this.client.connected;
    });
    const go = document.createElement("div");
    go.className = "welcome__go";
    go.appendChild(this.switchKey);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.switchAccount();
    });
    form.append(
      this.switchSlot.root,
      go,
      this.altRow("Staying yourself?", [["Back to your key", () => this.show("key")]]),
    );
    form.hidden = true;
    this.screens.set("switch", form);
    return form;
  }

  private buildRecord(): HTMLElement {
    const record = document.createElement("section");
    record.className = "profile-record";
    record.setAttribute("aria-label", "Your record");
    const head = document.createElement("div");
    head.className = "profile-record__head";
    const title = document.createElement("h2");
    title.textContent = "Your record";
    const hint = document.createElement("span");
    hint.textContent = "Ranked matches only";
    head.append(title, hint);
    this.recordStatusEl = document.createElement("p");
    this.recordStatusEl.className = "profile-record__status";
    this.recordStatusEl.setAttribute("role", "status");
    this.recordRowsEl = document.createElement("div");
    this.recordRowsEl.className = "profile-record__rows";
    record.append(head, this.recordStatusEl, this.recordRowsEl);
    return record;
  }

  /**
   * The account's own standing, one line per mode it has a ranked result in.
   * Every number here comes from the lobby's own leaderboard; a mode the player
   * has never finished a ranked match in has no line at all.
   */
  async refreshRecord(): Promise<void> {
    const sequence = ++this.recordSeq;
    if (!this.client.connected) {
      this.recordRowsEl.replaceChildren();
      this.recordStatusEl.textContent = "Connect to the lobby to see your record.";
      return;
    }
    const availability = newUiApi.getFeatureStatus("leaderboard");
    if (availability.status !== "ready") {
      this.recordRowsEl.replaceChildren();
      this.recordStatusEl.textContent = availability.reason;
      return;
    }
    const modes = this.modes();
    if (modes.length === 0) {
      this.recordRowsEl.replaceChildren();
      this.recordStatusEl.textContent = "This lobby is not advertising any mode.";
      return;
    }
    if (this.recordRowsEl.childElementCount === 0) this.recordStatusEl.textContent = "Reading the rankings…";

    const asked = await Promise.all(
      modes.map(async (mode) => ({
        mode,
        result: await newUiApi.getLeaderboard({ gametype: mode.id, period: "all", offset: 0, limit: 1 }),
      })),
    );
    if (sequence !== this.recordSeq) return;

    const standings: { mode: GametypeInfo; row: NonNullable<LeaderboardPage["localPlayerEntry"]> }[] = [];
    let refusal = "";
    for (const { mode, result } of asked) {
      if (result.status !== "ready") refusal ||= result.reason;
      else if (result.data.localPlayerEntry) standings.push({ mode, row: result.data.localPlayerEntry });
    }

    this.recordRowsEl.replaceChildren();
    if (standings.length === 0) {
      this.recordStatusEl.textContent =
        refusal || "No ranked match yet. A match counts once most of the room is people, not bots.";
      return;
    }
    const played = standings.reduce((sum, { row }) => sum + row.wins + row.losses + row.draws, 0);
    const best = standings.reduce((top, one) => (one.row.rank < top.row.rank ? one : top));
    this.recordStatusEl.textContent = `${played} ranked ${played === 1 ? "match" : "matches"} · best #${best.row.rank} in ${best.mode.name}`;
    for (const { mode, row } of standings.sort((a, b) => a.row.rank - b.row.rank)) {
      const line = document.createElement("div");
      line.className = "profile-record__row";
      for (const [value, kind] of [
        [mode.name, "mode"],
        [`#${row.rank}`, "rank"],
        [`${row.wins} W`, "w"],
        [`${row.losses} L`, "l"],
        [`${row.draws} D`, "d"],
      ] as const) {
        const cell = document.createElement("span");
        cell.className = `profile-record__${kind}`;
        cell.textContent = value;
        line.append(cell);
      }
      this.recordRowsEl.append(line);
    }
  }

  /** Show the account as it stands: the name, the key, and what can be done now. */
  refresh(): void {
    const name = currentIdentity()?.name ?? PlayerProfile.load().name;
    this.ghostEl.textContent = name.toUpperCase();
    this.leadNameEl.textContent = name;
    this.keyNameEl.textContent = name;

    const key = storedPlayerKey();
    const groups = key ? formatKey(key).split("-").slice(1) : [];
    this.keyGroupsEl.replaceChildren(
      ...groups.map((group) => {
        const span = document.createElement("span");
        span.textContent = group;
        return span;
      }),
    );
    for (const part of [this.keyPlateEl, this.keyActionsEl, this.keyWarnEl]) part.hidden = !key;
    this.keyMissingEl.hidden = !!key;

    if (document.activeElement !== this.nameSlot.input) this.nameSlot.setValue(name);
    this.refreshNameState();
    this.refreshSwitchState();
    void this.refreshRecord();
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

  private refreshSwitchState(): void {
    this.switchKey.disabled = this.switching || this.isInRoom() || !this.client.connected;
    if (this.switching) return;
    if (this.isInRoom()) this.switchSlot.tell("Leave your room before switching player.");
    else if (!this.client.connected) this.switchSlot.tell("The lobby is offline.");
    else this.switchSlot.tell(`${KEY_LENGTH} characters. Dashes and spaces don't matter.`);
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
    let answer = "";
    let tone: "ok" | "bad" = "ok";
    try {
      const welcome = await switchFpsAccount(pasted);
      this.switchSlot.input.value = "";
      answer = `Welcome back, ${welcome.identity?.name ?? "player"}`;
    } catch (err) {
      tone = "bad";
      answer =
        err instanceof LoginError
          ? err.code === "unknown_key"
            ? "No player has that key. Check it, or keep the player you have."
            : "Too many tries. Wait a minute, then try again."
          : "The lobby didn't answer. Try again.";
    } finally {
      this.switching = false;
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
    this.opened = false;
    document.removeEventListener("keydown", this.onKeyDown, true);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.root.remove();
  }
}
