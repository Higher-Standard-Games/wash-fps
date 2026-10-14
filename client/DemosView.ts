/**
 * Demos: this week's featured matches, the latest recordings, and yours, with
 * the maps in the rail. Everything shown is in the recording's header — map,
 * mode, who played, how long, when, how big. A header has no score, team or
 * rank, so a card has none either.
 */

import { CameraSystem } from "../../../engine/camera/CameraSystem";
import { createRaisedKey, injectRaisedKeyStyles, setRaisedKeyText } from "../../../engine/ui/components/RaisedKey";
import { rememberMapTitle } from "../../../engine/ui/MapTitles";
import { UIStyles } from "../../../engine/ui/UIStyles";
import type { LobbyClient } from "../../../lobby/LobbyClient";
import type { DemoInfo } from "../../../lobby/types";
import { DemoService } from "./DemoService";
import { DemoViewer } from "./DemoViewer";
import type { RankedMode } from "./LeaderboardView";
import { type FeaturedDemo, newUiApi } from "./NewUiApi";
import demosCss from "./styles/Demos.css?raw";

export type DemoScope = "latest" | "yours";
type Tab = "featured" | DemoScope;

/** Demos per page: three across and two down. */
export const DEMOS_PER_PAGE = 6;
/** How many recordings the lobby sends at once, newest first. */
export const DEMO_LIST_LIMIT = 64;
export const DEMO_ARCHIVE_TIMEOUT_MS = 10_000;
const FEATURED_LIMIT = 6;
const REEL_MINUTES = [1, 2, 5];
/** A reel is at most a third of its demo. */
const REEL_SHARE = 3;

/**
 * The reel lengths a demo can make: at most a third of its length. A demo under
 * three minutes (shorter than an Amphi round) has no reel; 3–6 minutes gives
 * 1 minute, 6–15 adds 2, and 15 or more adds 5.
 */
export function reelLengths(durationMs: number): number[] {
  return REEL_MINUTES.filter((minutes) => durationMs >= minutes * REEL_SHARE * 60_000);
}

const TOO_SHORT = "Too short for a highlight reel";

const ALL: RankedMode = {
  id: "all",
  title: "All",
  accent: ["hsl(276 90% 64%)", "hsl(278 95% 80%)", "hsl(268 75% 54%)", "hsl(262 70% 36%)", "hsl(256 70% 22%)"],
  mark: "hsl(276 90% 72%)",
};
const ACCENT_PROPERTIES = ["--accent", "--accent-hi", "--accent-lo", "--accent-side-hi", "--accent-side-lo"];

