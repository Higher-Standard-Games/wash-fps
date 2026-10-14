/**
 * DemoViewerHUD — the playback controls, for a demo and for a highlight reel.
 *
 * A timeline, play/pause, the game HUD switch, the time, a minimize switch and
 * an exit plate, in the HUD's own look. A demo adds speed and whose eyes the
 * view is behind; a reel adds previous/next shot, a tick on the timeline per
 * shot and a card naming each one. While playback runs untouched the controls
 * fade away, so what is on screen is the player's own screen; moving the
 * mouse, pausing or pointing at them brings them back. Minimized, the bar is a
 * thin strip along the bottom, for recording a reel.
 */

import { createRaisedKey, injectRaisedKeyStyles, setRaisedKeyText } from "../../../engine/ui/components/RaisedKey";
import { UIStyles } from "../../../engine/ui/UIStyles";
import type { DemoViewerInfo } from "./DemoViewer";
import demoViewerHudCss from "./styles/DemoViewerHUD.css?raw";

/** How long the controls stay up after the mouse or a key last moved. */
const IDLE_AFTER_MS = 2500;
/** How long a shot's card stays up after the shot starts. */
const CARD_MS = 3500;

const STATUS: Record<string, string> = {
  idle: "Demo",
  loaded: "Ready",
  playing: "Playing",
  paused: "Paused",
  ended: "Ended",
  analyzing: "Cutting",
};

/** Where a reel is, as the bar shows it. */
export interface ReelProgress {
  state: string;
  /** 0 – 1 through the whole reel. */
  progress: number;
  elapsedMs: number;
  totalMs: number;
  segment: number;
  segments: number;
  isReplay: boolean;
  speed: number;
}

/**
 * A frag or death on a demo's timeline, coloured from the followed player's
 * side: their frags, their deaths, and everyone else's frags.
 */
export interface DemoTimelineEvent {
  /** Where it sits on the timeline (0–1). */
  progress: number;
  /** Where a click seeks to (0–1): a little before it, to see it coming. */
  seekTo: number;
  kind: "frag" | "death" | "other";
  label: string;
}

/** A shot's card: what it is, whose it is, and what made it. */
export interface ShotCard {
  kicker: string;
  title: string;
  player: string;
  detail: string;
  tags: string[];
}

/**
 * A key on the bar: the menu's raised 3D key at the bar's one height. `classes`
 * keep the key's own hooks (dvh-play, dvh-chip, …).
 */
function barKey(label: string, classes: string): HTMLButtonElement {
  const key = createRaisedKey({ label, variants: ["bar", "inline"] });
  key.classList.add(...classes.split(" ").filter(Boolean));
  return key;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
}

function isTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element?.tagName) return false;
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable;
}

export class DemoViewerHUD {
  private container: HTMLDivElement | null = null;
  private exitPlate: HTMLButtonElement | null = null;
  private card: HTMLDivElement | null = null;
  /** A reel's transitions over the picture; part of the picture, so H leaves it. */
  private veil: HTMLDivElement | null = null;
  private timeline: HTMLDivElement | null = null;
  private timelineFill: HTMLDivElement | null = null;
  private timelineHandle: HTMLDivElement | null = null;
  private marks: HTMLDivElement | null = null;
  private eventsLane: HTMLDivElement | null = null;
  private playPauseBtn: HTMLButtonElement | null = null;
  private prevBtn: HTMLButtonElement | null = null;
  private nextBtn: HTMLButtonElement | null = null;
  private speedBtn: HTMLButtonElement | null = null;
  private hudBtn: HTMLButtonElement | null = null;
  private minimizeBtn: HTMLButtonElement | null = null;
  private timeNow: HTMLSpanElement | null = null;
  private timeTotal: HTMLSpanElement | null = null;
  private playerList: HTMLDivElement | null = null;
  private shotLabel: HTMLSpanElement | null = null;
  private statusLabel: HTMLSpanElement | null = null;

  /** Signature of the last-rendered player list: rebuilding every frame eats clicks. */
  private _playerListSig = "";

  private _onSeek: ((progress: number) => void) | null = null;
  private _onPlayPause: (() => void) | null = null;
  private _onSpeedChange: (() => void) | null = null;
  private _onPlayerSelect: ((entityId: string) => void) | null = null;
  private _onHudToggle: (() => void) | null = null;
  private _onExit: (() => void) | null = null;
  private _onPrev: (() => void) | null = null;
  private _onNext: (() => void) | null = null;

  private reel = false;
  private minimized = false;
  private isDragging = false;
  private hovered = false;
  private lastActivity = performance.now();
  private cardTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new AbortController();

