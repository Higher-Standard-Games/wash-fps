/**
 * CinematicHUD — Minimal "movie mode" overlay for cinematic demo playback
 *
 * Two parts:
 *   - Top-left info card: highlight number, type, player, weapon, tags (auto-hides 3s)
 *   - Bottom bar: reel progress, time, speed label, REPLAY badge
 *
 * Usage:
 *   const hud = new CinematicHUD();
 *   // On segment change:
 *   hud.showSegmentInfo(segment, totalSegments);
 *   // Each render frame:
 *   hud.updateProgress(player.getReelInfo());
 *   // Cleanup:
 *   hud.dispose();
 *
 * Keyboard bindings (Space, Esc, ←, →) are wired by the caller; the HUD
 * only provides the visual layer.
 */

import type { CinematicSegment } from "../../../shared/demo/SequenceBuilder";
import type { ReelInfo } from "./CinematicDemoPlayer";

// ── Human-readable label maps ─────────────────────────────────────────────────

const HIGHLIGHT_LABELS: Record<string, string> = {
  frag: "FRAG",
  multi_kill: "MULTI KILL",
  airborne_frag: "AIRBORNE FRAG",
  streak_kill: "STREAK KILL",
  first_blood: "FIRST BLOOD",
  movement: "MOVEMENT",
};

const TAG_LABELS: Record<string, string> = {
  airborne: "AIR",
  rocket_jump: "RJ",
  low_hp: "LOW HP",
  close_range: "CLOSE",
  long_range: "LONG",
  multi_kill: "MULTI",
  revenge: "REVENGE",
  first_blood: "FIRST",
  on_fire: "ON FIRE",
  raging: "RAGING",
  unstoppable: "UNSTOPPABLE",
  high_speed: "SPEED",
  trick_jump: "TRICK",
  height_gain: "HEIGHT",
};

// ── CinematicHUD ──────────────────────────────────────────────────────────────

export class CinematicHUD {
  private container: HTMLDivElement;
  private infoCard: HTMLDivElement;
  private bottomBar: HTMLDivElement;

  // Bottom bar sub-elements
  private progressFill!: HTMLDivElement;
  private timeLabel!: HTMLSpanElement;
  private speedLabel!: HTMLSpanElement;
  private replayBadge!: HTMLSpanElement;

  // Info card sub-elements
  private segmentLabel!: HTMLSpanElement;
  private highlightTypeLabel!: HTMLDivElement;
  private playerLabel!: HTMLDivElement;
  private weaponLabel!: HTMLDivElement;
  private tagsRow!: HTMLDivElement;

  private infoHideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.container = this._buildContainer();
    this.infoCard = this._buildInfoCard();
    this.bottomBar = this._buildBottomBar();

