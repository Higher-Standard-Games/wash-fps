/**
 * The Campaign page: the operations as a list down the page, each with its
 * comic card (clicked, it reads panel by panel) and a track node showing where
 * it stands (cleared, current or locked), and the way into the next one; under
 * them, the finale. Progress comes from the lobby (`campaign:state`); until it
 * answers, the copy this browser kept is shown.
 */

import { background } from "../../../../engine/core/AsyncErrors";
import { createRaisedKey, setRaisedKeyText } from "../../../../engine/ui/components/RaisedKey";
import type { CampaignClear, CampaignMissionInfo } from "../../../../lobby/types";
import { CampaignBoardPane } from "../CampaignBoardPane";
import { newUiApi } from "../NewUiApi";
import { CampaignCutscene } from "./CampaignCutscene";
import type { CampaignState } from "./CampaignSession";
import { type CampaignCard, campaignStory, FINALE_CARD } from "./CampaignStory";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const two = (n: number) => String(n).padStart(2, "0");

/** The game modes by their full names. */
const GAMETYPE_NAMES: Record<string, string> = {
  amphi: "Amphi",
  duel: "Duel",
  ffa: "Free For All",
  snd: "Search & Destroy",
  tdm: "Team Deathmatch",
  survival: "Survival",
};

/** The campaign's opening, under the page title. */
const INGRESS =
  "Welcome to Neo-Kyoto, where walking is for targets, friction is illegal, and megacorporations broadcast street violence for prime-time ad revenue. You're an unranked runner looking to turn lethal slide-speed into cold crypto, starting with a back-alley Cartel tryout. Out-move the gangs, scrap the bots, and claim the arena.";

/** The same in one line, for a screen too short for the whole opening. */
const INGRESS_SHORT =
  "From a back-alley Cartel tryout to the top of the broadcast: climb the 8-stage Neo-Kyoto gauntlet, where speed is survival and friction is fatal.";

/** The squad, cut out, to stand on the street in the page's banner. */
const SQUAD_IMAGE = "/images/campaign/squad.webp";

export type MissionStatus = "cleared" | "current" | "open" | "locked";

const FINALE_TITLE = "Campaign complete!";

/**
 * Where a mission stands: cleared, the one to play next, open (unlocked,
 * not cleared, not next: only after a mission is taken out of order), or
 * locked. Numbers past the written missions are locked.
 */
export function missionStatus(number: number, state: CampaignState | null): MissionStatus {
  if (!state) return number === 1 ? "current" : "locked";
  const mission = state.missions.find((m) => m.number === number);
  if (!mission || number > state.unlockedThrough) return "locked";
  if (state.clears.some((clear) => clear.missionId === mission.id)) return "cleared";
  const firstOpen = state.missions.find(
    (m) => m.number <= state.unlockedThrough && !state.clears.some((clear) => clear.missionId === m.id),
  );
  return firstOpen?.number === number ? "current" : "open";
}

export interface CampaignViewOptions {
  /** Start (or replay) a mission. */
  start: (mission: CampaignMissionInfo) => void;
}

export class CampaignView {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly countEl: HTMLElement;
  private state: CampaignState | null = null;
  /** Mission keys may be pressed: the lobby is there and no room is open. */
  private startable = false;
  private reason = "";
  /** The current mission the list was last brought to; other redraws keep the reader's place. */
  private shownCurrent: string | null = null;
  /** A parallax update waiting for the next frame. */
  private parallaxFrame = 0;
  /** The campaign's leaderboard, in place of the operations while it is open. */
  private readonly boardKey: HTMLButtonElement;
  private readonly board: HTMLElement;
  private readonly boardPane = new CampaignBoardPane();
  /** Bumped on each opening: a late answer for an earlier one is dropped. */
  private boardSeq = 0;

