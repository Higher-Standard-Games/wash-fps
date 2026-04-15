// Pause Menu — Full-screen pause overlay using GamePanel system
import { GamePanel } from "../../../../../engine/ui/panels/GamePanel";
import { MatchStateManager } from "../../MatchStateManager";

// =============================================================================
// Pause Menu — Immersive full-screen pause overlay
// =============================================================================

/**
 * FPSPauseMenu - ESC key pause menu
 *
 * Extends GamePanel for the full-screen experience with floating particles,
 * neon dividers, and blurred gameplay edges. Shows centered action buttons:
 * Resume, Settings, Go Spectator, Join Game, Disconnect.
 */
export class FPSPauseMenu extends GamePanel {
  private onResumeCallback: (() => void) | null = null;
  private onSettingsCallback: (() => void) | null = null;
  private onDisconnectCallback: (() => void) | null = null;
  private onSpectateCallback: (() => void) | null = null;
  private onJoinGameCallback: ((teamId?: string) => void) | null = null;
  private spectateBtn: HTMLButtonElement;
  private resumeBtn: HTMLButtonElement;
  private joinContainer: HTMLElement;
  private buttonStack: HTMLElement;

  constructor() {
    super("PAUSED");

    // 3D Logo floating above panel
    this.enableLogo();

    // Hide the tab bar (no tabs in pause menu)
    this.tabBar.style.display = "none";

    // Hide footer (buttons are in content area)
    this.footerArea.style.display = "none";

    // Create centered button stack
    this.buttonStack = document.createElement("div");
    this.buttonStack.className = "game-panel__menu-buttons";

    // Resume button (primary)
    this.resumeBtn = this.createButton("Resume", "fps-btn--primary fps-btn--menu", () => {
      this.close();
      this.onResumeCallback?.();
    });

    // Join Game container (dynamically populated based on team mode)
    this.joinContainer = document.createElement("div");
    this.joinContainer.className = "game-panel__join-group";
    this.joinContainer.style.display = "none"; // Hidden by default (shown in spectator mode)

    // Settings button
    const settingsBtn = this.createButton("Settings", "fps-btn--menu", () => {
      this.onSettingsCallback?.();
    });

    // Go Spectator button (conditionally visible)
    this.spectateBtn = this.createButton("Go Spectator", "fps-btn--menu", () => {
      this.close();
      this.onSpectateCallback?.();
    });
    this.spectateBtn.style.display = "none"; // Hidden by default

    // Separator
    const separator = document.createElement("div");
    separator.className = "game-panel__menu-separator";

    // Disconnect button (danger)
    const disconnectBtn = this.createButton("Disconnect", "fps-btn--danger fps-btn--menu", () => {
      this.close();
      this.onDisconnectCallback?.();
    });

    this.buttonStack.appendChild(this.resumeBtn);
    this.buttonStack.appendChild(this.joinContainer);
    this.buttonStack.appendChild(settingsBtn);
    this.buttonStack.appendChild(this.spectateBtn);
    this.buttonStack.appendChild(separator);
    this.buttonStack.appendChild(disconnectBtn);

    // Put buttons in scroll container (centered vertically + horizontally)
    this.setContent(this.buttonStack);
  }

  // =========================================================================
  // Callbacks
  // =========================================================================

  public onResume(callback: () => void): void {
    this.onResumeCallback = callback;
  }

  public onSettings(callback: () => void): void {
    this.onSettingsCallback = callback;
  }

  public onDisconnect(callback: () => void): void {
    this.onDisconnectCallback = callback;
  }

  public onGoSpectate(callback: () => void): void {
    this.onSpectateCallback = callback;
  }

  public onJoinGame(callback: (teamId?: string) => void): void {
    this.onJoinGameCallback = callback;
  }

  /** Show/hide the Go Spectator button (only visible when playing) */
  public setSpectateVisible(visible: boolean): void {
    this.spectateBtn.style.display = visible ? "" : "none";
  }

  /** Show/hide the Resume button (hidden in spectator mode) */
  public setResumeVisible(visible: boolean): void {
    this.resumeBtn.style.display = visible ? "" : "none";
  }

  /** Show/hide join game buttons and refresh them based on gametype */
  public setJoinVisible(visible: boolean): void {
    this.joinContainer.style.display = visible ? "" : "none";
    if (visible) {
      this.refreshJoinButtons();
    }
  }

  // =========================================================================
  // Join Buttons — dynamically populated based on team/FFA mode
  // =========================================================================

  private refreshJoinButtons(): void {
    this.joinContainer.innerHTML = "";

    const state = MatchStateManager.getInstance();
    const hasTeams = Object.keys(state.teamScores).length > 0;

    if (hasTeams) {
      // Team mode: show team-colored join buttons
      const udonBtn = this.createButton("Join Team Udon", "fps-btn--menu fps-btn--team-udon", () => {
        this.close();
        this.onJoinGameCallback?.("udon");
      });

      const sobaBtn = this.createButton("Join Team Soba", "fps-btn--menu fps-btn--team-soba", () => {
        this.close();
        this.onJoinGameCallback?.("soba");
      });

      this.joinContainer.appendChild(udonBtn);
      this.joinContainer.appendChild(sobaBtn);
    } else {
      // FFA mode: single join button
      const joinBtn = this.createButton("Join Game", "fps-btn--primary fps-btn--menu", () => {
        this.close();
        this.onJoinGameCallback?.();
      });

      this.joinContainer.appendChild(joinBtn);
    }
  }
}
