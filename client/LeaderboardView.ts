/**
 * The leaderboard: a podium and the rest of the top ten for the last 30 days or
 * all time, or the whole top 100 with a search; your own rank in every mode in
 * the rail. Every row comes from the lobby's ranking query. Nothing is shown the
 * lobby does not know: it keeps wins, losses and draws, so there is no K/D.
 */

import { createRaisedKey, injectRaisedKeyStyles } from "../../../engine/ui/components/RaisedKey";
import { UIStyles } from "../../../engine/ui/UIStyles";
import { currentIdentity } from "../../../lobby/AccountSession";
import type { RankingScope } from "../../../lobby/types";
import { RATING_POLICY } from "../../../shared/ranking/RatingPolicy";
import { type LeaderboardPage, newUiApi } from "./NewUiApi";
import leaderboardCss from "./styles/Leaderboard.css?raw";

/** A mode the lobby ranks, with the colours its keys are drawn in. */
export interface RankedMode {
  id: string;
  title: string;
  /** Face, highlight, shade and the two side tones: the stage's accent. */
  accent: readonly string[];
  /** The mode's own mark, for its key's underline and its dot. */
  mark: string;
}

type Entry = LeaderboardPage["entries"][number];
type Period = "month" | "all";
type Tab = Period | "list";

const TABS: Array<{ id: Tab; name: string; sub: string }> = [
  { id: "month", name: "Last 30 days", sub: "Rolling · never resets" },
  { id: "all", name: "All time", sub: "Since launch" },
  { id: "list", name: "Top 100", sub: "The full list" },
];
const PERIOD_NAME: Record<Period, string> = { month: "30 days", all: "All time" };
const ACCENT_PROPERTIES = ["--accent", "--accent-hi", "--accent-lo", "--accent-side-hi", "--accent-side-lo"];
const AVATAR_COLORS = [
  "hsl(182 95% 62%)",
  "hsl(322 95% 70%)",
  "hsl(125 70% 62%)",
  "hsl(276 90% 76%)",
  "hsl(28 100% 64%)",
  "hsl(200 90% 68%)",
  "hsl(350 90% 70%)",
  "hsl(52 100% 64%)",
];

type Loaded = { state: "loading" } | { state: "ready"; page: LeaderboardPage } | { state: "failed"; reason: string };

const RANKING_SCOPE_SETTING = "shag.leaderboard.scope";

