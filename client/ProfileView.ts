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
import type { GametypeInfo, RankingScope } from "../../../lobby/types";
import type { RatingMode } from "../../../shared/ranking/RatingPolicy";
import { switchFpsAccount } from "./FpsLobbyService";
import { createSlot, judgeName, type Slot, wireKeySlot } from "./IdentityFields";
import { buildIdentityFrame, identityScreen, narrowOntoRail, widenFromRail } from "./IdentityFrame";
import { type LeaderboardPage, newUiApi } from "./NewUiApi";
import { ratingFeedback } from "./RatingFeedback";
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
  private historyEl!: HTMLElement;
  private historySeq = 0;
  private historyMode: RatingMode | null = null;
  private recordScope: RankingScope = "public";
  private readonly recordScopeKeys = new Map<RankingScope, HTMLButtonElement>();
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
    hint.textContent = "Career skill";
    head.append(title, hint);
    const scopes = document.createElement("div");
    scopes.className = "profile-record__scopes";
    scopes.setAttribute("role", "group");
    scopes.setAttribute("aria-label", "Ranking scope");
    for (const scope of ["public", "private"] as const) {
      const key = createRaisedKey({
        label: scope === "public" ? "Public" : "Private",
        variants: ["sm", "cream", "inline"],
      });
      key.dataset.scope = scope;
      key.setAttribute("aria-pressed", String(scope === this.recordScope));
      key.addEventListener("click", () => {
        if (scope === this.recordScope) return;
        this.recordScope = scope;
        this.historySeq++;
        this.historyEl.replaceChildren();
        this.recordRowsEl.replaceChildren();
        for (const [value, button] of this.recordScopeKeys)
          button.setAttribute("aria-pressed", String(value === scope));
        void this.refreshRecord();
      });
      this.recordScopeKeys.set(scope, key);
      scopes.append(key);
    }
    this.recordStatusEl = document.createElement("p");
    this.recordStatusEl.className = "profile-record__status";
    this.recordStatusEl.setAttribute("role", "status");
    this.recordRowsEl = document.createElement("div");
    this.recordRowsEl.className = "profile-record__rows";
    record.append(head, scopes, this.recordStatusEl, this.recordRowsEl);
    this.historyEl = document.createElement("section");
    this.historyEl.className = "profile-history";
    this.historyEl.setAttribute("aria-label", "Your recent matches");
    record.append(this.historyEl);
    return record;
  }

  /**
   * The account's own standing, one line per mode it has a ranked result in.
   * Every number here comes from the lobby's own leaderboard; a mode the player
   * has never finished a ranked match in has no line at all.
   */
  async refreshRecord(): Promise<void> {
    const sequence = ++this.recordSeq;
    if (newUiApi.getFeatureStatus("playerStats").status === "ready") {
      await this.refreshStatsRecord(sequence);
      return;
    }
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
        result: await newUiApi.getLeaderboard({
          gametype: mode.id,
          period: "all",
          offset: 0,
          limit: 1,
          scope: this.recordScope,
        }),
      })),
    );
    if (sequence !== this.recordSeq) return;

    const standings: { mode: GametypeInfo; row: NonNullable<LeaderboardPage["localPlayerEntry"]> }[] = [];
    let refusal = "";
    let pending = 0;
    let excluded = 0;
    for (const { mode, result } of asked) {
      if (result.status !== "ready") refusal ||= result.reason;
      else {
        pending += result.data.localProcessing?.pending ?? 0;
        excluded += result.data.localProcessing?.excluded ?? 0;
        if (result.data.localPlayerEntry) standings.push({ mode, row: result.data.localPlayerEntry });
      }
    }

    this.recordRowsEl.replaceChildren();
    if (standings.length === 0) {
      this.recordStatusEl.textContent =
        refusal ||
        (pending
          ? `${pending} matches await bot calibration.`
          : excluded
            ? `${excluded} matches did not qualify for skill rating.`
            : "No ranked match yet. Finish an eligible match to get a provisional rating.");
      return;
    }
    const played = standings.reduce((sum, { row }) => sum + row.wins + row.losses + row.draws, 0);
    const best = standings.reduce((top, one) => (one.row.rank < top.row.rank ? one : top));
    this.recordStatusEl.textContent = `${played} ${this.recordScope} ${played === 1 ? "match" : "matches"} · best #${best.row.rank} in ${best.mode.name}${pending ? ` · ${pending} await calibration` : ""}${excluded ? ` · ${excluded} not rated` : ""}`;
    for (const { mode, row } of standings.sort((a, b) => a.row.rank - b.row.rank)) {
      const line = document.createElement("div");
      line.className = "profile-record__row";
      for (const [value, kind] of [
        [mode.name, "mode"],
        [`#${row.rank}`, "rank"],
        [`${row.rating}${row.provisional ? " (P)" : ""}`, "rating"],
        [`${row.wins} W`, "w"],
        [`${row.losses} L`, "l"],
        [`${row.draws} D`, "d"],
      ] as const) {
        const cell = document.createElement("span");
        cell.className = `profile-record__${kind}`;
        cell.textContent = value;
        line.append(cell);
      }
      line.title = `Rating ${row.rating}${row.provisional ? " · Provisional" : ""} · ${row.ratedMatches} rated matches`;
      this.recordRowsEl.append(line);
    }
  }

  private async refreshStatsRecord(sequence: number): Promise<void> {
    const modes = this.modes().filter((mode) => ["duel", "amphi", "ffa", "snd"].includes(mode.id));
    const scope = this.recordScope;
    const answers = await Promise.all(
      modes.map(async (mode) => ({
        mode,
        result: await newUiApi.getPlayerStats({ gametype: mode.id as RatingMode, scope, period: "all" }),
      })),
    );
    if (sequence !== this.recordSeq) return;
    this.recordRowsEl.replaceChildren();
    let matches = 0,
      pending = 0,
      excluded = 0,
      failure = "";
    for (const { mode, result } of answers) {
      if (result.status !== "ready") {
        failure ||= result.reason;
        continue;
      }
      const summary = result.data;
      matches += summary.matches;
      pending += summary.pending;
      excluded += summary.excluded;
      if (!summary.matches && !summary.pending && !summary.excluded && !summary.rating) continue;
      const line = document.createElement("div");
      line.className = "profile-record__row";
      const key = document.createElement("button");
      key.type = "button";
      key.className = "profile-record__mode profile-record__history-key";
      key.textContent = mode.name;
      key.title = `Show recent ${mode.name} matches`;
      key.addEventListener("click", () => {
        this.historyMode = mode.id as RatingMode;
        void this.refreshHistory();
      });
      line.append(key);
      const cells = [
        summary.rating ? `#${summary.rating.rank}` : "—",
        summary.rating ? `${summary.rating.value}${summary.rating.provisional ? " (P)" : ""}` : "Not rated",
        `${summary.wins} W`,
        `${summary.losses} L`,
        `${summary.draws} D`,
      ];
      for (const [i, value] of cells.entries()) {
        const cell = document.createElement("span");
        cell.className = `profile-record__${["rank", "rating", "w", "l", "d"][i]}`;
        cell.textContent = value;
        line.append(cell);
      }
      this.recordRowsEl.append(line);
      const detail = document.createElement("p");
      detail.className = "profile-stats__detail";
      const totals = summary.totals;
      detail.textContent = totals
        ? `${totals.frags} frags · ${totals.deaths} deaths · ${Math.round(totals.damageGiven)} enemy damage · ${Math.round(totals.activeTimeMs / 60000)} min active${mode.id === "snd" ? ` · ${totals.plants} plants · ${totals.defuses} defuses` : ""}${summary.statsMatches < summary.matches ? ` · stats available for ${summary.statsMatches}/${summary.matches} matches` : ""}`
        : summary.matches
          ? "Gameplay totals unavailable for these results."
          : "No completed matches counted yet.";
      this.recordRowsEl.append(detail);
    }
    this.recordStatusEl.textContent = `${matches} ${scope} ${matches === 1 ? "match" : "matches"}${pending ? ` · ${pending} await calibration` : ""}${excluded ? ` · ${excluded} not rated` : ""}${failure ? ` · ${failure}` : ""}`;
    if (this.historyMode) void this.refreshHistory();
  }

  private async refreshHistory(beforeSequence?: number): Promise<void> {
    if (!this.historyMode) return;
    const sequence = ++this.historySeq,
      gametype = this.historyMode,
      scope = this.recordScope;
    this.historyEl.textContent = "Reading your recent matches…";
    const result = await newUiApi.getMatchHistory({ gametype, scope, limit: 10, beforeSequence });
    if (sequence !== this.historySeq) return;
    this.historyEl.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = `${gametype.toUpperCase()} · ${scope} recent matches`;
    this.historyEl.append(heading);
    if (result.status !== "ready") {
      const status = document.createElement("p");
      status.textContent = result.reason;
      this.historyEl.append(status);
      return;
    }
    if (!result.data.entries.length) {
      const empty = document.createElement("p");
      empty.textContent = "No match results yet.";
      this.historyEl.append(empty);
    }
    for (const entry of result.data.entries) {
      const row = document.createElement("article");
      row.className = "profile-history__match";
      const title = document.createElement("strong");
      title.textContent = `${entry.map} · ${entry.outcome ?? "aborted"} · ${new Date(entry.endedAt).toLocaleString()}`;
      const stats = document.createElement("p");
      stats.textContent = entry.stats
        ? `Score ${entry.stats.score} · ${entry.stats.frags} frags / ${entry.stats.deaths} deaths · ${Math.round(entry.stats.damageGiven)} enemy damage`
        : `Result score ${entry.score} · gameplay stats unavailable`;
      const rating = document.createElement("p");
      rating.textContent = entry.ratingChange
        ? `Rating ${entry.ratingChange.before} → ${entry.ratingChange.after} (${entry.ratingChange.delta >= 0 ? "+" : ""}${entry.ratingChange.delta})`
        : ratingFeedback(entry.ratingStatus, entry.ratingReason);
      row.append(title, stats, rating);
      this.historyEl.append(row);
    }
    const addKey = (label: string, cursor?: number) => {
      const key = createRaisedKey({ label });
      key.addEventListener("click", () => void this.refreshHistory(cursor));
      this.historyEl.append(key);
    };
    if (beforeSequence) addKey("Latest matches");
    if (result.data.nextBeforeSequence !== null) addKey("Older matches", result.data.nextBeforeSequence);
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
    this.recordSeq++;
    this.historySeq++;
    this.opened = false;
    document.removeEventListener("keydown", this.onKeyDown, true);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.root.remove();
  }
}