  constructor(private readonly options: CampaignViewOptions) {
    this.root = el("div", "lobby__page campaign");
    // No drifting light here: the banner fades into an even purple
    this.root.append(this.buildBanner());

    const head = el("header", "campaign__head");
    this.countEl = el("p", "campaign__count campaign-plate campaign-plate--dark");
    // The count beside the title; the campaign's opening under both, in a caption box like the cards'
    this.boardKey = createRaisedKey({ label: "Leaderboard", variants: ["nav"] });
    this.boardKey.classList.add("campaign__board-key");
    this.boardKey.setAttribute("aria-pressed", "false");
    this.boardKey.addEventListener("click", () => (this.board.hidden ? this.openBoard() : this.closeBoard()));
    head.append(
      el("h1", "lobby__title campaign__title campaign-plate", "Campaign"),
      this.countEl,
      el("p", "campaign__ingress", INGRESS),
      el("p", "campaign__ingress campaign__ingress--short", INGRESS_SHORT),
      this.boardKey,
    );

    this.list = el("ol", "campaign__list");
    this.list.setAttribute("aria-label", "Operations");
    this.notice = el("p", "campaign__notice");
    this.notice.setAttribute("role", "status");

    // The leaderboard takes the operations' place, with a close key in its corner
    this.board = el("section", "campaign__board");
    this.board.setAttribute("aria-label", "Campaign leaderboard");
    this.board.hidden = true;
    const close = el("button", "campaign__board-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close the leaderboard");
    close.addEventListener("click", () => this.closeBoard());
    this.board.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      this.closeBoard();
    });
    this.board.append(close, this.boardPane.root);

    this.root.append(head, this.notice, this.list, this.board);
    this.list.addEventListener("scroll", () => this.queueParallax(), { passive: true });
    this.render();
  }

  /** The squad on their street across the top, fading into the page. */
  private buildBanner(): HTMLElement {
    const banner = el("div", "campaign__banner");
    banner.setAttribute("aria-hidden", "true");
    const squad = el("img", "campaign__squad");
    squad.src = SQUAD_IMAGE;
    squad.alt = "";
    squad.decoding = "async";
    // The street and the squad share one stage, at the scale they were drawn
    // for; the backdrop is the same street, softened, filling a wide screen
    banner.append(el("div", "campaign__backdrop"), el("div", "campaign__street"), squad, el("div", "campaign__fade"));
    return banner;
  }

  /**
   * Scrolling the operations moves the banner's layers at their own pace: the
   * street slowest, the squad faster, the cards themselves fastest. The
   * stylesheet turns the one scroll value into each layer's drift.
   */
  private queueParallax(): void {
    if (this.parallaxFrame) return;
    this.parallaxFrame = requestAnimationFrame(() => {
      this.parallaxFrame = 0;
      this.root.style.setProperty("--campaign-scroll", `${this.list.scrollTop}px`);
    });
  }

  /** Show the leaderboard in the operations' place, read fresh from the lobby. */
  private openBoard(): void {
    this.board.hidden = false;
    this.list.hidden = true;
    this.notice.hidden = true;
    this.root.classList.add("campaign--board");
    this.boardKey.setAttribute("aria-pressed", "true");
    const sequence = ++this.boardSeq;
    this.boardPane.render({ state: "loading" });
    background(
      newUiApi.getCampaignBoard().then((result) => {
        if (sequence !== this.boardSeq || this.board.hidden) return;
        this.boardPane.render(
          result.status === "ready"
            ? { state: "ready", board: result.data }
            : { state: "failed", reason: result.reason },
        );
      }),
      "Loading the campaign leaderboard",
    );
    this.board.querySelector<HTMLElement>(".campaign__board-close")?.focus();
  }

  /** Back to the operations. */
  private closeBoard(): void {
    if (this.board.hidden) return;
    this.boardSeq++;
    this.board.hidden = true;
    this.list.hidden = false;
    this.notice.hidden = false;
    this.root.classList.remove("campaign--board");
    this.boardKey.setAttribute("aria-pressed", "false");
    this.render();
    this.boardKey.focus();
  }

  /** The campaign as the lobby (or this browser's copy) has it; null before either. */
  setState(state: CampaignState | null): void {
    this.state = state;
    this.render();
  }

  /** Whether a mission can start now, and why not when it cannot. */
  setStartable(startable: boolean, reason = ""): void {
    if (startable === this.startable && reason === this.reason) return;
    this.startable = startable;
    this.reason = reason;
    this.render();
  }

  /** Bring the mission to play next into view, once the page is on screen. */
  showCurrent(): void {
    const current = this.list.querySelector<HTMLElement>(".campaign-card--current");
    if (!current || !this.root.isConnected || this.root.offsetParent === null) return;
    current.scrollIntoView({ block: "center" });
    this.shownCurrent = current.dataset.mission ?? null;
    this.queueParallax();
  }

  private clearedCount(): number {
    const state = this.state;
    if (!state) return 0;
    return state.missions.filter((m) => state.clears.some((clear) => clear.missionId === m.id)).length;
  }

  /** The count, and a segment for each operation: cyan once cleared, gold for the next. */
  private renderCount(length: number): void {
    const pips = el("span", "campaign__pips");
    pips.setAttribute("aria-hidden", "true");
    for (let number = 1; number <= length; number++) {
      pips.append(el("span", `campaign__pip campaign__pip--${missionStatus(number, this.state)}`));
    }
    this.countEl.replaceChildren(
      el("strong", "", `${this.clearedCount()} / ${length}`),
      el("span", "campaign__count-label", "cleared"),
      pips,
    );
  }

  /** Every operation cleared: the finale shows. */
  private complete(): boolean {
    const length = this.state?.length ?? 0;
    return length > 0 && this.clearedCount() >= length;
  }

  private render(): void {
    const state = this.state;
    const length = state?.length || 8;
    this.renderCount(length);
    this.notice.textContent = this.startable ? "" : this.reason;

    const rows: HTMLElement[] = [];
    let previous: MissionStatus | null = null;
    for (let number = 1; number <= length; number++) {
      const mission = state?.missions.find((m) => m.number === number);
      const status = missionStatus(number, state);
      const row = this.buildRow(number, mission, status);
      // The track into this node takes the colour of the operation before
      if (previous) row.dataset.from = previous;
      rows.push(row);
      previous = status;
    }
    const finale = this.buildFinale();
    if (previous) finale.dataset.from = previous;
    rows.push(finale);
    // Keep focus on the same key across a redraw, for keyboard and pad players
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.navId : undefined;
    this.list.replaceChildren(...rows);
    if (focused) this.list.querySelector<HTMLElement>(`[data-nav-id="${focused}"]`)?.focus({ preventScroll: true });
    // A new mission to play next (progress arrived, or a clear) is brought into view
    const current = this.list.querySelector<HTMLElement>(".campaign-card--current")?.dataset.mission ?? null;
    if (state && current !== this.shownCurrent) this.showCurrent();
  }

  private buildRow(number: number, mission: CampaignMissionInfo | undefined, status: MissionStatus): HTMLElement {
    const story = mission ? campaignStory(mission.id) : null;
    const row = el("li", `campaign-card campaign-card--${status}`);
    if (mission) row.dataset.mission = mission.id;
    // The track down the left: this mission's node, and the line on to the next
    const node = el("span", "campaign-card__node", status === "cleared" ? "✓" : status === "locked" ? "" : two(number));
    node.setAttribute("aria-hidden", "true");
    row.append(node);

    const art = el("div", "campaign-card__art");
    if (story?.card) {
      const img = el("img", "campaign-card__img");
      // The whole card, at the size it is shown: the thumbnail on most screens, the full card on wide ones
      img.src = story.card.thumb;
      img.srcset = `${story.card.thumb} 720w, ${story.card.image} ${story.card.width}w`;
      img.sizes = "(min-width: 2200px) 900px, 42vw";
      img.alt = status === "locked" ? "" : story.title;
      img.loading = "lazy";
      img.decoding = "async";
      art.append(img);
      if (status !== "locked") this.makeReadable(art, story.card, `Operation ${two(number)}`, story.title);
    }
    if (status === "locked") art.append(el("span", "campaign-card__stamp", "Classified"));
    // An operation whose art is still being drawn shows its number in its place
    else if (!story?.card) art.append(el("span", "campaign-card__stamp", `Operation ${two(number)}`));
    row.append(art);

    const info = el("div", "campaign-card__info");

    if (status === "locked" || !mission) {
      info.append(el("h2", "campaign-card__name", "Classified"));
      info.append(el("p", "campaign-card__hook", `Clear operation ${two(number - 1)} to unlock.`));
      row.append(info);
      return row;
    }

    info.append(el("h2", "campaign-card__name campaign-plate campaign-plate--dark", story?.title ?? mission.mapTitle));
    if (story?.intro) info.append(el("p", "campaign-card__hook campaign-card__intro", story.intro));

    // The one thing worth a bullet: which game mode the operation is
    const mode = el("ul", "campaign-card__brief");
    mode.append(el("li", "", GAMETYPE_NAMES[mission.gametype] ?? mission.gametype));
    info.append(mode);

    const foot = el("div", "campaign-card__foot");
    const clear = this.state?.clears.find((c) => c.missionId === mission.id);
    if (clear) foot.append(this.buildStats(clear));
    foot.append(this.buildStart(mission, status));
    info.append(foot);
    row.append(info);
    return row;
  }

  private buildStart(mission: CampaignMissionInfo, status: MissionStatus): HTMLButtonElement {
    const key = createRaisedKey({
      label: status === "cleared" ? "↻ Replay" : "▶ Play",
      variants: status === "cleared" ? ["sm", "cream"] : ["sm"],
    });
    key.classList.add("campaign-card__start");
    key.dataset.navId = `campaign-${mission.id}`;
    key.disabled = !this.startable;
    if (!this.startable && this.reason) key.title = this.reason;
    key.addEventListener("click", () => {
      if (!this.startable) return;
      setRaisedKeyText(key, "Starting…");
      this.options.start(mission);
    });
    return key;
  }

  /** Clicking `art` (or Enter on it) reads `card` panel by panel, at a size its words can be read. */
  private makeReadable(art: HTMLElement, card: CampaignCard, label: string, title: string): void {
    art.classList.add("campaign-card__art--readable");
    art.tabIndex = 0;
    art.setAttribute("role", "button");
    art.setAttribute("aria-label", `Read the story: ${title}`);
    art.title = "Read the story";
    art.addEventListener("click", () => this.readCard(card, label, title));
    art.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.readCard(card, label, title);
    });
  }

  /** A comic card, panel by panel, without starting anything. */
  private readCard(card: CampaignCard, label: string, title: string): void {
    const cutscene: CampaignCutscene = new CampaignCutscene({
      card,
      label,
      title,
      onPanelsDone: () => cutscene.close(),
    });
    background(cutscene.play(), "CampaignView");
  }

  /**
   * Under the last operation: the finale. Until every operation is cleared it
   * is a classified strip, so the ending stays unseen; then its card, larger
   * than the others and turning slowly the way the comic does before a match,
   * under a CAMPAIGN COMPLETE plate.
   */
  private buildFinale(): HTMLElement {
    const complete = this.complete();
    const row = el(
      "li",
      `campaign-card campaign-finale${complete ? " campaign-finale--complete" : " campaign-card--locked"}`,
    );
    const node = el("span", "campaign-card__node campaign-finale__node", complete ? "★" : "");
    node.setAttribute("aria-hidden", "true");

    if (!complete) {
      const art = el("div", "campaign-card__art");
      art.append(el("span", "campaign-card__stamp", "Classified"));
      const info = el("div", "campaign-card__info");
      info.append(
        el("h2", "campaign-card__name", "Classified"),
        el("p", "campaign-card__hook", "Clear every operation to see how it ends."),
      );
      row.append(node, art, info);
      return row;
    }

    const head = el("h2", "campaign-finale__title campaign-plate campaign-plate--deep", FINALE_TITLE);
    // The card on its slow turn, the size it is shown at
    const art = el("div", "campaign-finale__art");
    const drift = el("div", "campaign-finale__drift");
    const img = el("img", "campaign-finale__img");
    img.src = FINALE_CARD.thumb;
    img.srcset = `${FINALE_CARD.thumb} 720w, ${FINALE_CARD.image} ${FINALE_CARD.width}w`;
    img.sizes = "(min-width: 2200px) 1500px, 64vw";
    img.alt = FINALE_TITLE;
    img.loading = "lazy";
    img.decoding = "async";
    drift.append(img, el("span", "campaign-finale__sheen"));
    art.append(drift);
    this.makeReadable(art, FINALE_CARD, "Finale", FINALE_TITLE);
    row.append(node, head, art);
    return row;
  }

  /** The best a cleared operation has gone. Not its time: most matches run to a time limit. */
  private buildStats(clear: CampaignClear): HTMLElement {
    const stats = el("dl", "campaign-card__stats");
    const item = el("div", "campaign-card__stat");
    item.title = "Most frags in a winning match";
    item.append(el("dt", "", "Most frags"), el("dd", "", String(clear.bestFrags)));
    stats.append(item);
    return stats;
  }
}