function readRankingScope(): RankingScope {
  try {
    return localStorage.getItem(RANKING_SCOPE_SETTING) === "private" ? "private" : "public";
  } catch {
    return "public";
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const played = (entry: Entry) => entry.wins + entry.losses + entry.draws;
const ratingText = (entry: Entry) => `${entry.rating}${entry.provisional ? " · Provisional" : ""}`;

function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/**
 * A measured skill gap, never a prediction of how many wins it takes.
 */
export function nextStep(entries: readonly Entry[], you: Entry, limit: number): string {
  if (you.rank === 1) return "On top. Hold it";
  const target = you.rank <= limit ? [...entries].reverse().find((entry) => entry.rank < you.rank) : entries[limit - 1];
  if (!target || target.conservativeScore === undefined || you.conservativeScore === undefined) return "";
  const gap = Math.max(0, Math.ceil((target.conservativeScore - you.conservativeScore) * RATING_POLICY.displayScale));
  return `${gap} rating ${gap === 1 ? "point" : "points"} behind #${target.rank}`;
}

export class LeaderboardView {
  readonly root: HTMLElement;
  /** Your rank in each mode: the rail's middle while this page is open. */
  readonly railMiddle: HTMLElement;

  private mode: RankedMode;
  private tab: Tab = "month";
  private listPeriod: Period = "month";
  private query = "";
  private scope = readRankingScope();
  private readonly boards = new Map<string, Loaded>();
  private readonly ranks = new Map<string, Loaded>();
  /** Bumped when the connection or the lobby's answer may have changed: late replies are dropped. */
  private generation = 0;

  private readonly kicker: HTMLElement;
  private readonly title: HTMLElement;
  private readonly ghost: HTMLElement;
  private readonly modeKeys = new Map<string, HTMLButtonElement>();
  private readonly scopeKeys = new Map<RankingScope, HTMLButtonElement>();
  private readonly tabKeys = new Map<Tab, HTMLButtonElement>();
  private readonly rule: HTMLElement;
  private readonly status: HTMLElement;
  private readonly podiumPane: HTMLElement;
  private readonly podium: HTMLElement;
  private readonly topHead: HTMLElement;
  private readonly topTen: HTMLElement;
  private readonly topPin: HTMLElement;
  private readonly listPane: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly jumpKey: HTMLButtonElement;
  private readonly periodKeys = new Map<Period, HTMLButtonElement>();
  private readonly list: HTMLElement;
  private readonly listPin: HTMLElement;
  private readonly railPeriod: HTMLElement;
  private readonly railRanks: HTMLElement;

  constructor(
    private readonly modes: readonly RankedMode[],
    light: HTMLElement,
  ) {
    injectRaisedKeyStyles();
    UIStyles.injectCSS("lobby-leaderboard", leaderboardCss);
    this.mode = modes[0];
    this.root = el("div", "lobby__page lobby__leaderboard lb-view");
    this.ghost = el("div", "lobby__ghost", "TOP");
    this.ghost.setAttribute("aria-hidden", "true");

    const head = el("header", "lobby__head-row");
    const heading = el("div");
    this.kicker = el("div", "lobby__kicker");
    this.title = el("h1", "lobby__title");
    heading.append(this.kicker, this.title);
    const modeRow = el("div", "lobby__modes");
    modeRow.setAttribute("role", "group");
    modeRow.setAttribute("aria-label", "Game mode");
    for (const mode of modes) {
      const key = el("button", "lobby__mode-key", mode.title);
      key.type = "button";
      key.style.setProperty("--m", mode.mark);
      key.addEventListener("click", () => this.setMode(mode));
      modeRow.append(key);
      this.modeKeys.set(mode.id, key);
    }
    const filters = el("div", "lb-filters");
    const scopes = el("div", "lb-scopes");
    scopes.setAttribute("role", "group");
    scopes.setAttribute("aria-label", "Ranking scope");
    for (const scope of ["public", "private"] as const) {
      const key = el("button", "lobby__mode-key", scope === "public" ? "Public" : "Private");
      key.type = "button";
      key.dataset.scope = scope;
      key.addEventListener("click", () => {
        this.scope = scope;
        try {
          localStorage.setItem(RANKING_SCOPE_SETTING, scope);
        } catch {
          // Selection still works when browser storage is unavailable.
        }
        this.render();
        void this.load();
      });
      scopes.append(key);
      this.scopeKeys.set(scope, key);
    }
    filters.append(scopes, modeRow);
    head.append(heading, filters);

    const tabs = el("div", "lobby__boards");
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Board");
    for (const tab of TABS) {
      const key = createRaisedKey({
        variants: ["tab"],
        content: [el("span", "lobby__board-name", tab.name), el("span", "lobby__board-sub", tab.sub)],
      });
      key.addEventListener("click", () => {
        this.tab = tab.id;
        this.render();
        void this.load();
      });
      tabs.append(key);
      this.tabKeys.set(tab.id, key);
    }

    this.rule = el("div", "lobby__rule");
    this.status = el("p", "lb-status");
    this.status.setAttribute("role", "status");

    this.podiumPane = el("section", "lb-pane");
    this.podium = el("div", "lb-podium");
    const topBoard = el("div", "lb-board");
    this.topHead = el("div", "lb-rows");
    this.topHead.append(this.headRow());
    this.topTen = el("div", "lb-rows lb-rows--scroll");
    this.topPin = el("div", "lb-board__foot");
    this.topPin.setAttribute("aria-label", "Your position");
    topBoard.append(this.topHead, this.topTen, this.topPin);
    this.podiumPane.append(this.podium, topBoard);

    this.listPane = el("section", "lb-pane");
    const toolbar = el("div", "lb-toolbar");
    this.search = el("input", "lobby__find");
    this.search.type = "search";
    this.search.placeholder = "Find a player…";
    this.search.autocomplete = "off";
    this.search.spellcheck = false;
    this.search.setAttribute("aria-label", "Find a player in the top 100");
    this.search.addEventListener("input", () => {
      this.query = this.search.value;
      this.renderBoard();
    });
    this.jumpKey = createRaisedKey({ label: "Jump to me", variants: ["sm", "cream", "inline"] });
    this.jumpKey.addEventListener("click", () => this.jumpToMe());
    const periods = el("div", "lb-period");
    periods.setAttribute("role", "group");
    periods.setAttribute("aria-label", "Period");
    for (const period of ["month", "all"] as const) {
      const key = el("button", "", PERIOD_NAME[period]);
      key.type = "button";
      key.addEventListener("click", () => {
        this.listPeriod = period;
        this.render();
        void this.load();
      });
      periods.append(key);
      this.periodKeys.set(period, key);
    }
    toolbar.append(this.search, this.jumpKey, periods);
    const listBoard = el("div", "lb-board lb-board--full");
    const listHead = el("div", "lb-rows");
    listHead.append(this.headRow());
    this.list = el("div", "lb-rows lb-rows--scroll");
    this.listPin = el("div", "lb-board__foot");
    this.listPin.setAttribute("aria-label", "Your position");
    listBoard.append(listHead, this.list, this.listPin);
    this.listPane.append(toolbar, listBoard);

    this.root.append(light, this.ghost, head, tabs, this.rule, this.status, this.podiumPane, this.listPane);

    this.railMiddle = el("section", "lobby__rail-mid lb-rail");
    this.railMiddle.setAttribute("aria-label", "Your ranks");
    const railHead = el("div", "lobby__rail-label");
    this.railPeriod = el("span");
    railHead.append(el("span", "", "Your ranks"), this.railPeriod);
    this.railRanks = el("div", "lb-rail__ranks");
    this.railMiddle.append(railHead, this.railRanks);

    this.setMode(this.mode, false);
  }

  /** The page came into view, or the lobby connection changed: ask again. */
  async refresh(): Promise<void> {
    this.generation++;
    this.boards.clear();
    this.ranks.clear();
    this.render();
    await this.load();
  }

  /** The connection went: forget everything it said. */
  clear(): void {
    this.generation++;
    this.boards.clear();
    this.ranks.clear();
    this.render();
  }

  destroy(): void {
    this.generation++;
  }

  private get period(): Period {
    return this.tab === "list" ? this.listPeriod : this.tab;
  }

  private setMode(mode: RankedMode, fetch = true): void {
    this.mode = mode;
    ACCENT_PROPERTIES.forEach((property, index) => {
      this.root.style.setProperty(property, mode.accent[index]);
    });
    this.render();
    if (fetch) void this.load();
  }

  // ── Data ──

  private boardKey(modeId: string, period: Period): string {
    return `${modeId}:${period}:${this.scope}`;
  }

  /** Fetch the board and ranks missing from the selected ranking's cache. */
  private async load(): Promise<void> {
    if (newUiApi.getFeatureStatus("leaderboard").status !== "ready") {
      this.render();
      return;
    }
    const generation = this.generation;
    const period = this.period;
    const wanted: Array<Promise<void>> = [];
    const boardKey = this.boardKey(this.mode.id, period);
    if (!this.boards.has(boardKey))
      wanted.push(this.fetch(this.boards, boardKey, this.mode.id, period, 100, generation, this.scope));
    for (const mode of this.modes) {
      const key = this.boardKey(mode.id, period);
      // A full board already carries your row
      if (!this.ranks.has(key) && !this.boards.has(key)) {
        wanted.push(this.fetch(this.ranks, key, mode.id, period, 1, generation, this.scope));
      }
    }
    this.render();
    await Promise.all(wanted);
  }

  private async fetch(
    into: Map<string, Loaded>,
    key: string,
    gametype: string,
    period: Period,
    limit: number,
    generation: number,
    scope: RankingScope,
  ): Promise<void> {
    into.set(key, { state: "loading" });
    const result = await newUiApi.getLeaderboard({ gametype, period, offset: 0, limit, scope });
    if (generation !== this.generation) return;
    into.set(
      key,
      result.status === "ready" ? { state: "ready", page: result.data } : { state: "failed", reason: result.reason },
    );
    this.render();
  }

  /** Your row in a mode and period, from a full board or a rank-only reply. */
  private yours(modeId: string, period: Period): { loaded: Loaded | undefined; you: Entry | null } {
    const key = this.boardKey(modeId, period);
    const loaded = this.boards.get(key) ?? this.ranks.get(key);
    if (loaded?.state !== "ready") return { loaded, you: null };
    const id = currentIdentity()?.id;
    const entry = loaded.page.localPlayerEntry;
    return { loaded, you: entry && id && entry.playerId === id ? entry : null };
  }

  // ── Drawing ──

  private render(): void {
    const tab = TABS.find((item) => item.id === this.tab) ?? TABS[0];
    this.kicker.textContent = `Leaderboard · ${this.scope === "public" ? "Public" : "Private"} · ${this.mode.title}`;
    for (const [scope, key] of this.scopeKeys) {
      key.classList.toggle("is-on", scope === this.scope);
      key.setAttribute("aria-pressed", String(scope === this.scope));
    }
    this.title.textContent = tab.name;
    for (const [id, key] of this.modeKeys) {
      key.classList.toggle("is-on", id === this.mode.id);
      key.setAttribute("aria-pressed", String(id === this.mode.id));
    }
    for (const [id, key] of this.tabKeys) {
      key.classList.toggle("is-open", id === this.tab);
      key.setAttribute("aria-pressed", String(id === this.tab));
    }
    for (const [period, key] of this.periodKeys) {
      key.classList.toggle("is-on", period === this.listPeriod);
      key.setAttribute("aria-pressed", String(period === this.listPeriod));
    }
    this.podiumPane.hidden = this.tab === "list";
    this.listPane.hidden = this.tab !== "list";
    this.renderBoard();
    this.renderRail();
  }

  private renderBoard(): void {
    const availability = newUiApi.getFeatureStatus("leaderboard");
    const loaded = this.boards.get(this.boardKey(this.mode.id, this.period));
    // Rows from a lobby that can no longer rank are not shown as if it could
    const page = availability.status === "ready" && loaded?.state === "ready" ? loaded.page : null;
    this.rule.textContent = `Career skill rating · provisional ratings include uncertainty${page?.total ? ` · ${page.total} ranked` : ""}`;

    let status = "";
    if (availability.status !== "ready") status = availability.reason;
    else if (loaded?.state === "failed") status = loaded.reason;
    else if (!page) status = "Loading rankings…";
    else if (page.total === 0)
      status = `No ranked ${this.mode.title} matches ${this.period === "month" ? "in the last 30 days" : "yet"}.`;
    if (page?.localProcessing?.pending)
      status += `${status ? " " : ""}${page.localProcessing.pending} of your matches await bot calibration.`;
    if (page?.localProcessing?.excluded)
      status += `${status ? " " : ""}${page.localProcessing.excluded} of your matches did not qualify for skill rating.`;
    this.status.textContent = status;
    this.status.hidden = status === "";

    const entries = page?.entries ?? [];
    const you = page ? this.yours(this.mode.id, this.period).you : null;
    if (this.tab === "list") this.renderList(entries, you, page !== null && page.total > 0);
    else this.renderPodium(entries, you);
  }

  private renderPodium(entries: readonly Entry[], you: Entry | null): void {
    const top = entries.slice(0, 3);
    this.podium.replaceChildren(...[top[1], top[0], top[2]].filter(Boolean).map((entry) => this.plinth(entry)));
    this.podium.hidden = top.length === 0;
    const rest = entries.slice(3, 10);
    this.topTen.replaceChildren(...rest.map((entry) => this.row(entry)));
    this.topHead.hidden = rest.length === 0;
    const pinned = you !== null && you.rank > 10;
    this.topPin.replaceChildren(...(pinned && you ? [this.youRow(entries, you, 10)] : []));
    this.topPin.hidden = !pinned;
    this.topTen.parentElement!.hidden = rest.length === 0 && !pinned;
  }

  private renderList(entries: readonly Entry[], you: Entry | null, ranked: boolean): void {
    const query = this.query.trim().toLocaleLowerCase();
    const shown = query ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query)) : entries;
    if (shown.length) this.list.replaceChildren(...shown.map((entry) => this.row(entry)));
    else if (query && ranked) {
      this.list.replaceChildren(el("div", "lb-rows__empty", `Nobody in the top 100 goes by “${this.query.trim()}”`));
    } else this.list.replaceChildren();
    this.listPin.replaceChildren(...(you ? [this.youRow(entries, you, 100)] : []));
    this.listPin.hidden = you === null;
    this.jumpKey.hidden = !you || !entries.some((entry) => entry.playerId === you.playerId);
    this.listPane.querySelector<HTMLElement>(".lb-board")!.hidden = !ranked;
    this.search.disabled = !ranked;
  }

  private renderRail(): void {
    this.railPeriod.textContent = PERIOD_NAME[this.period];
    const availability = newUiApi.getFeatureStatus("leaderboard");
    if (availability.status !== "ready") {
      this.railRanks.replaceChildren(el("p", "lobby__rail-empty", availability.reason));
      return;
    }
    this.railRanks.replaceChildren(
      ...this.modes.map((mode) => {
        const { loaded, you } = this.yours(mode.id, this.period);
        const standing = !loaded || loaded.state === "loading" ? "…" : you ? `#${you.rank}` : "—";
        const record =
          loaded?.state === "failed"
            ? "Unavailable"
            : you
              ? ratingText(you)
              : loaded?.state === "ready"
                ? "Unranked"
                : "";
        const dot = el("span", "lobby__room-mark");
        const name = el("span", "raised-key__label", mode.title);
        const detail = el("span", "lobby__room-map lb-rail__record", record);
        const rank = el("span", "raised-key__hint lobby__room-count", standing);
        const key = createRaisedKey({ variants: ["sm", "cream", "room"], content: [dot, name, detail, rank] });
        key.classList.add("lb-rail__rank");
        key.style.setProperty("--mode-mark", mode.mark);
        key.setAttribute("aria-pressed", String(mode.id === this.mode.id));
        key.setAttribute(
          "aria-label",
          `${mode.title}: ${you ? `rank ${you.rank}, rating ${ratingText(you)}` : record || "loading"}`,
        );
        key.addEventListener("click", () => this.setMode(mode));
        return key;
      }),
    );
  }

  private headRow(): HTMLElement {
    const row = el("div", "lb-row lb-row--head");
    row.setAttribute("aria-hidden", "true");
    row.append(
      el("span", "", "Rank"),
      el("span", "", "Player"),
      el("span", "lb-num is-key", "Rating"),
      el("span", "lb-num", "W / L / D"),
      el("span", "lb-num", "Matches"),
      el("span", "lb-num", "Rated"),
    );
    return row;
  }

  private row(entry: Entry): HTMLElement {
    const isYou = entry.playerId === currentIdentity()?.id;
    const row = el("div", `lb-row${entry.rank <= 3 ? ` lb-row--${entry.rank}` : ""}${isYou ? " is-you" : ""}`);
    row.dataset.rank = String(entry.rank);
    const who = el("span", "lb-row__who");
    const avatar = el("span", "lb-row__av", entry.name.slice(0, 1).toUpperCase());
    avatar.setAttribute("aria-hidden", "true");
    avatar.style.setProperty("--c", isYou ? "var(--gold-text)" : avatarColor(entry.name));
    who.append(avatar, el("span", "lb-row__name", entry.name));
    if (isYou) who.append(el("span", "lb-row__you", "You"));
    if (entry.provisional) who.append(el("span", "lb-row__note", "Provisional"));
    row.append(
      el("span", "lb-row__rank", `#${entry.rank}`),
      who,
      el("span", "lb-num is-key", String(entry.rating)),
      el("span", "lb-num", `${entry.wins} / ${entry.losses} / ${entry.draws}`),
      el("span", "lb-num", String(played(entry))),
      el("span", "lb-num", String(entry.ratedMatches)),
    );
    return row;
  }

  /** You, under the board, with what the next step takes. */
  private youRow(entries: readonly Entry[], you: Entry, limit: number): HTMLElement {
    const row = this.row(you);
    const note = nextStep(entries, you, limit);
    if (note) row.querySelector(".lb-row__who")?.append(el("span", "lb-row__note", note));
    return row;
  }

  private plinth(entry: Entry): HTMLElement {
    const isYou = entry.playerId === currentIdentity()?.id;
    const plinth = el("article", `lb-plinth lb-plinth--${Math.min(entry.rank, 3)}${isYou ? " is-you" : ""}`);
    const face = el("div", "lb-plinth__face");
    face.append(el("span", "lb-plinth__rank", String(entry.rank)));
    if (entry.rank === 1) face.append(el("span", "lb-plinth__tag", this.period === "month" ? "Leading" : "Champion"));
    if (isYou) face.append(el("span", "lb-plinth__tag", "You"));
    const wins = el("span", "lb-plinth__wins", String(entry.rating));
    wins.append(el("small", "", "rating"));
    const count = played(entry);
    face.append(
      el("span", "lb-plinth__name", entry.name),
      wins,
      el(
        "span",
        "lb-plinth__meta",
        `${entry.provisional ? "Provisional · " : ""}${entry.ratedMatches} rated · ${count} ${count === 1 ? "match" : "matches"} · ${entry.wins} W / ${entry.losses} L / ${entry.draws} D`,
      ),
    );
    const side = el("div", "lb-plinth__side");
    side.setAttribute("aria-hidden", "true");
    plinth.append(side, face);
    return plinth;
  }

  private jumpToMe(): void {
    this.query = "";
    this.search.value = "";
    this.renderBoard();
    const mine = this.list.querySelector<HTMLElement>(".lb-row.is-you");
    if (!mine) return;
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    mine.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
    mine.classList.remove("is-flash");
    void mine.offsetWidth;
    mine.classList.add("is-flash");
  }
}
