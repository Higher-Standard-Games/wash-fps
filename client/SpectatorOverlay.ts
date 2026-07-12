/**
 * SpectatorOverlay - Fullscreen spectator mode UI
 *
 * Shows:
 * 1. Initial join overlay (JOIN GAME / Spectate buttons) on connect
 * 2. "SPECTATING: PlayerName" bar during first-person spectate
 * 3. Freefly spectator minimal UI
 *
 * Uses Washiki theme styling consistent with FPSHud.
 */

import { LogoCanvas } from "../../../engine/ui/components/LogoCanvas";
import { FPS, getActionKeyLabel } from "./FPSActions";
import { MatchStateManager } from "./MatchStateManager";

export type SpectatorMode = "join-overlay" | "freefly" | "first-person" | "hidden";

export class SpectatorOverlay {
  private container: HTMLElement;
  private joinOverlay: HTMLElement;
  private spectatingBar: HTMLElement;
  private spectatingNameEl: HTMLElement;
  private freeflyCue: HTMLElement;
  private mode: SpectatorMode = "hidden";

  private onJoinGameCallback: ((teamId?: string) => void) | null = null;
  private onSpectateCallback: (() => void) | null = null;
  private buttonsContainer: HTMLElement;
  private hintEl: HTMLElement;
  private logoCanvas: LogoCanvas | null = null;

  // Reserved for first-person spectating (future)
  private _onNextPlayerCallback: (() => void) | null = null;
  private _onPrevPlayerCallback: (() => void) | null = null;

  constructor() {
    // Main container (always present, visibility controlled by mode)
    this.container = document.createElement("div");
    this.container.id = "spectator-overlay";
    this.container.style.cssText = `
            position: fixed;
            inset: 0;
            z-index: 500;
            pointer-events: none;
        `;

    // ── Join Overlay (fullscreen blur + Washiki panel dialog) ──
    this.joinOverlay = document.createElement("div");
    this.joinOverlay.id = "spectator-join-overlay";
    this.joinOverlay.style.cssText = `
            position: absolute;
            inset: 0;
            display: none;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(14px);
            -webkit-backdrop-filter: blur(14px);
            background: radial-gradient(ellipse at center, rgba(0,0,0,0.45), rgba(0,0,0,0.7));
            pointer-events: all;
        `;

    // Washiki-style dialog panel
    const panel = document.createElement("div");
    panel.style.cssText = `
            position: relative;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 16px;
            padding: 40px 56px;
            background: linear-gradient(180deg, rgba(10,8,16,0.92) 0%, rgba(6,4,12,0.88) 100%);
            border: 1px solid rgba(255,100,0,0.35);
            border-radius: 4px;
            box-shadow: 0 0 40px rgba(255,80,0,0.08), 0 8px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,140,0,0.08);
        `;

    // Corner brackets (top-left, top-right, bottom-left, bottom-right)
    const cornerCSS = (top: boolean, left: boolean) => `
            position: absolute;
            ${top ? "top: -1px" : "bottom: -1px"};
            ${left ? "left: -1px" : "right: -1px"};
            width: 14px; height: 14px;
            border-${top ? "top" : "bottom"}: 2px solid rgba(255,120,0,0.7);
            border-${left ? "left" : "right"}: 2px solid rgba(255,120,0,0.7);
            pointer-events: none;
        `;
    for (const [t, l] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ]) {
      const c = document.createElement("div");
      c.style.cssText = cornerCSS(t as boolean, l as boolean);
      panel.appendChild(c);
    }

    // 3D Washoi logo (replaces the old "SHAG" text)
    this.logoCanvas = new LogoCanvas({ width: 500, height: 160, showGlow: false, cameraRadius: 2.8 });
    const logoEl = this.logoCanvas.getElement();
    logoEl.style.marginBottom = "4px";
    panel.appendChild(logoEl);