    this.container.appendChild(this.infoCard);
    this.container.appendChild(this.bottomBar);
    document.body.appendChild(this.container);
  }

  // ── Segment info card ─────────────────────────────────────────────────────

  /**
   * Show the info card for the current segment. Auto-hides after 3 seconds.
   */
  showSegmentInfo(segment: CinematicSegment, totalSegments: number): void {
    const h = segment.highlight;
    const segNum = segment.segmentIndex + 1;

    // Header line
    this.segmentLabel.textContent = segment.isReplay
      ? `REPLAY  ${segNum}/${totalSegments}`
      : `⚡ HIGHLIGHT  ${segNum}/${totalSegments}`;

    // Highlight type
    const killCount = h.killCount && h.killCount > 1 ? ` (×${h.killCount})` : "";
    this.highlightTypeLabel.textContent = (HIGHLIGHT_LABELS[h.type] ?? h.type.toUpperCase()) + killCount;

    // Player
    this.playerLabel.textContent = h.primaryPlayerName;

    // Weapon
    this.weaponLabel.textContent = h.weaponId ? h.weaponId.replace(/_/g, " ").toUpperCase() : "";
    this.weaponLabel.style.display = h.weaponId ? "block" : "none";

    // Tags
    this.tagsRow.innerHTML = "";
    for (const tag of h.tags) {
      const badge = document.createElement("span");
      badge.textContent = TAG_LABELS[tag] ?? tag.toUpperCase();
      badge.style.cssText = `
        padding: 2px 6px; border-radius: 3px; font-size: 9px; font-weight: 700;
        letter-spacing: 0.08em; background: rgba(255,180,60,0.15);
        border: 1px solid rgba(255,180,60,0.3); color: rgba(255,180,60,0.9);
      `;
      this.tagsRow.appendChild(badge);
    }

    // Show card
    this.infoCard.style.opacity = "1";
    this.infoCard.style.transform = "translateY(0)";

    // Auto-hide after 3 seconds
    if (this.infoHideTimer !== null) clearTimeout(this.infoHideTimer);
    this.infoHideTimer = setTimeout(() => {
      this.infoCard.style.opacity = "0";
      this.infoCard.style.transform = "translateY(-8px)";
    }, 3000);
  }

  // ── Bottom bar ────────────────────────────────────────────────────────────

  /**
   * Update the bottom progress bar. Call this every render frame.
   */
  updateProgress(info: ReelInfo): void {
    // Progress fill
    this.progressFill.style.width = `${info.reelProgress * 100}%`;

    // Time
    this.timeLabel.textContent = `${this._fmtMs(info.reelElapsedMs)} / ${this._fmtMs(info.reelTotalMs)}`;

    // Speed
    this.speedLabel.textContent = info.currentSpeed !== 1.0 ? `${info.currentSpeed}×` : "";
    this.speedLabel.style.display = info.currentSpeed !== 1.0 ? "inline" : "none";

    // Replay badge
    this.replayBadge.style.display = info.isReplay ? "inline" : "none";

    // Pause indicator on play button (handled via showPaused)
    if (info.state === "paused") {
      this.bottomBar.style.opacity = "0.6";
    } else {
      this.bottomBar.style.opacity = "1";
    }
  }

  // ── Visibility ────────────────────────────────────────────────────────────

  show(): void {
    this.container.style.display = "block";
  }

  hide(): void {
    this.container.style.display = "none";
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────

  private _buildContainer(): HTMLDivElement {
    const el = document.createElement("div");
    el.id = "cinematic-hud";
    el.style.cssText = `
      position: fixed; inset: 0; pointer-events: none;
      z-index: 10500;
      font-family: var(--w-font-display, 'Orbitron', 'Inter', sans-serif);
    `;
    return el;
  }

  private _buildInfoCard(): HTMLDivElement {
    const card = document.createElement("div");
    card.style.cssText = `
      position: absolute; top: 20px; left: 20px;
      background: rgba(0,0,0,0.65); border: 1px solid rgba(255,180,60,0.25);
      border-radius: 6px; padding: 12px 16px; min-width: 220px;
      opacity: 0; transform: translateY(-8px);
      transition: opacity 0.3s ease, transform 0.3s ease;
      pointer-events: none;
    `;

    // Segment counter
    this.segmentLabel = document.createElement("span");
    this.segmentLabel.style.cssText = `
      display: block; font-size: 9px; font-weight: 700; letter-spacing: 0.18em;
      color: rgba(255,180,60,0.75); margin-bottom: 6px;
    `;
    card.appendChild(this.segmentLabel);

    // Highlight type (big)
    this.highlightTypeLabel = document.createElement("div");
    this.highlightTypeLabel.style.cssText = `
      font-size: 16px; font-weight: 700; letter-spacing: 0.1em;
      color: #fff; margin-bottom: 4px;
    `;
    card.appendChild(this.highlightTypeLabel);

    // Player name
    this.playerLabel = document.createElement("div");
    this.playerLabel.style.cssText = `
      font-size: 11px; color: rgba(255,255,255,0.6); margin-bottom: 2px;
    `;
    card.appendChild(this.playerLabel);

    // Weapon
    this.weaponLabel = document.createElement("div");
    this.weaponLabel.style.cssText = `
      font-size: 10px; color: rgba(255,180,60,0.55); margin-bottom: 8px;
    `;
    card.appendChild(this.weaponLabel);

    // Tags row
    this.tagsRow = document.createElement("div");
    this.tagsRow.style.cssText = `display: flex; flex-wrap: wrap; gap: 4px;`;
    card.appendChild(this.tagsRow);

    return card;
  }

  private _buildBottomBar(): HTMLDivElement {
    const bar = document.createElement("div");
    bar.style.cssText = `
      position: absolute; bottom: 0; left: 0; right: 0;
      background: linear-gradient(to top, rgba(0,0,0,0.8), transparent);
      padding: 16px 20px 14px;
      transition: opacity 0.2s;
      pointer-events: none;
    `;

    // Progress track
    const track = document.createElement("div");
    track.style.cssText = `
      width: 100%; height: 3px; background: rgba(255,255,255,0.12);
      border-radius: 2px; margin-bottom: 10px; overflow: hidden;
    `;
    this.progressFill = document.createElement("div");
    this.progressFill.style.cssText = `
      height: 100%; width: 0%;
      background: linear-gradient(90deg, rgba(255,180,60,0.8), rgba(255,220,80,0.9));
      border-radius: 2px; transition: width 0.1s linear;
    `;
    track.appendChild(this.progressFill);
    bar.appendChild(track);

    // Controls row
    const row = document.createElement("div");
    row.style.cssText = `
      display: flex; align-items: center; gap: 12px;
      font-size: 11px; color: rgba(255,255,255,0.5);
    `;

    this.timeLabel = document.createElement("span");
    this.timeLabel.style.cssText = `font-variant-numeric: tabular-nums;`;
    row.appendChild(this.timeLabel);

    this.speedLabel = document.createElement("span");
    this.speedLabel.style.cssText = `color: rgba(255,180,60,0.85); font-weight: 700;`;
    row.appendChild(this.speedLabel);

    this.replayBadge = document.createElement("span");
    this.replayBadge.textContent = "REPLAY";
    this.replayBadge.style.cssText = `
      padding: 2px 8px; border-radius: 3px;
      background: rgba(255,180,60,0.2); border: 1px solid rgba(255,180,60,0.5);
      color: rgba(255,180,60,0.9); font-size: 9px; font-weight: 700;
      letter-spacing: 0.12em; display: none;
    `;
    row.appendChild(this.replayBadge);

    bar.appendChild(row);
    return bar;
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  private _fmtMs(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  dispose(): void {
    if (this.infoHideTimer !== null) {
      clearTimeout(this.infoHideTimer);
      this.infoHideTimer = null;
    }
    this.container.remove();
  }
}
