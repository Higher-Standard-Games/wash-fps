/**
 * DemoViewerHUD — Transport controls overlay for demo playback
 *
 * Renders a timeline scrubber, play/pause button, speed selector,
 * current time / total time, and a player list for chase-cam selection.
 *
 * This is a DOM-based overlay, similar to SpectatorOverlay.
 */

import type { DemoViewerInfo } from "./DemoViewer";

// ─── DemoViewerHUD ───────────────────────────────────────────────

export class DemoViewerHUD {
  private container: HTMLDivElement | null = null;
  private timelineBar: HTMLDivElement | null = null;
  private timelineFill: HTMLDivElement | null = null;
  private timelineHandle: HTMLDivElement | null = null;
  private controlsRow: HTMLDivElement | null = null;
  private playPauseBtn: HTMLButtonElement | null = null;
  private speedLabel: HTMLSpanElement | null = null;
  private timeLabel: HTMLSpanElement | null = null;
  private playerList: HTMLDivElement | null = null;
  private statusLabel: HTMLSpanElement | null = null;
  private collapseBtn: HTMLButtonElement | null = null;
  private hudBtn: HTMLButtonElement | null = null;

  /** Signature of the last-rendered player list — avoids rebuilding buttons every frame (eats clicks) */
  private _playerListSig = "";

  // Collapse state
  private collapsed = false;

  // Callbacks
  private _onSeek: ((progress: number) => void) | null = null;
  private _onPlayPause: (() => void) | null = null;
  private _onSpeedChange: (() => void) | null = null;
  private _onPlayerSelect: ((entityId: string) => void) | null = null;
  private _onHudToggle: (() => void) | null = null;

  // State
  private isDragging = false;
  private _mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private _mouseUpHandler: (() => void) | null = null;

  constructor() {
    this.build();
  }

  // ── DOM Construction ────────────────────────────────────────────

  private build(): void {
    this.container = document.createElement("div");
    this.container.id = "demo-viewer-hud";
    this.container.style.cssText = `
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0.3));
      padding: 12px 20px 16px;
      color: #fff;
      font-family: 'Inter', 'Segoe UI', sans-serif;
      font-size: 13px;
      z-index: 10000;
      user-select: none;
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    `;

    // ── Timeline ────────────────────────────────
    this.timelineBar = document.createElement("div");
    this.timelineBar.style.cssText = `
      width: 100%;
      height: 6px;
      background: rgba(255,255,255,0.15);
      border-radius: 3px;
      cursor: pointer;
      position: relative;
    `;

    this.timelineFill = document.createElement("div");
    this.timelineFill.style.cssText = `
      height: 100%;
      background: linear-gradient(90deg, #4ecdc4, #45b7d1);
      border-radius: 3px;
      width: 0%;
      transition: width 0.1s ease;
    `;

    this.timelineHandle = document.createElement("div");
    this.timelineHandle.style.cssText = `
      position: absolute;
      top: -4px;
      width: 14px;
      height: 14px;
      background: #fff;
      border-radius: 50%;
      box-shadow: 0 0 4px rgba(0,0,0,0.4);
      left: 0%;
      transform: translateX(-50%);
      cursor: grab;
    `;

    this.timelineBar.appendChild(this.timelineFill);
    this.timelineBar.appendChild(this.timelineHandle);
    this.container.appendChild(this.timelineBar);

    // ── Controls row ────────────────────────────
    this.controlsRow = document.createElement("div");
    this.controlsRow.style.cssText = `
      display: flex;
      align-items: center;
      gap: 12px;
    `;

    // Play/Pause button
    this.playPauseBtn = document.createElement("button");
    this.playPauseBtn.textContent = "▶";
    this.playPauseBtn.style.cssText = `
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      color: #fff;
      font-size: 16px;
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
    `;
    this.controlsRow.appendChild(this.playPauseBtn);

    // Speed
    this.speedLabel = document.createElement("span");
    this.speedLabel.textContent = "1.0x";
    this.speedLabel.style.cssText = `
      cursor: pointer;
      padding: 2px 8px;
      background: rgba(255,255,255,0.1);
      border-radius: 3px;
      min-width: 40px;
      text-align: center;
    `;
    this.controlsRow.appendChild(this.speedLabel);

    // The game HUD over playback: the followed player's own screen
    this.hudBtn = document.createElement("button");
    this.hudBtn.textContent = "HUD";
    this.hudBtn.title = "Show or hide the game HUD";
    this.hudBtn.style.cssText = `
      cursor: pointer;
      padding: 2px 8px;
      border-radius: 3px;
      border: 1px solid rgba(255,255,255,0.15);
      color: inherit;
      font: inherit;
    `;
    this.hudBtn.addEventListener("click", () => this._onHudToggle?.());
    this.controlsRow.appendChild(this.hudBtn);
    this.setGameHudVisible(true);

    // Time
    this.timeLabel = document.createElement("span");
    this.timeLabel.textContent = "0:00 / 0:00";
    this.timeLabel.style.cssText = `
      opacity: 0.7;
      font-variant-numeric: tabular-nums;
    `;
    this.controlsRow.appendChild(this.timeLabel);

    // Spacer
    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    this.controlsRow.appendChild(spacer);

    // Status label (PLAYING / PAUSED / DEMO)
    this.statusLabel = document.createElement("span");
    this.statusLabel.textContent = "DEMO";
    this.statusLabel.style.cssText = `
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      opacity: 0.5;
    `;
    this.controlsRow.appendChild(this.statusLabel);

    // Collapse toggle button
    this.collapseBtn = document.createElement("button");
    this.collapseBtn.textContent = "▼";
    this.collapseBtn.title = "Minimize HUD";
    this.collapseBtn.style.cssText = `
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      color: rgba(255,255,255,0.6);
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 3px;
      cursor: pointer;
      margin-left: 4px;
    `;
    this.collapseBtn.addEventListener("click", () => this._toggleCollapse());
    this.controlsRow.appendChild(this.collapseBtn);

    this.container.appendChild(this.controlsRow);

    // ── Player list (hidden by default) ─────────
    this.playerList = document.createElement("div");
    this.playerList.style.cssText = `
      display: none;
      gap: 6px;
      flex-wrap: wrap;
    `;
    this.container.appendChild(this.playerList);

    // ── Event handlers ────────────────────────
    this.setupEvents();

    document.body.appendChild(this.container);
  }

