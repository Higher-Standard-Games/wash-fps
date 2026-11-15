/**
 * The comic card before a campaign mission. The screen fades to black, then
 * each framed panel of the card in turn fills the screen, drifting slowly,
 * with the rest of the card blurred behind it. A panel moves on after
 * PANEL_MS, or at a click or key press. After the last panel the screen
 * stays black, with a status line, until the match connects.
 */

import type { CampaignCard, CardPanel } from "./CampaignStory";

/** How long a panel holds, once it has settled on screen, before the next one. */
export const PANEL_MS = 5000;
const FADE_MS = 450;
/** The first panel fading in; its time to read starts after. */
export const ART_FADE_MS = 700;
/** The move from one panel to the next. */
const MOVE_MS = 825;
/** Slow off the mark, fast through the middle, a soft landing. */
const MOVE_EASE = "cubic-bezier(0.76, 0, 0.24, 1)";
/** How much of the screen a panel may fill. */
const FILL_W = 0.9;
const FILL_H = 0.84;

export interface PanelView {
  scale: number;
  x: number;
  y: number;
}

/** Scale and offset that centre `panel` on a `width`×`height` screen, as large as fits. */
export function panelView(panel: CardPanel, width: number, height: number): PanelView {
  const scale = Math.min((width * FILL_W) / panel.w, (height * FILL_H) / panel.h);
  return {
    scale,
    x: width / 2 - (panel.x + panel.w / 2) * scale,
    y: height / 2 - (panel.y + panel.h / 2) * scale,
  };
}

/** The CSS clip that keeps only `panel` of a `card`-sized image. */
export function panelClip(panel: CardPanel, card: Pick<CampaignCard, "width" | "height">): string {
  const right = card.width - panel.x - panel.w;
  const bottom = card.height - panel.y - panel.h;
  return `inset(${panel.y}px ${right}px ${bottom}px ${panel.x}px)`;
}

type Phase = "opening" | "panels" | "waiting" | "error" | "closed";

