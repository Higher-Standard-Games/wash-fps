/**
 * ProfileView — the player's account, on the gold panel the Welcome screen uses:
 * the key that opens it from any browser first, then changing the name,
 * playing as someone else and deleting the account as screens of their own. The ranked record sits on
 * the stage beside the panel.
 *
 * The key never leaves the browser except to be copied or saved by the player;
 * the lobby only ever sees it at login. See docs/research/PLAYER_IDENTITY.md.
 */

import { PlayerProfile } from "../../../engine/player/PlayerProfile";
import { copyText } from "../../../engine/ui/CopyText";
import { createRaisedKey } from "../../../engine/ui/components/RaisedKey";
import { UIStyles } from "../../../engine/ui/UIStyles";
import {
  currentIdentity,
  deleteAccount,
  keyKeptElsewhere,
  LoginError,
  loginFailureText,
  playerKeyIsSessionOnly,
  renameAccount,
  renameFailureText,
  storedPlayerKey,
} from "../../../lobby/AccountSession";
import type { LobbyClient } from "../../../lobby/LobbyClient";
import { DELETED_ACCOUNT_NAME, formatKey, KEY_LENGTH, normalizeKey } from "../../../lobby/PlayerIdentity";
import type { GametypeInfo } from "../../../lobby/types";
import { isRatingMode, type RatingMode } from "../../../shared/ranking/RatingPolicy";
import { switchFpsAccount } from "./FpsLobbyService";
import { createSlot, judgeName, type Slot, wireKeySlot } from "./IdentityFields";
import { buildIdentityFrame, identityScreen, narrowOntoRail, widenFromRail } from "./IdentityFrame";
import { saveKeyFile } from "./KeyFile";
import { type LeaderboardPage, newUiApi } from "./NewUiApi";
import { ratingFeedback } from "./RatingFeedback";
import identityCSSRaw from "./styles/Identity.css?raw";

interface PasswordCredentialConstructor {
  new (data: { id: string; password: string; name?: string }): Credential;
}

export type ProfileScreen = "key" | "name" | "switch" | "delete";

export interface ProfileOptions {
  client: LobbyClient;
  isInRoom: () => boolean;
  modes: () => readonly GametypeInfo[];
  /** The panel has narrowed back onto the rail. */
  onClose?: () => void;
}

import { UINavigation } from "../../../engine/ui/navigation/UINavigation";