    // Subtle divider
    const divider = document.createElement("div");
    divider.style.cssText = `
            width: 80%; height: 1px;
            background: linear-gradient(90deg, transparent, rgba(255,100,0,0.3), transparent);
            margin: 4px 0 12px 0;
        `;
    panel.appendChild(divider);

    // Buttons container
    this.buttonsContainer = document.createElement("div");
    this.buttonsContainer.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 12px;
            align-items: center;
        `;
    panel.appendChild(this.buttonsContainer);

    // Hint text
    this.hintEl = document.createElement("div");
    this.hintEl.style.cssText = `
            font-family: 'Rajdhani', 'Outfit', sans-serif;
            font-size: 11px;
            color: rgba(255,140,0,0.45);
            text-transform: uppercase;
            letter-spacing: 2px;
            margin-top: 8px;
        `;
    panel.appendChild(this.hintEl);

    this.joinOverlay.appendChild(panel);
    this.container.appendChild(this.joinOverlay);

    this.refreshJoinPanel();

    // ── Spectating Bar (top center, shows during first-person spec) ──
    this.spectatingBar = document.createElement("div");
    this.spectatingBar.id = "spectator-bar";
    this.spectatingBar.className = "fps-spectator-bar";

    // Prev player button
    const prevBtn = document.createElement("span");
    prevBtn.className = "fps-spectator-bar-nav";
    prevBtn.textContent = "◄ [←]";
    prevBtn.addEventListener("click", () => this._onPrevPlayerCallback?.());
    this.spectatingBar.appendChild(prevBtn);

    const specLabel = document.createElement("span");
    specLabel.className = "fps-spectator-bar-label";
    specLabel.textContent = "SPECTATING";
    this.spectatingBar.appendChild(specLabel);

    this.spectatingNameEl = document.createElement("span");
    this.spectatingNameEl.className = "fps-spectator-bar-name";
    this.spectatingBar.appendChild(this.spectatingNameEl);

    // Next player button
    const nextBtn = document.createElement("span");
    nextBtn.className = "fps-spectator-bar-nav";
    nextBtn.textContent = "[→] ►";
    nextBtn.addEventListener("click", () => this._onNextPlayerCallback?.());
    this.spectatingBar.appendChild(nextBtn);

    this.container.appendChild(this.spectatingBar);

    // ── Freefly cue (left sidebar panel, below weapon list) ─────
    this.freeflyCue = document.createElement("div");
    this.freeflyCue.id = "spectator-freefly-cue";
    this.freeflyCue.className = "fps-spectator-cue";

    // Header: "SPECTATOR"
    const header = document.createElement("div");
    header.className = "fps-spectator-cue-header";
    header.textContent = "SPECTATOR";
    this.freeflyCue.appendChild(header);

    // Divider
    const div = document.createElement("div");
    div.className = "fps-spectator-cue-divider";
    this.freeflyCue.appendChild(div);

    // Dynamic key labels from InputSystem
    const moveKeys = [
      getActionKeyLabel(FPS.MOVE_FORWARD),
      getActionKeyLabel(FPS.MOVE_LEFT),
      getActionKeyLabel(FPS.MOVE_BACKWARD),
      getActionKeyLabel(FPS.MOVE_RIGHT),
    ].join("");
    const sprintKey = getActionKeyLabel(FPS.SPRINT);
    const fireKey = getActionKeyLabel(FPS.FIRE);
    const joinKey2 = getActionKeyLabel(FPS.JOIN_GAME);
    const jumpKey = getActionKeyLabel(FPS.JUMP);
    const crouchKey = getActionKeyLabel(FPS.CROUCH);

    const bindings: [string, string][] = [
      [moveKeys, "Fly"],
      ["MOUSE", "Look"],
      [sprintKey, "Fast"],
      [jumpKey, "Fly Up"],
      [crouchKey, "Fly Down"],
      [fireKey, "Chase Player"],
      [joinKey2, "Join Game"],
      ["ESC", "Menu"],
    ];

    // Split into two columns of 3
    const half = Math.ceil(bindings.length / 2);
    const leftCol = bindings.slice(0, half);
    const rightCol = bindings.slice(half);

    const grid = document.createElement("div");
    grid.className = "fps-spectator-cue-grid";

    for (let i = 0; i < half; i++) {
      // Left column
      const lk = document.createElement("div");
      lk.className = "fps-spectator-key";
      lk.textContent = leftCol[i][0];
      const la = document.createElement("div");
      la.className = "fps-spectator-action";
      la.textContent = leftCol[i][1];

      // Vertical divider cell
      const sep = document.createElement("div");
      sep.className = "fps-spectator-sep";

      // Right column
      const rk = document.createElement("div");
      rk.className = "fps-spectator-key";
      rk.textContent = rightCol[i]?.[0] ?? "";
      const ra = document.createElement("div");
      ra.className = "fps-spectator-action";
      ra.textContent = rightCol[i]?.[1] ?? "";

      grid.appendChild(lk);
      grid.appendChild(la);
      grid.appendChild(sep);
      grid.appendChild(rk);
      grid.appendChild(ra);
    }

    this.freeflyCue.appendChild(grid);
    this.container.appendChild(this.freeflyCue);

    document.body.appendChild(this.container);
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Set the current spectator mode — controls what UI is visible
   */
  public setMode(mode: SpectatorMode): void {
    this.mode = mode;

    // Hide everything first
    this.joinOverlay.style.display = "none";
    this.spectatingBar.style.display = "none";
    this.freeflyCue.style.display = "none";
    if (this.logoCanvas) this.logoCanvas.pause();

    switch (mode) {
      case "join-overlay":
        this.refreshJoinPanel();
        this.joinOverlay.style.display = "flex";
        // Init/resume 3D logo
        if (this.logoCanvas) {
          this.logoCanvas.init().catch(() => {});
        }
        break;
      case "freefly":
        this.freeflyCue.style.display = "flex";
        break;
      case "first-person":
        this.spectatingBar.style.display = "flex";
        break;
      case "hidden":
        break;
    }
  }

  public getMode(): SpectatorMode {
    return this.mode;
  }

  /** Set the target player name for first-person spectating bar */
  public setSpectatingTarget(playerName: string): void {
    this.spectatingNameEl.textContent = playerName;
  }

  // ── Callbacks ───────────────────────────────────────────────

  public onJoinGame(cb: (teamId?: string) => void): void {
    this.onJoinGameCallback = cb;
  }
  public onSpectate(cb: () => void): void {
    this.onSpectateCallback = cb;
  }

  // Suppress TS unused warnings for future callbacks
  public onNextPlayer(cb: () => void): void {
    this._onNextPlayerCallback = cb;
    if (this._onNextPlayerCallback !== null) {
    } // TS hack to mark as read
  }
  public onPrevPlayer(cb: () => void): void {
    this._onPrevPlayerCallback = cb;
    if (this._onPrevPlayerCallback !== null) {
    } // TS hack to mark as read
  }

  // ── Cleanup ─────────────────────────────────────────────────

  public destroy(): void {
    if (this.logoCanvas) {
      this.logoCanvas.dispose();
      this.logoCanvas = null;
    }
    this.container.remove();
  }

  // ── Private ─────────────────────────────────────────────────

  private createButton(text: string, primary: boolean): HTMLElement {
    const defaultBg = primary
      ? "linear-gradient(180deg, rgba(255,80,0,0.25) 0%, rgba(255,120,0,0.1) 100%)"
      : "rgba(255,255,255,0.04)";
    const defaultBorder = primary ? "rgba(255,100,0,0.7)" : "rgba(255,255,255,0.2)";
    const defaultShadow = primary ? "0 0 20px rgba(255,80,0,0.12), inset 0 1px 0 rgba(255,140,0,0.1)" : "";

    const btn = document.createElement("button");
    btn.textContent = text;
    // Store base colors as data attributes so team overrides are preserved on hover/leave
    btn.dataset.baseBg = defaultBg;
    btn.dataset.baseBorder = defaultBorder;
    btn.dataset.baseShadow = defaultShadow;
    btn.style.cssText = `
            font-family: 'Orbitron', 'Rajdhani', 'Outfit', sans-serif;
            font-size: ${primary ? "16px" : "13px"};
            font-weight: ${primary ? "800" : "600"};
            text-transform: uppercase;
            letter-spacing: ${primary ? "5px" : "3px"};
            padding: ${primary ? "14px 48px" : "10px 36px"};
            border: ${primary ? "2px solid " + defaultBorder : "1px solid " + defaultBorder};
            border-radius: 3px;
            background: ${defaultBg};
            color: ${primary ? "#fff" : "rgba(255,255,255,0.7)"};
            cursor: pointer;
            transition: all 0.2s ease;
            min-width: 220px;
            ${defaultShadow ? "box-shadow: " + defaultShadow + ";" : ""}
        `;

    btn.addEventListener("mouseenter", () => {
      btn.style.background = primary
        ? "linear-gradient(180deg, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0.05) 100%)"
        : "rgba(255,255,255,0.1)";
      btn.style.filter = "brightness(1.3)";
      btn.style.transform = "scale(1.02)";
    });

    btn.addEventListener("mouseleave", () => {
      // Restore from data attributes (respects team color overrides)
      btn.style.background = btn.dataset.baseBg || defaultBg;
      btn.style.borderColor = btn.dataset.baseBorder || defaultBorder;
      btn.style.filter = "";
      btn.style.transform = "scale(1)";
      if (primary) btn.style.boxShadow = btn.dataset.baseShadow || defaultShadow;
    });

    return btn;
  }

  private refreshJoinPanel(): void {
    if (!this.buttonsContainer || !this.hintEl) return;

    this.buttonsContainer.innerHTML = "";

    const state = MatchStateManager.getInstance();
    const hasTeams = Object.keys(state.teamScores).length > 0;

    if (hasTeams) {
      // Team Udon btn (pink)
      const udonBtn = this.createButton("JOIN TEAM UDON", true);
      udonBtn.style.borderColor = "rgba(255, 0, 200, 0.7)";
      udonBtn.style.background = "linear-gradient(180deg, rgba(255,0,200,0.25) 0%, rgba(255,0,200,0.1) 100%)";
      udonBtn.dataset.baseBg = udonBtn.style.background;
      udonBtn.dataset.baseBorder = udonBtn.style.borderColor;
      udonBtn.addEventListener("click", () => this.onJoinGameCallback?.("udon"));
      this.buttonsContainer.appendChild(udonBtn);

      // Team Soba btn (cyan)
      const sobaBtn = this.createButton("JOIN TEAM SOBA", true);
      sobaBtn.style.borderColor = "rgba(0, 255, 255, 0.7)";
      sobaBtn.style.background = "linear-gradient(180deg, rgba(0,255,255,0.25) 0%, rgba(0,255,255,0.1) 100%)";
      sobaBtn.dataset.baseBg = sobaBtn.style.background;
      sobaBtn.dataset.baseBorder = sobaBtn.style.borderColor;
      sobaBtn.addEventListener("click", () => this.onJoinGameCallback?.("soba"));
      this.buttonsContainer.appendChild(sobaBtn);

      const joinKey = getActionKeyLabel(FPS.JOIN_GAME);
      this.hintEl.textContent = `Press ${joinKey} to auto-assign`;
    } else {
      // Standard FFA btn
      const joinBtn = this.createButton("JOIN GAME", true);
      joinBtn.addEventListener("click", () => this.onJoinGameCallback?.());
      this.buttonsContainer.appendChild(joinBtn);

      const joinKey = getActionKeyLabel(FPS.JOIN_GAME);
      this.hintEl.textContent = `Press ${joinKey} to join`;
    }

    // Shared spectate button
    const specBtn = this.createButton("SPECTATE", false);
    specBtn.addEventListener("click", () => this.onSpectateCallback?.());
    this.buttonsContainer.appendChild(specBtn);
  }
}