export interface CampaignCutsceneOptions {
  card: CampaignCard;
  /** "Operation 01", shown in the corner while the card plays. */
  label: string;
  title: string;
  /** The last panel has been read: the mission may start. */
  onPanelsDone: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class CampaignCutscene {
  readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly drift: HTMLElement;
  private readonly sharp: HTMLImageElement;
  private readonly pips: HTMLElement;
  private readonly count: HTMLElement;
  private readonly speed: HTMLElement;
  private fillAnimation: Animation | null = null;
  private readonly status: HTMLElement;
  private readonly back: HTMLButtonElement;
  private readonly listeners = new AbortController();
  private readonly timers = new Set<number>();
  private phase: Phase = "opening";
  private index = -1;
  private driftAnimation: Animation | null = null;

  constructor(private readonly options: CampaignCutsceneOptions) {
    const { card } = options;
    this.root = el("div", "campaign-cut");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", `${options.label}: ${options.title}`);
    this.root.tabIndex = -1;

    this.stage = el("div", "campaign-cut__stage");
    this.stage.style.width = `${card.width}px`;
    this.stage.style.height = `${card.height}px`;
    this.drift = el("div", "campaign-cut__drift");
    const blurred = el("img", "campaign-cut__art campaign-cut__art--blur");
    this.sharp = el("img", "campaign-cut__art campaign-cut__art--sharp");
    for (const image of [blurred, this.sharp]) {
      image.src = card.image;
      image.alt = "";
      image.draggable = false;
    }
    this.sharp.alt = options.title;
    this.drift.append(blurred, this.sharp);
    this.stage.append(this.drift);

    // The mission's name on the campaign's yellow plate, nothing else
    const corner = el("div", "campaign-cut__corner");
    corner.append(el("strong", "campaign-cut__title campaign-plate", options.title));
    // Which panel of how many, and a segment per panel filling over its time
    this.count = el("span", "campaign-cut__count campaign-plate");
    this.pips = el("div", "campaign-cut__pips");
    this.pips.setAttribute("aria-hidden", "true");
    for (let i = 0; i < card.panels.length; i++) {
      const pip = el("span", "campaign-cut__pip");
      pip.append(el("span", "campaign-cut__pip-fill"));
      this.pips.append(pip);
    }
    const foot = el("div", "campaign-cut__foot");
    foot.append(this.count, this.pips);

    this.status = el("p", "campaign-cut__status");
    this.status.setAttribute("role", "status");
    this.back = el("button", "campaign-cut__back", "Back to campaign");
    this.back.type = "button";
    this.back.hidden = true;

    // Comic speed lines, streaking across while the view moves between panels
    this.speed = el("div", "campaign-cut__speed");
    this.speed.setAttribute("aria-hidden", "true");
    this.root.append(this.stage, this.speed, el("div", "campaign-cut__vignette"), corner, foot, this.status, this.back);
  }

  /** Fade to black and play the card. Resolves once it is on screen. */
  async play(parent: HTMLElement = document.body): Promise<void> {
    parent.appendChild(this.root);
    const signal = this.listeners.signal;
    this.root.addEventListener(
      "pointerdown",
      (event) => {
        if (event.target === this.back) return;
        event.preventDefault();
        this.next();
      },
      { signal },
    );
    // Capture, so a key that moves the card on never reaches the game's bindings
    window.addEventListener("keydown", (event) => this.onKey(event), { signal, capture: true });
    window.addEventListener("resize", () => this.place(false), { signal });
    this.root.focus({ preventScroll: true });
    requestAnimationFrame(() => this.root.classList.add("campaign-cut--black"));
    await Promise.all([this.wait(FADE_MS), this.sharp.decode().catch(() => undefined)]);
    if (this.phase !== "opening") return;
    // A mission without art goes straight to the black screen
    if (this.options.card.panels.length === 0) {
      this.finishPanels();
      return;
    }
    this.phase = "panels";
    this.show(0);
    this.root.classList.add("campaign-cut--art");
  }

  /** The words under the black screen while the mission is being set up. */
  setStatus(text: string): void {
    this.status.textContent = text;
  }

  /** Something went wrong: say what, and offer the way back. */
  fail(message: string, onBack: () => void): void {
    if (this.phase === "closed") return;
    this.phase = "error";
    this.clearTimers();
    this.root.classList.remove("campaign-cut--art");
    this.root.classList.add("campaign-cut--error");
    this.status.textContent = message;
    this.back.hidden = false;
    this.back.onclick = () => {
      this.close();
      onBack();
    };
    this.back.focus();
  }

  /** The match is connecting: fade the black away and remove the card. */
  close(): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.clearTimers();
    this.listeners.abort();
    this.driftAnimation?.cancel();
    this.fillAnimation?.cancel();
    this.root.classList.add("campaign-cut--closing");
    window.setTimeout(() => this.root.remove(), FADE_MS);
  }

  get isOpen(): boolean {
    return this.phase !== "closed";
  }