export class ProfileView {
  private offNavigation: (() => void) | null = null;
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
  private revealKey!: HTMLButtonElement;
  private keyAccountId: string | null = null;
  private keyActionsEl!: HTMLElement;
  private keyWarnEl!: HTMLElement;
  private keyStorageWarnEl!: HTMLElement;
  private keyMissingEl!: HTMLElement;
  private doneKey!: HTMLButtonElement;
  private nameSlot!: Slot;
  private renameKey!: HTMLButtonElement;
  private switchSlot!: Slot;
  private switchKey!: HTMLButtonElement;
  private switching = false;
  private deleteSlot!: Slot;
  private deleteAgree!: HTMLInputElement;
  private deleteKey!: HTMLButtonElement;
  private deleting = false;
  private recordStatusEl!: HTMLElement;
  private recordRowsEl!: HTMLElement;
  private recordSeq = 0;
  private historyEl!: HTMLElement;
  private historySeq = 0;
  private historyMode: RatingMode | null = null;
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
    this.hideKey();
    this.closing = false;
    this.root.classList.remove("welcome--leaving");
    parent.appendChild(this.root);
    this.offNavigation?.();
    this.offNavigation = UINavigation.getInstance().push({ root: this.root, back: () => this.close() });
    this.opened = true;
    document.addEventListener("keydown", this.onKeyDown, true);
    widenFromRail(this.root);
    this.refresh();
    this.show(screen);
  }

  /** Narrow back onto the rail. */
  close(): void {
    if (!this.opened || this.closing) return;
    this.hideKey();
    this.closing = true;
    this.opened = false;
    this.offNavigation?.();
    this.offNavigation = null;
    document.removeEventListener("keydown", this.onKeyDown, true);
    narrowOntoRail(this.root, () => {
      this.closing = false;
      this.onClose();
    });
  }

  private build(): HTMLElement {
    const frame = buildIdentityFrame("Profile", "");
    this.ghostEl = frame.ghost;
    frame.inner.append(
      this.buildKeyScreen(),
      this.buildNameScreen(),
      this.buildSwitchScreen(),
      this.buildDeleteScreen(),
    );
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
    } else if (screen === "switch") {
      this.refreshSwitchState();
      this.switchSlot.input.focus();
    } else {
      this.deleteAgree.checked = false;
      this.deleteSlot.input.value = "";
      this.refreshDeleteState();
      this.deleteAgree.focus();
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
    const screen = identityScreen("Your player key", ["Paste it on any computer to play as ", this.leadNameEl, "."]);
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
    this.revealKey = reveal;
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

    this.keyStorageWarnEl = document.createElement("p");
    this.keyStorageWarnEl.className = "identity-warn";
    this.keyStorageWarnEl.setAttribute("role", "status");
    this.keyStorageWarnEl.textContent =
      "Your key could not be saved in this browser. Copy it or save it as a file before reloading to keep this player.";

    this.keyMissingEl = document.createElement("p");
    this.keyMissingEl.className = "welcome__lead";
    this.keyMissingEl.textContent = "Your key is made the first time you reach the lobby.";

    this.doneKey = createRaisedKey({ label: "Done", variants: ["ink", "go"] });
    this.doneKey.addEventListener("click", () => this.close());
    const go = document.createElement("div");
    go.className = "welcome__go";
    go.appendChild(this.doneKey);

    screen.append(
      plate,
      actions,
      warn,
      this.keyStorageWarnEl,
      this.keyMissingEl,
      go,
      this.altRow("Not right?", [
        ["Change name", () => this.show("name")],
        ["Use another key", () => this.show("switch")],
      ]),
      this.altRow("Done with Washoi?", [["Delete account", () => this.show("delete")]]),
    );
    this.screens.set("key", screen);
    return screen;
  }

  private buildNameScreen(): HTMLElement {
    const form = identityScreen("Who are you?", "Everyone sees it: in rooms, chat and the rankings.");
    this.nameSlot = createSlot({
      id: "profile-name",
      label: "Your player name",
      maxLength: 16,
      counted: true,
      say: "2–16 characters: letters, numbers, _ and -",
    });
    this.renameKey = createRaisedKey({ label: "Save →", variants: ["ink", "go"] });
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
    this.switchKey = createRaisedKey({ label: "Use it →", variants: ["ink", "go"] });
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

  /**
   * Deleting is for good, so it takes two deliberate steps: ticking that you
   * understand, and pasting the whole key again. The lobby checks the key too.
   */
  private buildDeleteScreen(): HTMLElement {
    const form = identityScreen(
      "Delete this player?",
      `Your name becomes ${DELETED_ACCOUNT_NAME} on the leaderboards and in the demo list, your synced settings are erased, and your key stops working. Demos already recorded stay as they are.`,
    );
    const agree = document.createElement("label");
    agree.className = "identity-warn identity-agree";
    this.deleteAgree = document.createElement("input");
    this.deleteAgree.type = "checkbox";
    this.deleteAgree.addEventListener("change", () => this.refreshDeleteState());
    const strong = document.createElement("b");
    strong.textContent = "I understand this can't be undone.";
    const text = document.createElement("span");
    text.append(strong, " Nobody can bring this player, its name or its rankings back.");
    agree.append(this.deleteAgree, text);

    this.deleteSlot = createSlot({
      id: "profile-delete-key",
      label: "This player's key, to confirm",
      placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
      prefix: "WASHOI-",
      say: "Paste this player's whole key to confirm.",
    });
    this.deleteKey = createRaisedKey({ label: "Delete for good", variants: ["ink", "go"] });
    this.deleteKey.type = "submit";
    this.deleteKey.disabled = true;
    wireKeySlot(this.deleteSlot, () => this.refreshDeleteState());
    const go = document.createElement("div");
    go.className = "welcome__go";
    go.appendChild(this.deleteKey);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.deleteThisAccount();
    });
    form.append(
      agree,
      this.deleteSlot.root,
      go,
      this.altRow("Changed your mind?", [["Back to your key", () => this.show("key")]]),
    );
    form.hidden = true;
    this.screens.set("delete", form);
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
    head.append(title);
    this.recordStatusEl = document.createElement("p");
    this.recordStatusEl.className = "profile-record__status";
    this.recordStatusEl.setAttribute("role", "status");
    this.recordRowsEl = document.createElement("div");
    this.recordRowsEl.className = "profile-record__rows";
    record.append(head, this.recordStatusEl, this.recordRowsEl);
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
      this.recordText("Connect to the lobby to see your record.");
      return;
    }
    const availability = newUiApi.getFeatureStatus("leaderboard");
    if (availability.status !== "ready") {
      this.recordRowsEl.replaceChildren();
      this.recordText(availability.reason);
      return;
    }
    const modes = this.modes();
    if (modes.length === 0) {
      this.recordRowsEl.replaceChildren();
      this.recordText("This lobby is not advertising any mode.");
      return;
    }
    if (this.recordRowsEl.childElementCount === 0) this.recordText("Reading the rankings…");

    const asked = await Promise.all(
      modes.map(async (mode) => ({
        mode,
        result: await newUiApi.getLeaderboard({
          gametype: mode.id,
          period: "all",
          offset: 0,
          limit: 1,
        }),
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
      this.recordText(refusal || "No ranked match yet. Finish an eligible match to get a provisional rating.");
      return;
    }
    const played = standings.reduce((sum, { row }) => sum + row.wins + row.losses + row.draws, 0);
    const best = standings.reduce((top, one) => (one.row.rank < top.row.rank ? one : top));
    this.recordTotals([
      [played, played === 1 ? "match" : "matches"],
      [`#${best.row.rank}`, `in ${best.mode.name}`],
    ]);
    for (const { mode, row } of standings.sort((a, b) => a.row.rank - b.row.rank)) {
      const card = recordCard({
        modeId: mode.id,
        modeName: mode.name,
        rank: row.rank,
        rating: row.rating,
        provisional: row.provisional,
        wins: row.wins,
        losses: row.losses,
        draws: row.draws,
      });
      card.title = `${row.ratedMatches} rated ${row.ratedMatches === 1 ? "match" : "matches"}`;
      this.recordRowsEl.append(card);
    }
  }

  /** A sentence where the totals go: why there are none yet, or what went wrong. */
  private recordText(text: string): void {
    this.recordStatusEl.removeAttribute("aria-label");
    this.recordStatusEl.textContent = text;
  }

  /**
   * The totals over the cards, each on a plate in the campaign's style: the
   * first gold, the rest dark, each number large. A note (a mode that did not
   * answer) follows as text.
   */
  private recordTotals(parts: Array<[number | string, string]>, note = ""): void {
    const plates = parts.map(([value, label], index) => {
      const plate = document.createElement("span");
      plate.className = `profile-record__total campaign-plate${index > 0 ? " campaign-plate--dark" : ""}`;
      const number = document.createElement("strong");
      number.textContent = String(value);
      plate.append(number, ` ${label}`);
      return plate;
    });
    const sentence = parts.map(([value, label]) => `${value} ${label}`).join(" · ");
    this.recordStatusEl.setAttribute("aria-label", note ? `${sentence} · ${note}` : sentence);
    this.recordStatusEl.replaceChildren(...plates);
    if (note) this.recordStatusEl.append(Object.assign(document.createElement("span"), { textContent: note }));
  }

  private async refreshStatsRecord(sequence: number): Promise<void> {
    const modes = this.modes().filter((mode) => isRatingMode(mode.id));
    const answers = await Promise.all(
      modes.map(async (mode) => ({
        mode,
        result: await newUiApi.getPlayerStats({ gametype: mode.id as RatingMode, scope: "overall", period: "all" }),
      })),
    );
    if (sequence !== this.recordSeq) return;
    this.recordRowsEl.replaceChildren();
    let matches = 0,
      failure = "";
    for (const { mode, result } of answers) {
      if (result.status !== "ready") {
        failure ||= result.reason;
        continue;
      }
      const summary = result.data;
      matches += summary.matches;
      if (!summary.matches && !summary.excluded && !summary.rating) continue;
      const totals = summary.totals;
      const stats: [number | string, string][] = totals
        ? [
            [totals.frags, "frags"],
            [totals.deaths, "deaths"],
            [Math.round(totals.damageGiven), "damage"],
            [playTime(totals.activeTimeMs), "played"],
            ...(mode.id === "snd"
              ? ([
                  [totals.plants, "plants"],
                  [totals.defuses, "defuses"],
                ] as [number, string][])
              : []),
          ]
        : [];
      const note = !totals
        ? summary.matches
          ? "Gameplay totals unavailable for these results."
          : "No completed matches counted yet."
        : summary.statsMatches < summary.matches
          ? `Totals from ${summary.statsMatches} of ${summary.matches} matches.`
          : "";
      this.recordRowsEl.append(
        recordCard({
          modeId: mode.id,
          modeName: mode.name,
          onHistory: () => {
            this.historyMode = mode.id as RatingMode;
            void this.refreshHistory();
          },
          rank: summary.rating?.rank,
          rating: summary.rating?.value,
          provisional: summary.rating?.provisional,
          wins: summary.wins,
          losses: summary.losses,
          draws: summary.draws,
          stats,
          note,
        }),
      );
    }
    this.recordTotals([[matches, matches === 1 ? "match" : "matches"]], failure);
    if (this.historyMode) void this.refreshHistory();
  }

  private async refreshHistory(beforeSequence?: number): Promise<void> {
    if (!this.historyMode) return;
    const sequence = ++this.historySeq,
      gametype = this.historyMode;
    this.historyEl.textContent = "Reading your recent matches…";
    const result = await newUiApi.getMatchHistory({ gametype, scope: "overall", limit: 10, beforeSequence });
    if (sequence !== this.historySeq) return;
    this.historyEl.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = `${gametype.toUpperCase()} · recent matches`;
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
  private hideKey(): void {
    this.keyPlateEl.classList.add("keyplate--hidden");
    this.revealKey.textContent = "Show";
    this.revealKey.setAttribute("aria-pressed", "false");
  }

  refresh(): void {
    const accountId = currentIdentity()?.id ?? null;
    if (accountId !== this.keyAccountId) {
      this.hideKey();
      this.keyAccountId = accountId;
    }
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
    this.keyMissingEl.textContent = keyKeptElsewhere()
      ? "Your key was shown when this player was made here, and isn't kept in this browser. Paste it under Use another key to play as this player anywhere else."
      : "Your key is made the first time you reach the lobby.";
    this.keyStorageWarnEl.hidden = !key || !playerKeyIsSessionOnly();

    if (document.activeElement !== this.nameSlot.input) this.nameSlot.setValue(name);
    this.refreshNameState();
    this.refreshSwitchState();
    this.refreshDeleteState();
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

  /** Whether the pasted key is whole and, when this browser has the key, the same one. */
  private deleteKeyMatches(): boolean {
    const pasted = normalizeKey(this.deleteSlot.input.value);
    const stored = storedPlayerKey();
    return !!pasted && (!stored || normalizeKey(stored) === pasted);
  }

  private refreshDeleteState(): void {
    const pasted = normalizeKey(this.deleteSlot.input.value);
    const inRoom = this.isInRoom();
    const offline = !this.client.connected || !currentIdentity();
    this.deleteKey.disabled =
      this.deleting || inRoom || offline || !this.deleteAgree.checked || !this.deleteKeyMatches();
    if (this.deleting) return;
    if (inRoom) this.deleteSlot.tell("Leave your room before deleting your account.");
    else if (offline) this.deleteSlot.tell("Connect to the lobby to delete your account.");
    else if (pasted && !this.deleteKeyMatches()) this.deleteSlot.tell("That isn't this player's key.", "bad");
    else if (pasted && !this.deleteAgree.checked) this.deleteSlot.tell("Tick the box above to go on.");
  }

  private async deleteThisAccount(): Promise<void> {
    if (!this.deleteAgree.checked || !this.deleteKeyMatches()) return;
    this.deleting = true;
    this.deleteKey.disabled = true;
    this.deleteSlot.tell("Asking the lobby…");
    const outcome = await deleteAccount(this.deleteSlot.input.value, this.deleteAgree.checked);
    this.deleting = false;
    if (!outcome.ok) {
      this.refreshDeleteState();
      this.deleteSlot.tell(renameFailureText(outcome.code), "bad");
      return;
    }
    this.deleteSlot.input.value = "";
    this.deleteAgree.checked = false;
    this.deleteKey.disabled = true;
    this.deleteSlot.tell("Your account is deleted. Starting over as a new player…", "ok");
    // A fresh page makes a fresh player, the way a first visit does
    setTimeout(() => location.reload(), 2000);
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
      answer = err instanceof LoginError ? loginFailureText(err.code) : "The lobby didn't answer. Try again.";
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
    this.said(button, (await copyText(formatKey(key))) ? "Copied ✓" : "Copy blocked");
  }

  private saveKeyFile(): void {
    const key = storedPlayerKey();
    if (!key) return;
    saveKeyFile(currentIdentity()?.name ?? PlayerProfile.load().name, key);
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
    this.offNavigation?.();
    this.recordSeq++;
    this.historySeq++;
    this.opened = false;
    document.removeEventListener("keydown", this.onKeyDown, true);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.root.remove();
  }
}

interface RecordCardFacts {
  modeId: string;
  modeName: string;
  /** Opens the mode's recent matches; without it the name is plain text. */
  onHistory?: () => void;
  rank?: number;
  rating?: number;
  provisional?: boolean;
  wins: number;
  losses: number;
  draws: number;
  /** Totals as [value, what], each drawn as a big number with its word. */
  stats?: [number | string, string][];
  note?: string;
}

/**
 * One mode's record: its name and rank, the rating, a bar of wins against
 * losses and draws, and the totals as big numbers.
 */
function recordCard(facts: RecordCardFacts): HTMLElement {
  const card = document.createElement("article");
  card.className = "profile-card";
  card.dataset.mode = facts.modeId;

  const head = document.createElement("div");
  head.className = "profile-card__head";
  let name: HTMLElement;
  if (facts.onHistory) {
    const key = document.createElement("button");
    key.type = "button";
    key.className = "profile-card__mode profile-card__history-key";
    key.title = `Show recent ${facts.modeName} matches`;
    key.addEventListener("click", facts.onHistory);
    name = key;
  } else {
    name = document.createElement("span");
    name.className = "profile-card__mode";
  }
  name.textContent = facts.modeName;
  const rank = document.createElement("span");
  rank.className = "profile-card__rank";
  rank.textContent = facts.rank === undefined ? "" : `#${facts.rank}`;
  head.append(name, rank);

  const rating = document.createElement("p");
  rating.className = "profile-card__rating";
  if (facts.rating === undefined) rating.textContent = "Not rated";
  else {
    const value = document.createElement("strong");
    value.textContent = String(facts.rating);
    rating.append(value, ` rating${facts.provisional ? " · provisional" : ""}`);
  }

  const record = document.createElement("div");
  record.className = "profile-card__record";
  const bar = document.createElement("div");
  bar.className = "profile-card__bar";
  bar.setAttribute("aria-hidden", "true");
  for (const [count, kind] of [
    [facts.wins, "wins"],
    [facts.draws, "draws"],
    [facts.losses, "losses"],
  ] as const) {
    if (count <= 0) continue;
    const part = document.createElement("span");
    part.className = `profile-card__bar-${kind}`;
    part.style.flexGrow = String(count);
    bar.append(part);
  }
  const counts = document.createElement("span");
  counts.className = "profile-card__counts";
  counts.textContent = `${facts.wins} ${facts.wins === 1 ? "win" : "wins"} · ${facts.losses} ${facts.losses === 1 ? "loss" : "losses"}${facts.draws ? ` · ${facts.draws} ${facts.draws === 1 ? "draw" : "draws"}` : ""}`;
  record.append(bar, counts);

  card.append(head, rating, record);
  if (facts.stats?.length) {
    const stats = document.createElement("ul");
    stats.className = "profile-card__stats";
    for (const [value, what] of facts.stats) {
      const item = document.createElement("li");
      const number = document.createElement("strong");
      number.textContent = typeof value === "number" ? value.toLocaleString("en-US") : value;
      item.append(number, ` ${what}`);
      stats.append(item);
    }
    card.append(stats);
  }
  if (facts.note) {
    const note = document.createElement("p");
    note.className = "profile-card__note";
    note.textContent = facts.note;
    card.append(note);
  }
  return card;
}

/** Active time as hours and minutes: "2h 14m", "54m". */
function playTime(ms: number): string {
  const minutes = Math.round(ms / 60000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
