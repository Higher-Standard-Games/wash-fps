/**
 * DemoViewerHUD — the demo playback bar.
 *
 * A timeline scrubber, play/pause, speed, the game HUD switch, the time, and
 * whose eyes the view is behind, in the HUD's own look. While a demo plays
 * untouched the bar fades away, so what is on screen is the player's own
 * screen; moving the mouse, pausing or pointing at the bar brings it back.
 */

import { UIStyles } from "../../../engine/ui/UIStyles";
import type { DemoViewerInfo } from "./DemoViewer";
import demoViewerHudCss from "./styles/DemoViewerHUD.css?raw";

/** How long the bar stays up after the mouse or a key last moved. */
const IDLE_AFTER_MS = 2500;

const STATUS: Record<string, string> = {
  idle: "Demo",
  loaded: "Ready",
  playing: "Playing",
  paused: "Paused",
  ended: "Ended",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

export class DemoViewerHUD {
  private container: HTMLDivElement | null = null;
  private timeline: HTMLDivElement | null = null;
  private timelineFill: HTMLDivElement | null = null;
  private timelineHandle: HTMLDivElement | null = null;
  private playPauseBtn: HTMLButtonElement | null = null;
  private speedBtn: HTMLButtonElement | null = null;
  private hudBtn: HTMLButtonElement | null = null;
  private timeNow: HTMLSpanElement | null = null;
  private timeTotal: HTMLSpanElement | null = null;
  private playerList: HTMLDivElement | null = null;
  private statusLabel: HTMLSpanElement | null = null;

  /** Signature of the last-rendered player list: rebuilding every frame eats clicks. */
  private _playerListSig = "";

  private _onSeek: ((progress: number) => void) | null = null;
  private _onPlayPause: (() => void) | null = null;
  private _onSpeedChange: (() => void) | null = null;
  private _onPlayerSelect: ((entityId: string) => void) | null = null;
  private _onHudToggle: (() => void) | null = null;

  private isDragging = false;
  private hovered = false;
  private lastActivity = performance.now();
  private readonly listeners = new AbortController();

  constructor() {
    UIStyles.injectCSS("demo-viewer-hud", demoViewerHudCss);
    this.build();
  }

  // ── DOM ─────────────────────────────────────────────────────────

  private build(): void {
    this.container = el("div", "");
    this.container.id = "demo-viewer-hud";

    this.timeline = el("div", "dvh-timeline");
    this.timelineFill = el("div", "dvh-timeline-fill");
    this.timelineHandle = el("div", "dvh-timeline-handle");
    this.timeline.append(this.timelineFill, this.timelineHandle);

    const controls = el("div", "dvh-controls");
    this.playPauseBtn = el("button", "dvh-play", "▶");
    this.playPauseBtn.title = "Play or pause";
    this.speedBtn = el("button", "dvh-chip dvh-speed", "1x");
    this.speedBtn.title = "Playback speed";
    // The game HUD over playback: the followed player's own screen
    this.hudBtn = el("button", "dvh-chip", "HUD");
    this.hudBtn.title = "Show or hide the game HUD";
    const time = el("span", "dvh-time");
    this.timeNow = el("span", "", "0:00");
    this.timeTotal = el("span", "dvh-time-total", " / 0:00");
    time.append(this.timeNow, this.timeTotal);
    this.playerList = el("div", "dvh-players");
    this.statusLabel = el("span", "dvh-status", STATUS.idle);
    controls.append(
      this.playPauseBtn,
      this.speedBtn,
      this.hudBtn,
      time,
      el("div", "dvh-spacer"),
      this.playerList,
      this.statusLabel,
    );

    this.container.append(this.timeline, controls);
    this.setGameHudVisible(true);
    this.setupEvents();
    document.body.appendChild(this.container);
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
    document.addEventListener("keydown", () => (this.lastActivity = performance.now()), { signal });
    this.container?.addEventListener("mouseenter", () => (this.hovered = true), { signal });
    this.container?.addEventListener("mouseleave", () => (this.hovered = false), { signal });
    this.playPauseBtn?.addEventListener("click", () => this._onPlayPause?.(), { signal });
    this.speedBtn?.addEventListener("click", () => this._onSpeedChange?.(), { signal });
    this.hudBtn?.addEventListener("click", () => this._onHudToggle?.(), { signal });
  }

  private handleSeek(e: MouseEvent): void {
    if (!this.timeline) return;
    const rect = this.timeline.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this._onSeek?.(progress);
  }

  // ── Update ──────────────────────────────────────────────────────

  /** Bring the display up to date with the viewer, once a frame. */
  update(info: DemoViewerInfo): void {
    if (!this.container) return;

    const progress = info.totalFrames > 1 ? (info.currentFrame / (info.totalFrames - 1)) * 100 : 0;
    if (this.timelineFill) this.timelineFill.style.width = `${progress}%`;
    if (this.timelineHandle) this.timelineHandle.style.left = `${progress}%`;

    const playing = info.state === "playing";
    if (this.playPauseBtn) this.playPauseBtn.textContent = playing ? "❚❚" : "▶";
    if (this.speedBtn) this.speedBtn.textContent = `${info.playbackSpeed}x`;
    if (this.timeNow) this.timeNow.textContent = this.formatTime(info.elapsedMs);
    if (this.timeTotal) this.timeTotal.textContent = ` / ${this.formatTime(info.durationMs)}`;
    if (this.statusLabel) {
      this.statusLabel.textContent = STATUS[info.state] ?? STATUS.idle;
      this.statusLabel.classList.toggle("is-playing", playing);
      this.statusLabel.classList.toggle("is-paused", info.state === "paused");
    }

    const idle = playing && !this.hovered && !this.isDragging && performance.now() - this.lastActivity > IDLE_AFTER_MS;
    this.container.classList.toggle("is-idle", idle);
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
      const btn = el("button", `dvh-chip dvh-player${player.isTarget ? " is-target" : ""}`, player.name);
      btn.title = `Watch from ${player.name}`;
      btn.addEventListener("click", () => this._onPlayerSelect?.(player.entityId));
      this.playerList.appendChild(btn);
    }
  }

  /** Reflect whether the game HUD is on. */
  setGameHudVisible(visible: boolean): void {
    if (!this.hudBtn) return;
    this.hudBtn.classList.toggle("is-on", visible);
    this.hudBtn.setAttribute("aria-pressed", String(visible));
  }

  // ── Callbacks ───────────────────────────────────────────────────

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

  // ── Visibility ──────────────────────────────────────────────────

  show(): void {
    if (this.container) this.container.style.display = "flex";
  }

  hide(): void {
    if (this.container) this.container.style.display = "none";
  }

  private formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  dispose(): void {
    this.listeners.abort();
    this.container?.remove();
    this.container = null;
    this.timeline = null;
    this.timelineFill = null;
    this.timelineHandle = null;
    this.playPauseBtn = null;
    this.speedBtn = null;
    this.hudBtn = null;
    this.timeNow = null;
    this.timeTotal = null;
    this.playerList = null;
    this.statusLabel = null;
    this._onSeek = null;
    this._onPlayPause = null;
    this._onSpeedChange = null;
    this._onPlayerSelect = null;
    this._onHudToggle = null;
    UIStyles.removeCSS("demo-viewer-hud");
  }
}