  constructor() {
    // The key styles first, so this sheet's bar variant comes after them and wins
    injectRaisedKeyStyles();
    UIStyles.injectCSS("demo-viewer-hud", demoViewerHudCss);
    this.build();
  }

  // ── DOM ─────────────────────────────────────────────────────────

  private build(): void {
    this.container = el("div", "");
    this.container.id = "demo-viewer-hud";

    this.timeline = el("div", "dvh-timeline");
    this.timelineFill = el("div", "dvh-timeline-fill");
    this.marks = el("div", "dvh-marks");
    this.timelineHandle = el("div", "dvh-timeline-handle");
    this.timeline.append(this.timelineFill, this.marks, this.timelineHandle);

    const controls = el("div", "dvh-controls");
    this.playPauseBtn = barKey("▶", "dvh-play");
    this.playPauseBtn.title = "Play or pause (Space)";
    this.prevBtn = barKey("◀◀", "dvh-chip dvh-reel-only");
    this.prevBtn.title = "Previous shot";
    this.nextBtn = barKey("▶▶", "dvh-chip dvh-reel-only");
    this.nextBtn.title = "Next shot";
    this.speedBtn = barKey("1x", "dvh-chip dvh-speed dvh-demo-only");
    this.speedBtn.title = "Playback speed";
    // The game HUD over playback: the followed player's own screen
    this.hudBtn = barKey("HUD", "dvh-chip");
    this.hudBtn.title = "Show or hide the game HUD, seen from a player's eyes";
    const time = el("span", "dvh-time");
    this.timeNow = el("span", "", "0:00");
    this.timeTotal = el("span", "dvh-time-total", " / 0:00");
    time.append(this.timeNow, this.timeTotal);
    this.playerList = el("div", "dvh-players dvh-demo-only");
    this.shotLabel = el("span", "dvh-shot dvh-reel-only");
    this.statusLabel = el("span", "dvh-status", STATUS.idle);
    this.minimizeBtn = barKey("▾", "dvh-chip dvh-minimize");
    this.minimizeBtn.title = "Minimize the controls to a strip";
    controls.append(
      this.playPauseBtn,
      this.prevBtn,
      this.nextBtn,
      this.speedBtn,
      this.hudBtn,
      time,
      el("div", "dvh-spacer"),
      this.playerList,
      this.shotLabel,
      this.statusLabel,
      this.minimizeBtn,
    );
    // The demo's frags and deaths, in a lane of their own under the seek bar
    this.eventsLane = el("div", "dvh-events dvh-demo-only");
    this.eventsLane.setAttribute("aria-label", "Frags and deaths");
    this.container.append(this.timeline, this.eventsLane, controls);

    this.exitPlate = el("button", "dvh-exit", "✕");
    this.exitPlate.id = "demo-viewer-exit";
    this.exitPlate.title = "Leave playback (Esc)";
    this.exitPlate.setAttribute("aria-label", "Leave playback");

    this.card = el("div", "dvh-card");
    this.card.id = "demo-viewer-card";
    this.card.setAttribute("aria-live", "polite");

    this.veil = el("div", "dvh-veil");
    this.veil.id = "demo-viewer-veil";

    this.setGameHudVisible(true);
    this.setupEvents();
    document.body.append(this.veil, this.container, this.exitPlate, this.card);
  }

  private setupEvents(): void {
    const signal = this.listeners.signal;
    this.timeline?.addEventListener(
      "mousedown",
      (e) => {
        this.isDragging = true;
        this.timeline?.classList.add("is-dragging");
        this.handleSeek(e);
      },
      { signal },
    );
    document.addEventListener(
      "mousemove",
      (e) => {
        this.lastActivity = performance.now();
        if (this.isDragging) this.handleSeek(e);
      },
      { signal },
    );
    document.addEventListener(
      "mouseup",
      () => {
        this.isDragging = false;
        this.timeline?.classList.remove("is-dragging");
      },
      { signal },
    );
    document.addEventListener(
      "keydown",
      (e) => {
        this.lastActivity = performance.now();
        if (e.code !== "Escape" || e.repeat || isTextEntry(e.target) || !this._onExit) return;
        e.preventDefault();
        this._onExit();
      },
      { signal },
    );
    for (const area of [this.container, this.exitPlate]) {
      area?.addEventListener("mouseenter", () => (this.hovered = true), { signal });
      area?.addEventListener("mouseleave", () => (this.hovered = false), { signal });
    }
    this.playPauseBtn?.addEventListener("click", () => this._onPlayPause?.(), { signal });
    this.prevBtn?.addEventListener("click", () => this._onPrev?.(), { signal });
    this.nextBtn?.addEventListener("click", () => this._onNext?.(), { signal });
    this.speedBtn?.addEventListener("click", () => this._onSpeedChange?.(), { signal });
    this.hudBtn?.addEventListener("click", () => this._onHudToggle?.(), { signal });
    this.minimizeBtn?.addEventListener("click", () => this.setMinimized(!this.minimized), { signal });
    this.exitPlate?.addEventListener("click", () => this._onExit?.(), { signal });
  }