  private setupEvents(): void {
    // Timeline click/drag
    this.timelineBar?.addEventListener("mousedown", (e) => {
      this.isDragging = true;
      this.handleSeek(e);
    });

    this._mouseMoveHandler = (e: MouseEvent) => {
      if (this.isDragging) this.handleSeek(e);
    };
    document.addEventListener("mousemove", this._mouseMoveHandler);

    this._mouseUpHandler = () => {
      this.isDragging = false;
    };
    document.addEventListener("mouseup", this._mouseUpHandler);

    // Play/Pause
    this.playPauseBtn?.addEventListener("click", () => {
      this._onPlayPause?.();
    });

    // Speed
    this.speedLabel?.addEventListener("click", () => {
      this._onSpeedChange?.();
    });
  }

  private handleSeek(e: MouseEvent): void {
    if (!this.timelineBar) return;
    const rect = this.timelineBar.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this._onSeek?.(progress);
  }

  // ── Update ──────────────────────────────────────────────────────

  /**
   * Update HUD display from current viewer info.
   */
  update(info: DemoViewerInfo): void {
    if (!this.container) return;

    // Timeline progress
    const progress = info.totalFrames > 1 ? (info.currentFrame / (info.totalFrames - 1)) * 100 : 0;

    if (this.timelineFill) {
      this.timelineFill.style.width = `${progress}%`;
    }
    if (this.timelineHandle) {
      this.timelineHandle.style.left = `${progress}%`;
    }

    // Play/Pause button
    if (this.playPauseBtn) {
      this.playPauseBtn.textContent = info.state === "playing" ? "⏸" : "▶";
    }

    // Speed
    if (this.speedLabel) {
      this.speedLabel.textContent = `${info.playbackSpeed}x`;
    }

    // Time display
    if (this.timeLabel) {
      const elapsed = this.formatTime(info.elapsedMs);
      const total = this.formatTime(info.durationMs);
      this.timeLabel.textContent = `${elapsed} / ${total}`;
    }

    // Status
    if (this.statusLabel) {
      const stateMap: Record<string, string> = {
        idle: "DEMO",
        loaded: "READY",
        playing: "● PLAYING",
        paused: "⏸ PAUSED",
        ended: "ENDED",
      };
      this.statusLabel.textContent = stateMap[info.state] || "DEMO";
    }
  }