const TABS: Array<{ id: Tab; name: string; sub: string }> = [
  { id: "featured", name: "Featured", sub: "This week's best" },
  { id: "latest", name: "Latest", sub: "Every recorded match" },
  { id: "yours", name: "Yours", sub: "Matches you played" },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Deathmatch recordings are free for all. */
export const demoMode = (demo: DemoInfo): string => (demo.gametype === "deathmatch" ? "ffa" : demo.gametype);
const mapName = (demo: DemoInfo) => demo.mapDisplayName || demo.map;
const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** How long ago, short for a card and the pick list, longer for the featured match. */
export function ago(date: number, short: boolean, now = Date.now()): string {
  const minutes = (now - date) / 60_000;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}${short ? "m" : " min"} ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}${short ? "h" : " h"} ago`;
  const days = Math.floor(minutes / (24 * 60));
  if (short && days < 7) return `${days}d ago`;
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(date).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The page numbers worth a key: all of them when few, else the ends and the neighbours. */
export function pageKeys(page: number, pages: number): number[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);
  return [...new Set([1, 2, page - 1, page, page + 1, pages - 1, pages])]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
}

export interface DemosHost {
  client: LobbyClient;
  modes: readonly RankedMode[];
  light: HTMLElement;
  /** A demo is starting: the menu gets out of the way. */
  leave(): void;
  /** Recover the menu if a validated recording fails during playback startup. */
  show?(): void;
}

export class DemosView {
  readonly root: HTMLElement;
  /** The maps, with how many recordings each: the rail's middle on this page. */
  readonly railMiddle: HTMLElement;

  private readonly modes: RankedMode[];
  private tab: Tab = "featured";
  private mode: RankedMode = ALL;
  private map: string | null = null;
  private query = "";
  private page = 1;

  private archive: DemoInfo[] = [];
  private archiveScope: DemoScope = "latest";
  private archiveRequested = false;
  private archiveArrived = false;
  private archiveFailed = false;
  private archiveRequestId: string | undefined;
  private archiveTimer: ReturnType<typeof setTimeout> | null = null;
  private ownership = false;

  private featured: FeaturedDemo[] = [];
  private featuredState: "idle" | "loading" | "ready" | "failed" = "idle";
  private featuredError = "";
  private featuredSeq = 0;
  private heroFile: string | null = null;
  private reelMinutes = 2;
  private readonly preloaded = new Set<string>();
  private playGeneration = 0;
  private pendingPlay: { controller: AbortController; restore: () => void } | null = null;
  private handingOff = false;
  private readonly transfer = el("div", "dm-transfer");
  private readonly transferText = el("span", "dm-transfer__text");
  private readonly transferAction = createRaisedKey({ label: "Cancel", variants: ["sm", "cream", "inline"] });

  private readonly kicker: HTMLElement;
  private readonly title: HTMLElement;
  private readonly rule: HTMLElement;
  private readonly modeKeys = new Map<string, HTMLButtonElement>();
  private readonly tabKeys = new Map<Tab, HTMLButtonElement>();
  private readonly featuredPane: HTMLElement;
  private readonly hero: HTMLElement;
  private readonly picks: HTMLElement;
  private readonly pickCount: HTMLElement;
  private readonly gridPane: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly pager: HTMLElement;
  private readonly mapCount: HTMLElement;
  private readonly mapList: HTMLElement;
  private readonly reel: HTMLElement;
  private reelDemo: { demo: DemoInfo; card: HTMLElement; key: HTMLButtonElement } | null = null;
  private readonly onDocumentDown = (event: MouseEvent) => {
    if (this.reelDemo && !(event.target as Element | null)?.closest?.(".dm-reel")) this.closeReel();
  };
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.reelDemo) {
      event.stopPropagation();
      this.closeReel(true);
    }
  };

  constructor(private readonly host: DemosHost) {
    injectRaisedKeyStyles();
    UIStyles.injectCSS("lobby-demos", demosCss);
    this.modes = [ALL, ...host.modes];

    this.root = el("div", "lobby__page lobby__demos dm-view");
    const ghost = el("div", "lobby__ghost", "REPLAY");
    ghost.setAttribute("aria-hidden", "true");

    const head = el("header", "lobby__head-row");
    const heading = el("div");
    this.kicker = el("div", "lobby__kicker");
    this.title = el("h1", "lobby__title");
    heading.append(this.kicker, this.title);
    const modeRow = el("div", "lobby__modes");
    modeRow.setAttribute("role", "group");
    modeRow.setAttribute("aria-label", "Game mode");
    for (const mode of this.modes) {
      const key = el("button", "lobby__mode-key", mode.title);
      key.type = "button";
      key.style.setProperty("--m", mode.mark);
      key.addEventListener("click", () => this.setMode(mode));
      modeRow.append(key);
      this.modeKeys.set(mode.id, key);
    }
    head.append(heading, modeRow);

    const tabs = el("div", "lobby__boards");
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Recordings");
    for (const tab of TABS) {
      const key = createRaisedKey({
        variants: ["tab"],
        content: [el("span", "lobby__board-name", tab.name), el("span", "lobby__board-sub", tab.sub)],
      });
      key.addEventListener("click", () => this.setTab(tab.id));
      tabs.append(key);
      this.tabKeys.set(tab.id, key);
    }
    this.rule = el("div", "lobby__rule");

    this.featuredPane = el("section", "dm-pane");
    const featured = el("div", "dm-featured");
    this.hero = el("article", "dm-slab dm-hero");
    const picksBox = el("aside", "dm-picks");
    const picksHead = el("div", "dm-picks__label");
    this.pickCount = el("span");
    picksHead.append(el("span", "", "This week's best"), this.pickCount);
    this.picks = el("div", "dm-picks__list");
    this.picks.setAttribute("role", "group");
    this.picks.setAttribute("aria-label", "Featured recordings");
    picksBox.append(picksHead, this.picks);
    featured.append(this.hero, picksBox);
    this.featuredPane.append(featured);

    this.gridPane = el("section", "dm-pane");
    const toolbar = el("div", "dm-toolbar");
    this.search = el("input", "lobby__find");
    this.search.type = "search";
    this.search.placeholder = "Find a player or map…";
    this.search.autocomplete = "off";
    this.search.spellcheck = false;
    this.search.setAttribute("aria-label", "Find a player or map");
    this.search.addEventListener("keydown", (event) => event.stopPropagation());
    this.search.addEventListener("input", () => {
      this.query = this.search.value;
      this.page = 1;
      this.renderGrid();
    });
    this.count = el("div", "dm-count");
    this.count.setAttribute("aria-live", "polite");
    toolbar.append(this.search, this.count);
    this.grid = el("div", "dm-grid");
    this.pager = el("nav", "dm-pager");
    this.pager.setAttribute("aria-label", "Pages");
    this.gridPane.append(toolbar, this.grid, this.pager);

    this.transfer.hidden = true;
    this.transferText.setAttribute("role", "status");
    this.transferText.setAttribute("aria-live", "polite");
    this.transfer.append(this.transferText, this.transferAction);
    this.root.append(host.light, ghost, head, tabs, this.rule, this.transfer, this.featuredPane, this.gridPane);

    this.railMiddle = el("section", "lobby__rail-mid dm-rail");
    this.railMiddle.setAttribute("aria-label", "Maps");
    const railHead = el("div", "lobby__rail-label");
    this.mapCount = el("span");
    railHead.append(el("span", "", "Maps"), this.mapCount);
    this.mapList = el("div", "dm-rail__maps");
    this.railMiddle.append(railHead, this.mapList);

    this.reel = el("div", "dm-reel");
    this.reel.hidden = true;
    this.reel.setAttribute("role", "dialog");
    this.reel.setAttribute("aria-label", "Highlight reel");
    document.body.append(this.reel);
    document.addEventListener("mousedown", this.onDocumentDown);
    document.addEventListener("keydown", this.onKeyDown, true);

    this.setMode(ALL, false);
  }

  // ── What the lobby says ──

  /** The page came into view: fetch what it shows. */
  show(): void {
    this.requestArchive(true);
    void this.requestFeatured();
    this.render();
  }

  /** A lobby said hello: what it can do, and nothing asked of an earlier one stands. */
  connected(ownership: boolean, visible: boolean): void {
    this.deactivate();
    this.clearArchiveRequest();
    this.archive = [];
    this.archiveArrived = false;
    this.archiveFailed = false;
    this.ownership = ownership;
    if (!ownership && this.tab === "yours") this.tab = "latest";
    if (!ownership) this.archiveScope = "latest";
    this.featuredState = "idle";
    this.archiveRequested = false;
    if (visible) this.show();
    else this.render();
  }

  disconnected(): void {
    this.deactivate();
    this.clearArchiveRequest();
    this.archiveFailed = false;
    this.ownership = false;
    if (this.tab === "yours") this.tab = "latest";
    this.archiveScope = "latest";
    this.archive = [];
    this.archiveRequested = false;
    this.archiveArrived = false;
    this.featuredSeq++;
    this.featured = [];
    this.featuredState = "idle";
    this.render();
  }

  /** A match finished: the featured picks may have changed. */
  matchEnded(): void {
    this.featuredState = "idle";
  }

  receiveList(scope: DemoScope, demos: DemoInfo[], requestId?: string): void {
    if (!this.archiveRequested || scope !== this.archiveScope || requestId !== this.archiveRequestId) return;
    this.clearArchiveRequest();
    this.archiveFailed = false;
    for (const demo of demos) rememberMapTitle(demo.map, demo.mapDisplayName);
    this.archive = demos;
    this.archiveRequested = false;
    this.archiveArrived = true;
    this.preload(demos);
    this.render();
  }

  destroy(): void {
    this.deactivate();
    this.clearArchiveRequest();
    this.featuredSeq++;
    this.closeReel();
    this.reel.remove();
    document.removeEventListener("mousedown", this.onDocumentDown);
    document.removeEventListener("keydown", this.onKeyDown, true);
  }

  /** Leaving the page cancels its file request, including delayed parsing. */
  deactivate(): void {
    if (!this.handingOff) this.playGeneration++;
    this.pendingPlay?.controller.abort();
    this.finishTransfer();
    this.transfer.hidden = true;
    this.transferAction.onclick = null;
    this.closeReel();
  }

  private finishTransfer(): void {
    this.pendingPlay?.restore();
    this.pendingPlay = null;
    this.root.removeAttribute("aria-busy");
    for (const key of this.root.querySelectorAll<HTMLButtonElement>("[data-demo-play]")) key.disabled = false;
  }

  private playKey(key: HTMLButtonElement): HTMLButtonElement {
    key.dataset.demoPlay = "";
    key.disabled = this.pendingPlay !== null;
    return key;
  }

  /**
   * A Highlights key: a play key while the demo is long enough for a reel. A
   * shorter one keeps its place, disabled for good, outside the play keys that
   * a finished transfer re-enables.
   */
  private reelKey(key: HTMLButtonElement, allowed: readonly number[]): HTMLButtonElement {
    if (allowed.length) return this.playKey(key);
    key.disabled = true;
    key.title = TOO_SHORT;
    return key;
  }

  // ── Asking ──

  private clearArchiveRequest(): void {
    if (this.archiveTimer !== null) clearTimeout(this.archiveTimer);
    this.archiveTimer = null;
    this.archiveRequested = false;
    this.archiveRequestId = undefined;
  }

  private requestArchive(force = false): void {
    const scope: DemoScope = this.tab === "yours" ? "yours" : this.tab === "latest" ? "latest" : this.archiveScope;
    if (!this.host.client.connected) return;
    if (scope !== this.archiveScope) {
      this.archiveScope = scope;
      this.archive = [];
      this.archiveArrived = false;
      force = true;
    }
    if (this.archiveRequested && !force) return;
    this.clearArchiveRequest();
    this.archiveFailed = false;
    this.archiveRequested = true;
    this.archiveRequestId = this.host.client.requestDemoList(DEMO_LIST_LIMIT, scope);
    this.archiveTimer = setTimeout(() => {
      this.clearArchiveRequest();
      this.archiveFailed = true;
      this.render();
    }, DEMO_ARCHIVE_TIMEOUT_MS);
  }

  private async requestFeatured(): Promise<void> {
    if (!this.host.client.connected || newUiApi.getFeatureStatus("featuredDemos").status !== "ready") return;
    if (this.featuredState === "loading" || this.featuredState === "ready") return;
    const seq = ++this.featuredSeq;
    this.featuredState = "loading";
    this.render();
    const result = await newUiApi.getFeaturedDemos({
      gametype: this.mode.id,
      map: this.map ?? "all",
      limit: FEATURED_LIMIT,
    });
    if (seq !== this.featuredSeq) return;
    if (result.status === "ready") {
      this.featured = result.data;
      this.featuredState = "ready";
      this.preload(result.data.map((entry) => entry.demo));
    } else {
      this.featured = [];
      this.featuredState = "failed";
      this.featuredError = result.reason;
    }
    this.render();
  }

  private preload(demos: DemoInfo[]): void {
    for (const demo of demos) {
      if (!demo.levelshot || this.preloaded.has(demo.levelshot)) continue;
      this.preloaded.add(demo.levelshot);
      const image = new Image();
      image.src = demo.levelshot;
    }
  }

  // ── Choosing ──

  private setMode(mode: RankedMode, fetch = true): void {
    this.mode = mode;
    ACCENT_PROPERTIES.forEach((property, index) => {
      this.root.style.setProperty(property, mode.accent[index]);
    });
    if (this.map && !this.inMode().some((demo) => demo.map === this.map)) this.map = null;
    this.page = 1;
    this.heroFile = null;
    this.refetchFeatured(fetch);
  }

  private setMap(map: string | null): void {
    this.map = map;
    this.page = 1;
    this.heroFile = null;
    this.refetchFeatured(true);
  }

  private refetchFeatured(fetch: boolean): void {
    this.featuredSeq++;
    this.featuredState = "idle";
    this.featured = [];
    if (fetch) void this.requestFeatured();
    this.render();
  }

  private setTab(tab: Tab): void {
    if (tab === "yours" && !this.ownership) return;
    if (tab !== this.tab) this.page = 1;
    this.tab = tab;
    this.requestArchive();
    if (tab === "featured") void this.requestFeatured();
    this.render();
  }

  private inMode(): DemoInfo[] {
    return this.archive.filter((demo) => this.mode.id === "all" || demoMode(demo) === this.mode.id);
  }

  private shownList(): DemoInfo[] {
    const query = this.query.trim().toLocaleLowerCase();
    return this.inMode()
      .filter((demo) => !this.map || demo.map === this.map)
      .filter(
        (demo) =>
          !query || `${demo.map} ${mapName(demo)} ${demo.players.join(" ")}`.toLocaleLowerCase().includes(query),
      )
      .sort((a, b) => b.date - a.date);
  }

  // ── Drawing ──

  private render(): void {
    const tab = TABS.find((item) => item.id === this.tab) ?? TABS[0];
    const mapLabel = this.map
      ? mapName(this.archive.find((demo) => demo.map === this.map) ?? ({ map: this.map } as DemoInfo))
      : "";
    this.kicker.textContent = ["Demos", this.mode.id === "all" ? "All modes" : this.mode.title, mapLabel]
      .filter(Boolean)
      .join(" · ");
    this.title.textContent = tab.name;
    for (const [id, key] of this.modeKeys) {
      key.classList.toggle("is-on", id === this.mode.id);
      key.setAttribute("aria-pressed", String(id === this.mode.id));
    }
    for (const [id, key] of this.tabKeys) {
      key.classList.toggle("is-open", id === this.tab);
      key.setAttribute("aria-pressed", String(id === this.tab));
      if (id === "yours") {
        key.disabled = !this.ownership;
        key.title = this.ownership ? "" : "This lobby server cannot prove which recordings are yours.";
      }
    }
    this.rule.textContent = this.ruleText();
    this.featuredPane.hidden = this.tab !== "featured";
    this.gridPane.hidden = this.tab === "featured";
    if (this.tab === "featured") this.renderFeatured();
    else this.renderGrid();
    this.renderMaps();
  }

  private ruleText(): string {
    if (this.tab === "latest") return `Newest first · the latest ${DEMO_LIST_LIMIT} recordings`;
    if (this.tab === "yours") return "Matches you played on a verified seat, newest first";
    if (this.featuredState !== "ready" || this.featured.length === 0) return "Recordings from the last 7 days";
    return this.featured.some((entry) => entry.reason.includes("top 10"))
      ? "This week's matches with players from the 30-day top 10"
      : "No top-10 matches this week · the latest multiplayer matches instead";
  }

  private renderFeatured(): void {
    let empty = "";
    if (!this.host.client.connected) empty = "Connect to the lobby to see this week's picks.";
    else if (newUiApi.getFeatureStatus("featuredDemos").status !== "ready")
      empty = "Featured picks are unavailable on this lobby server. Latest has every match.";
    else if (this.featuredState === "failed") empty = this.featuredError;
    else if (this.featuredState !== "ready") empty = "Loading this week's picks…";
    else if (this.featured.length === 0) {
      const where = this.map ? " on this map" : this.mode.id !== "all" ? ` in ${this.mode.title}` : "";
      empty = `No multiplayer matches${where} this week yet. Latest has every match.`;
    }
    this.pickCount.textContent = this.featured.length ? `${this.featured.length} picks` : "";
    if (empty) {
      this.paint(this.hero, null);
      const face = el("div", "dm-slab__face");
      face.append(el("div", "dm-hero__empty", empty));
      this.hero.replaceChildren(this.slabSide(), face);
      this.picks.replaceChildren();
      return;
    }

    const current = this.featured.find((entry) => entry.demo.filename === this.heroFile) ?? this.featured[0];
    this.heroFile = current.demo.filename;
    const demo = current.demo;
    this.paint(this.hero, demo);

    const face = el("div", "dm-slab__face");
    const shot = el("div", "dm-shot");
    shot.append(el("div", "dm-shot__img"), this.flags(demo, [el("span", "dm-flag", "★ Featured")]));
    shot.append(el("span", "dm-shot__len", clock(demo.durationMs)), this.bigMatchup(demo));

    const foot = el("div", "dm-hero__foot");
    const watch = this.playKey(createRaisedKey({ label: "▶ Watch", variants: ["watch"] }));
    watch.addEventListener("click", () => void this.play(demo, this.hero, watch));
    const reel = el("div", "dm-hero__reel");
    const allowed = reelLengths(demo.durationMs);
    // The chosen length, or this demo's longest when it is too short for that
    let chosen: number | undefined = allowed.includes(this.reelMinutes)
      ? this.reelMinutes
      : allowed[allowed.length - 1];
    const highlights = this.reelKey(createRaisedKey({ label: "⚡ Highlights", variants: ["cream"] }), allowed);
    highlights.addEventListener("click", () => {
      if (chosen !== undefined) void this.playReel(demo, this.hero, highlights, chosen);
    });
    const lengths = el("div", "dm-lens");
    lengths.setAttribute("role", "group");
    lengths.setAttribute("aria-label", "Highlight reel length");
    // Every length keeps its place; one the demo is too short for is disabled
    for (const minutes of REEL_MINUTES) {
      const key = el("button", minutes === chosen ? "is-on" : "", `${minutes} min`);
      key.type = "button";
      key.disabled = !allowed.includes(minutes);
      if (key.disabled) key.title = TOO_SHORT;
      key.setAttribute("aria-pressed", String(minutes === chosen));
      key.addEventListener("click", () => {
        this.reelMinutes = minutes;
        chosen = minutes;
        for (const other of lengths.children) {
          other.classList.toggle("is-on", other === key);
          other.setAttribute("aria-pressed", String(other === key));
        }
      });
      lengths.append(key);
    }
    reel.append(highlights, lengths);
    const where = el("div", "dm-hero__where");
    const when = new Date(demo.date).toLocaleString(undefined, {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    where.append(
      el("span", "dm-hero__ago", ago(demo.date, false)),
      el("span", "dm-hero__when", `${when} · ${demo.sizeMB} MB`),
    );
    foot.append(watch, reel, where);
    face.append(shot, foot);
    this.hero.replaceChildren(this.slabSide(), face);

    this.picks.replaceChildren(
      ...this.featured.map((entry) => {
        const pick = entry.demo;
        const text = el("span", "dm-pick__text");
        if (pick.players.length === 2) {
          text.append(this.pickLine(pick.players[0]), this.pickLine(pick.players[1], "VS"));
        } else {
          text.append(this.pickLine(pick.players[0] ?? mapName(pick)));
          if (pick.players.length > 1) text.append(this.pickLine(`+${pick.players.length - 1} more`));
        }
        const meta = el("span", "dm-pick__meta");
        meta.append(
          el("span", "lobby__room-mark"),
          el("span", "", `${this.modeOf(pick).title} · ${mapName(pick)}`),
          el("span", "dm-pick__ago", ago(pick.date, true)),
        );
        text.append(meta);
        const key = createRaisedKey({ variants: ["cream", "pick"], content: [el("span", "dm-pick__shot"), text] });
        this.paint(key, pick);
        key.title = entry.reason;
        key.setAttribute("aria-pressed", String(pick.filename === this.heroFile));
        key.addEventListener("click", () => {
          this.heroFile = pick.filename;
          this.renderFeatured();
        });
        return key;
      }),
    );
  }

  private pickLine(name: string, prefix?: string): HTMLElement {
    const line = el("span", "dm-pick__vs");
    if (prefix) line.append(el("i", "", prefix));
    line.append(el("span", "", name));
    return line;
  }

  private renderGrid(): void {
    const list = this.shownList();
    const pages = Math.max(1, Math.ceil(list.length / DEMOS_PER_PAGE));
    this.page = Math.min(Math.max(1, this.page), pages);
    const shown = list.slice((this.page - 1) * DEMOS_PER_PAGE, this.page * DEMOS_PER_PAGE);

    let empty = "";
    if (!this.host.client.connected) empty = "Lobby server offline. Connect to browse recordings.";
    else if (this.archiveFailed) empty = "The archive did not answer. Try again.";
    else if (!this.archiveArrived) empty = "Loading the archive…";
    else if (this.query.trim()) empty = `No demos with “${this.query.trim()}” in them`;
    else if (this.archive.length > 0) empty = "No demos for this mode and map.";
    else if (this.tab === "yours") empty = "No recordings of yours yet. A match you play lands here once it ends.";
    else empty = "No recorded demos yet. Play a match.";

    this.grid.replaceChildren(
      ...(shown.length ? shown.map((demo, index) => this.card(demo, index)) : [el("div", "dm-grid__empty", empty)]),
    );
    if (this.archiveFailed && this.host.client.connected) {
      const retry = createRaisedKey({ label: "Try again", variants: ["sm", "cream"] });
      retry.addEventListener("click", () => {
        this.requestArchive(true);
        this.render();
      });
      this.grid.appendChild(retry);
    }
    this.count.replaceChildren(
      el("b", "", String(list.length)),
      `${list.length === 1 ? "demo" : "demos"}${pages > 1 ? ` · page ${this.page} of ${pages}` : ""}`,
    );
    this.search.disabled = this.archive.length === 0;

    if (pages <= 1) {
      this.pager.replaceChildren();
      return;
    }
    const keys: HTMLElement[] = [];
    const previous = createRaisedKey({ label: "‹ Newer", variants: ["sm"] });
    previous.disabled = this.page === 1;
    previous.addEventListener("click", () => this.goTo(this.page - 1));
    keys.push(previous);
    const numbers = pageKeys(this.page, pages);
    numbers.forEach((n, index) => {
      if (index && n - numbers[index - 1] > 1) keys.push(el("span", "dm-pager__gap", "…"));
      const key = createRaisedKey({ label: String(n), variants: ["sm", "cream"] });
      if (n === this.page) key.setAttribute("aria-current", "page");
      key.setAttribute("aria-label", `Page ${n}`);
      key.addEventListener("click", () => this.goTo(n));
      keys.push(key);
    });
    const next = createRaisedKey({ label: "Older ›", variants: ["sm"] });
    next.disabled = this.page === pages;
    next.addEventListener("click", () => this.goTo(this.page + 1));
    keys.push(next);
    this.pager.replaceChildren(...keys);
  }

  private goTo(page: number): void {
    this.page = page;
    this.renderGrid();
  }

  private renderMaps(): void {
    const inMode = this.inMode();
    const maps = [...new Map(inMode.map((demo) => [demo.map, demo])).values()].sort((a, b) =>
      mapName(a).localeCompare(mapName(b)),
    );
    this.mapCount.textContent = maps.length ? `${maps.length} ${maps.length === 1 ? "map" : "maps"}` : "";
    if (!this.host.client.connected || (!this.archiveArrived && maps.length === 0)) {
      this.mapList.replaceChildren(
        el(
          "p",
          "lobby__rail-empty",
          this.host.client.connected
            ? this.archiveFailed
              ? "Archive unavailable. Use Try again."
              : "Loading the archive…"
            : "Lobby server offline.",
        ),
      );
      return;
    }
    const row = (id: string | null, label: string, count: number, color: string) => {
      const mark = el("span", "lobby__room-mark");
      const name = el("span", "raised-key__label", label);
      const number = el("span", "raised-key__hint lobby__room-count", String(count));
      const key = createRaisedKey({ variants: ["sm", "cream", "room"], content: [mark, name, number] });
      key.classList.add("dm-rail__map");
      key.style.setProperty("--mode-mark", color);
      key.setAttribute("aria-pressed", String(this.map === id));
      key.setAttribute("aria-label", `${label}: ${count} ${count === 1 ? "recording" : "recordings"}`);
      key.addEventListener("click", () => this.setMap(this.map === id ? null : id));
      return key;
    };
    this.mapList.replaceChildren(
      row(null, "All maps", inMode.length, this.mode.mark),
      ...maps.map((demo) =>
        row(demo.map, mapName(demo), inMode.filter((other) => other.map === demo.map).length, this.modeOf(demo).mark),
      ),
    );
  }

  // ── Pieces ──

  private modeOf(demo: DemoInfo): RankedMode {
    return this.modes.find((mode) => mode.id === demoMode(demo)) ?? { ...ALL, title: demo.gametype };
  }

  /** A demo's colours and levelshot on a slab or pick; with no demo, the empty slab's. */
  private paint(node: HTMLElement, demo: DemoInfo | null): void {
    const mode = demo ? this.modeOf(demo) : null;
    if (demo?.levelshot) node.style.setProperty("--img", `url("${demo.levelshot}")`);
    else node.style.removeProperty("--img");
    node.style.setProperty("--m", mode?.mark ?? "hsl(250 36% 30%)");
    node.style.setProperty("--mode-mark", mode?.mark ?? "hsl(250 36% 30%)");
    node.style.setProperty("--ms-hi", mode?.accent[3] ?? "hsl(250 36% 14%)");
    node.style.setProperty("--ms-lo", mode?.accent[4] ?? "hsl(250 40% 8%)");
  }

  private slabSide(): HTMLElement {
    const side = el("div", "dm-slab__side");
    side.setAttribute("aria-hidden", "true");
    return side;
  }

  private flags(demo: DemoInfo, extra: HTMLElement[] = []): HTMLElement {
    const flags = el("div", "dm-shot__flags");
    const mode = this.modeOf(demo);
    const label = demo.players.length > 2 ? `${mode.title} · ${demo.players.length}` : mode.title;
    flags.append(el("span", "dm-flag dm-flag--mode", label), ...extra, el("span", "dm-shot__map", mapName(demo)));
    return flags;
  }

  /** Who played, on a card: both names across a VS, or the first few and a count. */
  private matchup(demo: DemoInfo): HTMLElement {
    const box = el("div", "dm-mu");
    const row = (name: string) => {
      const line = el("div", "dm-mu__row");
      line.append(el("span", "dm-mu__name", name));
      return line;
    };
    if (demo.players.length === 2) {
      box.append(el("span", "dm-mu__vs", "VS"), row(demo.players[0]), row(demo.players[1]));
      return box;
    }
    box.classList.add("dm-mu--many");
    const first = demo.players.slice(0, 2);
    for (const name of first) box.append(row(name));
    if (demo.players.length > first.length) box.append(row(`+${demo.players.length - first.length} more`));
    if (demo.players.length === 0) box.append(row(`${mapName(demo)} match`));
    return box;
  }

  /** Who played, big, across the bottom of the featured shot. */
  private bigMatchup(demo: DemoInfo): HTMLElement {
    if (demo.players.length === 2) {
      const vs = el("div", "dm-vs");
      const side = (name: string, right: boolean) => {
        const box = el("div", `dm-vs__side${right ? " dm-vs__side--r" : ""}`);
        box.append(el("span", "dm-vs__name", name));
        return box;
      };
      const middle = el("div", "dm-vs__mid");
      middle.append(el("span", "dm-vs__badge", "VS"));
      vs.append(side(demo.players[0], false), middle, side(demo.players[1], true));
      return vs;
    }
    const many = el("div", "dm-vs dm-vs--many");
    const names = el("div", "dm-vs__names");
    for (const name of demo.players) names.append(el("span", "dm-vs__player", name));
    many.append(el("span", "dm-vs__count", `${demo.players.length} players`), names);
    return many;
  }

  private card(demo: DemoInfo, index: number): HTMLElement {
    const card = el("article", "dm-slab dm-card");
    this.paint(card, demo);
    card.style.setProperty("--i", String(index));
    const face = el("div", "dm-slab__face");
    const shot = el("div", "dm-shot");
    shot.append(el("div", "dm-shot__img"), this.flags(demo), el("span", "dm-shot__len", clock(demo.durationMs)));
    shot.append(this.matchup(demo));
    const foot = el("div", "dm-card__foot");
    const watch = this.playKey(createRaisedKey({ label: "▶ Watch", variants: ["sm"] }));
    watch.addEventListener("click", () => void this.play(demo, card, watch));
    // The bolt alone on a narrow card; the label says the rest to a screen reader
    const highlights = this.reelKey(
      createRaisedKey({ label: "⚡", variants: ["sm", "cream"] }),
      reelLengths(demo.durationMs),
    );
    highlights.querySelector(".raised-key__label")?.append(el("span", "dm-long", " Highlights"));
    highlights.setAttribute("aria-label", "Highlights");
    highlights.setAttribute("aria-haspopup", "dialog");
    highlights.addEventListener("click", () => this.openReel(demo, card, highlights));
    const where = el("div", "dm-card__where");
    const when = el("span", "dm-card__ago", ago(demo.date, true));
    when.title = new Date(demo.date).toLocaleString();
    where.append(when, el("span", "dm-card__size", `${demo.sizeMB} MB`));
    foot.append(watch, highlights, where);
    face.append(shot, foot);
    card.append(this.slabSide(), face);
    return card;
  }

  // ── Watching ──

  private async play(demo: DemoInfo, card: HTMLElement, key: HTMLButtonElement): Promise<void> {
    await this.run(demo, card, key, async (service) => {
      await service.loadAndPlayNormal(new DemoViewer());
    });
  }

  private async playReel(demo: DemoInfo, card: HTMLElement, key: HTMLButtonElement, minutes: number): Promise<void> {
    await this.run(demo, card, key, async (service) => {
      await service.loadAndPlayCinematic(new DemoViewer(), CameraSystem.getInstance(), minutes);
    });
  }

  /** Load a recording and start it, the key saying so meanwhile and back as it was after. */
  private async run(
    demo: DemoInfo,
    card: HTMLElement,
    key: HTMLButtonElement,
    start: (service: DemoService) => Promise<void>,
  ): Promise<void> {
    // One selection at a time. Cancel makes another selection available at once.
    if (this.pendingPlay) return;
    const generation = ++this.playGeneration;
    const controller = new AbortController();
    const ownsRun = () => generation === this.playGeneration && !controller.signal.aborted;
    const label = key.querySelector(".raised-key__label");
    const wording = label ? [...label.childNodes].map((node) => node.cloneNode(true)) : [];
    this.pendingPlay = {
      controller,
      restore: () => {
        key.disabled = false;
        label?.replaceChildren(...wording);
      },
    };
    this.closeReel();
    this.root.setAttribute("aria-busy", "true");
    for (const playKey of this.root.querySelectorAll<HTMLButtonElement>("[data-demo-play]")) playKey.disabled = true;
    key.disabled = true;
    setRaisedKeyText(key, "Loading…");
    this.transfer.hidden = false;
    this.transferText.setAttribute("role", "status");
    this.transferText.textContent = `Loading ${mapName(demo)} recording…`;
    setRaisedKeyText(this.transferAction, "Cancel");
    this.transferAction.onclick = () => this.deactivate();
    let handedOff = false;
    try {
      const service = DemoService.getInstance();
      await service.fetchAndLoad(demo.filename, { signal: controller.signal });
      if (!ownsRun()) return;
      this.finishTransfer();
      this.transfer.hidden = true;
      // Hide before map loading: the automatic map handoff must not cancel this
      // selection as if the player had navigated away during the download.
      this.handingOff = true;
      try {
        this.host.leave();
      } finally {
        this.handingOff = false;
      }
      handedOff = true;
      // Leaving playback (its ✕, or Esc) comes back to this page.
      service.setExitHandler(() => this.host.show?.());
      await start(service);
    } catch (error) {
      if (!ownsRun()) return;
      if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
        this.transfer.hidden = true;
        this.transferAction.onclick = null;
        return;
      }
      console.error("[DemosView] Could not play the demo:", error);
      if (handedOff) this.host.show?.();
      this.transfer.hidden = false;
      this.transferText.setAttribute("role", "alert");
      this.transferText.textContent = error instanceof Error ? error.message : String(error);
      setRaisedKeyText(this.transferAction, "Try again");
      this.transferAction.onclick = () => void this.run(demo, card, key, start);
    } finally {
      if (generation === this.playGeneration) this.finishTransfer();
    }
  }

  /** The reel menu for a card: how long a cut of its best moments. */
  private openReel(demo: DemoInfo, card: HTMLElement, key: HTMLButtonElement): void {
    this.reelDemo = { demo, card, key };
    const sheet = el("div", "dm-reel__card");
    const head = el("div", "dm-reel__head");
    const close = el("button", "dm-reel__close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => this.closeReel(true));
    head.append(el("span", "dm-reel__q", "⚡ Highlight reel"), close);
    const who =
      demo.players.length === 2 ? `${demo.players[0]} vs ${demo.players[1]}` : `${demo.players.length} players`;
    const options = el("div", "dm-reel__opts");
    const allowed = reelLengths(demo.durationMs);
    for (const minutes of REEL_MINUTES) {
      const option = el("button", "dm-reel__opt");
      option.type = "button";
      option.disabled = !allowed.includes(minutes);
      if (option.disabled) option.title = TOO_SHORT;
      option.append(el("b", "", String(minutes)), el("small", "", "min"));
      option.setAttribute("aria-label", `${minutes} minute reel`);
      option.addEventListener("click", () => {
        this.closeReel();
        void this.playReel(demo, card, key, minutes);
      });
      options.append(option);
    }
    sheet.append(
      head,
      el("div", "dm-reel__sub", `${who} · ${mapName(demo)}`),
      options,
      el("div", "dm-reel__hint", "Kills, sprees and close calls, cut together"),
    );
    this.reel.replaceChildren(sheet);
    this.reel.hidden = false;
    const rect = key.getBoundingClientRect();
    const left = Math.min(
      Math.max(this.root.getBoundingClientRect().left + 60, rect.left + rect.width / 2 - this.reel.offsetWidth / 2),
      window.innerWidth - this.reel.offsetWidth - 16,
    );
    const above = rect.top - this.reel.offsetHeight - 18;
    this.reel.style.left = `${left}px`;
    this.reel.style.top = `${above < 12 ? rect.bottom + 18 : above}px`;
    this.reel.querySelectorAll<HTMLButtonElement>(".dm-reel__opt")[1]?.focus();
  }

  private closeReel(returnFocus = false): void {
    if (!this.reelDemo) return;
    const { key } = this.reelDemo;
    this.reelDemo = null;
    this.reel.hidden = true;
    if (returnFocus) key.focus();
  }
}