  private handleSeek(e: MouseEvent): void {
    if (!this.timeline) return;
    const rect = this.timeline.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this._onSeek?.(progress);
  }

  // ── Modes ───────────────────────────────────────────────────────

  /**
   * A reel: the timeline is the reel's, with a tick where each shot starts
   * (fractions of the reel), and the controls step between shots. Null for a
   * plain demo.
   */
  setReel(shotStarts: number[] | null): void {
    this.reel = shotStarts !== null;
    this.container?.classList.toggle("is-reel", this.reel);
    this.marks?.replaceChildren(
      ...(shotStarts ?? []).map((at) => {
        const mark = el("span", "dvh-mark");
        mark.style.left = `${at * 100}%`;
        return mark;
      }),
    );
  }

  /** Down to a strip along the bottom, or back up. */
  setMinimized(minimized: boolean): void {
    this.minimized = minimized;
    this.container?.classList.toggle("is-min", minimized);
    if (this.minimizeBtn) {
      setRaisedKeyText(this.minimizeBtn, minimized ? "▴" : "▾");
      this.minimizeBtn.title = minimized ? "Bring the controls back" : "Minimize the controls to a strip";
    }
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  // ── Update ──────────────────────────────────────────────────────

  /** Bring a demo's display up to date with the viewer, once a frame. */
  update(info: DemoViewerInfo): void {
    if (!this.container || this.reel) return;
    const progress = info.totalFrames > 1 ? info.currentFrame / (info.totalFrames - 1) : 0;
    this.render(progress, info.elapsedMs, info.durationMs, info.state);
    if (this.speedBtn) setRaisedKeyText(this.speedBtn, `${info.playbackSpeed}x`);
  }

  /** Bring a reel's display up to date with the reel, once a frame. */
  updateReel(info: ReelProgress): void {
    if (!this.container || !this.reel) return;
    this.render(info.progress, info.elapsedMs, info.totalMs, info.state);
    if (this.shotLabel) {
      const speed = info.speed < 0.99 ? ` · ${Math.round(info.speed * 100) / 100}x` : "";
      this.shotLabel.textContent = `${info.isReplay ? "Replay" : "Shot"} ${info.segment + 1}/${info.segments}${speed}`;
      this.shotLabel.classList.toggle("is-replay", info.isReplay);
    }
  }

  private render(progress: number, elapsedMs: number, totalMs: number, state: string): void {
    if (!this.container) return;
    const percent = `${Math.max(0, Math.min(1, progress)) * 100}%`;
    if (this.timelineFill) this.timelineFill.style.width = percent;
    if (this.timelineHandle) this.timelineHandle.style.left = percent;
    const playing = state === "playing";
    if (this.playPauseBtn) setRaisedKeyText(this.playPauseBtn, playing ? "❚❚" : "▶");
    if (this.timeNow) this.timeNow.textContent = formatTime(elapsedMs);
    if (this.timeTotal) this.timeTotal.textContent = ` / ${formatTime(totalMs)}`;
    if (this.statusLabel) {
      this.statusLabel.textContent = STATUS[state] ?? STATUS.idle;
      this.statusLabel.classList.toggle("is-playing", playing);
      this.statusLabel.classList.toggle("is-paused", state === "paused");
    }
    const idle = playing && !this.hovered && !this.isDragging && performance.now() - this.lastActivity > IDLE_AFTER_MS;
    this.container.classList.toggle("is-idle", idle);
    this.exitPlate?.classList.toggle("is-idle", idle);
  }

  /** Whose eyes the view can be behind; the followed one is gold. */
  setPlayerList(players: Array<{ entityId: string; name: string; isTarget: boolean }>): void {
    if (!this.playerList) return;
    const sig = players.map((p) => `${p.entityId}:${p.isTarget ? 1 : 0}:${p.name}`).join("|");
    if (sig === this._playerListSig) return;
    this._playerListSig = sig;

    this.playerList.replaceChildren();
    if (players.length === 0) return;
    this.playerList.append(el("span", "dvh-players-label", "POV"));
    for (const player of players) {
      const btn = barKey(player.name, `dvh-chip dvh-player${player.isTarget ? " is-target" : ""}`);
      btn.title = `Watch from ${player.name}`;
      btn.addEventListener("click", () => this._onPlayerSelect?.(player.entityId));
      this.playerList.appendChild(btn);
    }
  }

  /** Reflect whether the game HUD is switched on. */
  setGameHudVisible(visible: boolean): void {
    if (!this.hudBtn) return;
    this.hudBtn.classList.toggle("is-on", visible);
    this.hudBtn.setAttribute("aria-pressed", String(visible));
  }

  /** The HUD shows only from a player's eyes; the switch dims during other shots. */
  setGameHudAvailable(available: boolean): void {
    this.hudBtn?.classList.toggle("is-unavailable", !available);
  }

  /** Cover the picture for a transition: black or white, 0 clear – 1 covered. */
  setVeil(color: "black" | "white", opacity: number): void {
    if (!this.veil) return;
    const shown = Math.max(0, Math.min(1, opacity));
    this.veil.style.opacity = String(shown);
    this.veil.classList.toggle("is-white", color === "white");
  }

  /** The card for a shot that just started; it goes again after a few seconds. */
  showCard(card: ShotCard): void {
    if (!this.card) return;
    const tags = el("div", "dvh-card-tags");
    tags.append(...card.tags.map((tag) => el("span", "dvh-card-tag", tag)));
    this.card.replaceChildren(
      el("div", "dvh-card-kicker", card.kicker),
      el("div", "dvh-card-title", card.title),
      el("div", "dvh-card-player", card.player),
      ...(card.detail ? [el("div", "dvh-card-detail", card.detail)] : []),
      ...(card.tags.length ? [tags] : []),
    );
    this.card.classList.add("is-shown");
    if (this.cardTimer !== null) clearTimeout(this.cardTimer);
    this.cardTimer = setTimeout(() => this.card?.classList.remove("is-shown"), CARD_MS);
  }

  // ── Callbacks ───────────────────────────────────────────────────

  /** Mark the demo's frags and deaths under the seek bar; a click seeks to one. */
  setEvents(events: readonly DemoTimelineEvent[]): void {
    const lane = this.eventsLane;
    if (!lane) return;
    lane.replaceChildren(
      ...events.map((event) => {
        const mark = el("button", `dvh-event dvh-event--${event.kind}`);
        mark.type = "button";
        mark.style.left = `${Math.max(0, Math.min(1, event.progress)) * 100}%`;
        mark.title = event.label;
        mark.setAttribute("aria-label", event.label);
        mark.addEventListener("click", () => this._onSeek?.(event.seekTo));
        return mark;
      }),
    );
  }

  onSeek(callback: (progress: number) => void): void {
    this._onSeek = callback;
  }

  onPlayPause(callback: () => void): void {
    this._onPlayPause = callback;
  }

  onSpeedChange(callback: () => void): void {
    this._onSpeedChange = callback;
  }

  onHudToggle(callback: () => void): void {
    this._onHudToggle = callback;
  }

  onPlayerSelect(callback: (entityId: string) => void): void {
    this._onPlayerSelect = callback;
  }

  onExit(callback: () => void): void {
    this._onExit = callback;
  }

  onPrev(callback: () => void): void {
    this._onPrev = callback;
  }

  onNext(callback: () => void): void {
    this._onNext = callback;
  }

  // ── Visibility ──────────────────────────────────────────────────

  show(): void {
    if (this.container) this.container.style.display = "flex";
    if (this.exitPlate) this.exitPlate.style.display = "";
    if (this.card) this.card.style.display = "";
  }

  hide(): void {
    if (this.container) this.container.style.display = "none";
    if (this.exitPlate) this.exitPlate.style.display = "none";
    if (this.card) this.card.style.display = "none";
  }

  dispose(): void {
    this.listeners.abort();
    if (this.cardTimer !== null) clearTimeout(this.cardTimer);
    this.cardTimer = null;
    this.container?.remove();
    this.exitPlate?.remove();
    this.card?.remove();
    this.veil?.remove();
    this.veil = null;
    this.container = null;
    this.exitPlate = null;
    this.card = null;
    this.timeline = null;
    this.timelineFill = null;
    this.timelineHandle = null;
    this.marks = null;
    this.playPauseBtn = null;
    this.prevBtn = null;
    this.nextBtn = null;
    this.speedBtn = null;
    this.hudBtn = null;
    this.minimizeBtn = null;
    this.timeNow = null;
    this.timeTotal = null;
    this.playerList = null;
    this.shotLabel = null;
    this.statusLabel = null;
    this._onSeek = null;
    this._onPlayPause = null;
    this._onSpeedChange = null;
    this._onPlayerSelect = null;
    this._onHudToggle = null;
    this._onExit = null;
    this._onPrev = null;
    this._onNext = null;
    UIStyles.removeCSS("demo-viewer-hud");
  }
}