  /**
   * Show the player list for chase-cam selection.
   */
  setPlayerList(players: Array<{ entityId: string; name: string; isTarget: boolean }>): void {
    if (!this.playerList) return;

    // Skip the rebuild when nothing changed. This is called every frame; without
    // the guard, innerHTML="" destroys the button between mousedown and mouseup so
    // clicks never register (can't switch spectate target).
    const sig = players.map((p) => `${p.entityId}:${p.isTarget ? 1 : 0}:${p.name}`).join("|");
    if (sig === this._playerListSig) return;
    this._playerListSig = sig;

    this.playerList.innerHTML = "";
    this.playerList.style.display = !this.collapsed && players.length > 0 ? "flex" : "none";

    for (const player of players) {
      const btn = document.createElement("button");
      btn.textContent = player.name;
      btn.style.cssText = `
        background: ${player.isTarget ? "rgba(78, 205, 196, 0.3)" : "rgba(255,255,255,0.08)"};
        border: 1px solid ${player.isTarget ? "#4ecdc4" : "rgba(255,255,255,0.15)"};
        color: #fff;
        padding: 3px 10px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
      `;
      btn.addEventListener("click", () => {
        this._onPlayerSelect?.(player.entityId);
      });
      this.playerList.appendChild(btn);
    }
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

  /** Reflect whether the game HUD is on. */
  setGameHudVisible(visible: boolean): void {
    if (!this.hudBtn) return;
    this.hudBtn.setAttribute("aria-pressed", String(visible));
    this.hudBtn.style.background = visible ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.06)";
    this.hudBtn.style.opacity = visible ? "1" : "0.6";
  }

  onPlayerSelect(callback: (entityId: string) => void): void {
    this._onPlayerSelect = callback;
  }

  // ── Collapse ────────────────────────────────────────────────────

  private _toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    if (!this.controlsRow || !this.playerList || !this.container || !this.collapseBtn) return;
    for (const child of Array.from(this.controlsRow.children)) {
      if (child === this.collapseBtn) continue;
      (child as HTMLElement).style.display = this.collapsed ? "none" : "";
    }
    // The collapse button must stay reachable so the compact HUD can expand.
    this.controlsRow.style.display = "flex";
    if (this.collapsed) {
      this.playerList.style.display = "none";
      this.container.style.padding = "0";
      this.collapseBtn.textContent = "▲";
      this.collapseBtn.title = "Expand HUD";
      this.collapseBtn.style.marginLeft = "auto";
      // Keep the timeline bar visible but compact the container
      this.container.style.background = "transparent";
    } else {
      this.playerList.style.display = this.playerList.childElementCount > 0 ? "flex" : "none";
      this.container.style.padding = "12px 20px 16px";
      this.collapseBtn.textContent = "▼";
      this.collapseBtn.title = "Minimize HUD";
      this.collapseBtn.style.marginLeft = "4px";
      this.container.style.background = "linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0.3))";
    }
  }

  // ── Visibility ──────────────────────────────────────────────────

  show(): void {
    if (this.container) this.container.style.display = "flex";
  }

  hide(): void {
    if (this.container) this.container.style.display = "none";
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  dispose(): void {
    // Remove global event listeners
    if (this._mouseMoveHandler) {
      document.removeEventListener("mousemove", this._mouseMoveHandler);
      this._mouseMoveHandler = null;
    }
    if (this._mouseUpHandler) {
      document.removeEventListener("mouseup", this._mouseUpHandler);
      this._mouseUpHandler = null;
    }

    // Remove DOM
    this.container?.remove();
    this.container = null;
    this.timelineBar = null;
    this.timelineFill = null;
    this.timelineHandle = null;
    this.controlsRow = null;
    this.playPauseBtn = null;
    this.speedLabel = null;
    this.timeLabel = null;
    this.playerList = null;
    this.statusLabel = null;
    this.collapseBtn = null;
    this.hudBtn = null;
    this._onSeek = null;
    this._onPlayPause = null;
    this._onSpeedChange = null;
    this._onPlayerSelect = null;
  }
}