  private onKey(event: KeyboardEvent): void {
    if (this.phase === "closed") return;
    // The console key still opens the console over the card
    if (event.code === "Backquote" || ["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
    if (this.phase === "error") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.key === "Escape") this.finishPanels();
    else this.next();
  }

  private next(): void {
    if (this.phase !== "panels") return;
    if (this.index + 1 < this.options.card.panels.length) this.show(this.index + 1);
    else this.finishPanels();
  }

  private show(index: number): void {
    this.clearTimers();
    const first = this.index < 0;
    const from = this.options.card.panels[this.index];
    this.index = index;
    // A panel's time to read starts once it has faded in or finished its move
    const dwell = (first ? ART_FADE_MS : MOVE_MS) + PANEL_MS;
    this.count.textContent = `${index + 1} / ${this.options.card.panels.length}`;
    this.showProgress(index, dwell);
    this.place(!first);
    if (from) this.rush(from, this.options.card.panels[index]);
    this.startDrift(dwell);
    this.later(() => this.next(), dwell);
  }

  /** Earlier panels' segments full, this one's filling over its time, later ones empty. */
  private showProgress(index: number, dwell: number): void {
    this.fillAnimation?.cancel();
    this.fillAnimation = null;
    const pips = [...this.pips.querySelectorAll<HTMLElement>(".campaign-cut__pip")];
    pips.forEach((pip, at) => {
      pip.classList.toggle("campaign-cut__pip--done", at < index);
    });
    const fill = pips[index]?.querySelector<HTMLElement>(".campaign-cut__pip-fill");
    if (!fill || typeof fill.animate !== "function") return;
    this.fillAnimation = fill.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
      duration: dwell,
      easing: "linear",
      fill: "forwards",
    });
  }

  /** Put the current panel in the middle of the screen; `animate` eases there from the last one. */
  private place(animate: boolean): void {
    const panel = this.options.card.panels[this.index];
    if (!panel) return;
    const view = panelView(panel, window.innerWidth, window.innerHeight);
    this.stage.style.transition = animate ? `transform ${MOVE_MS}ms ${MOVE_EASE}` : "none";
    this.sharp.style.transition = animate ? `clip-path ${MOVE_MS}ms ${MOVE_EASE}` : "none";
    this.stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    this.sharp.style.clipPath = panelClip(panel, this.options.card);
    const centre = `${panel.x + panel.w / 2}px ${panel.y + panel.h / 2}px`;
    this.drift.style.transformOrigin = centre;
    this.stage.style.perspectiveOrigin = centre;
  }

  /**
   * The move from one panel to the next, made to feel fast: speed lines
   * streak the way the view travels and the card blurs at full speed,
   * both gone as it lands.
   */
  private rush(from: CardPanel, to: CardPanel | undefined): void {
    if (!to || typeof this.speed.animate !== "function") return;
    const dx = to.x + to.w / 2 - (from.x + from.w / 2);
    const dy = to.y + to.h / 2 - (from.y + from.h / 2);
    // Lines lie along the travel and sweep back past the view, as the art does
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    this.speed.animate(
      [
        { opacity: 0, transform: `rotate(${angle}deg) translateX(8%) scaleX(1)` },
        { opacity: 1, offset: 0.45 },
        { opacity: 0, transform: `rotate(${angle}deg) translateX(-14%) scaleX(1.35)` },
      ],
      { duration: MOVE_MS, easing: "ease-in-out" },
    );
    this.stage.animate([{ filter: "blur(0px)" }, { filter: "blur(2.5px)", offset: 0.5 }, { filter: "blur(0px)" }], {
      duration: MOVE_MS,
      easing: "ease-in-out",
    });
  }

  /**
   * A slow push on the panel while it is read, a different way on each one,
   * with a slight turn in depth, as a photo held in the hand tips a little.
   */
  private startDrift(dwell: number): void {
    this.driftAnimation?.cancel();
    if (typeof this.drift.animate !== "function") return;
    const way = this.index % 2 === 0 ? 1 : -1;
    this.driftAnimation = this.drift.animate(
      [
        { transform: `rotateY(${-2 * way}deg) rotateX(1.2deg) rotate(${-0.7 * way}deg) scale(1) translate(0, 0)` },
        {
          transform: `rotateY(${1.5 * way}deg) rotateX(-0.9deg) rotate(${0.5 * way}deg) scale(1.045) translate(${-7 * way}px, -5px)`,
        },
      ],
      { duration: dwell + MOVE_MS, easing: "ease-in-out", fill: "both" },
    );
  }

  private finishPanels(): void {
    if (this.phase !== "panels" && this.phase !== "opening") return;
    this.phase = "waiting";
    this.clearTimers();
    this.root.classList.remove("campaign-cut--art");
    this.root.classList.add("campaign-cut--waiting");
    this.later(() => this.driftAnimation?.cancel(), FADE_MS * 2);
    this.options.onPanelsDone();
  }

  private later(callback: () => void, ms: number): void {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, ms);
    this.timers.add(timer);
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => this.later(resolve, ms));
  }

  private clearTimers(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
  }
}
