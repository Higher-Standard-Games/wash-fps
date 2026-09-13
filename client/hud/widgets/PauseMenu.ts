import { GameDialogPanel } from "../../../../../engine/ui/panels/GameDialogPanel";
import { MatchStateManager } from "../../MatchStateManager";

/**
 * FPSPauseMenu - ESC key pause menu.
 *
 * Keeps FPS-specific actions here while using the engine compact dialog panel
 * for modal behavior and lifecycle.
 */
export class FPSPauseMenu extends GameDialogPanel {
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
    // The pause menu mirrors pointer-lock state (unlocked = shown, Resume re-locks).
    // Backdrop-click dismiss would hide the menu WITHOUT re-locking the pointer,
    // stranding the player with a free cursor and no menu — so disable it. ESC is
    // left enabled to match the previous GamePanel behavior.
    super({
      title: "ESC MENU",
      extraClass: "fps-pause-menu fps-pause-menu--cartoon",
      closeOnBackdrop: false,
    });

    this.dialog.classList.add("fps-pause-dialog");
    this.footerEl.style.display = "none";

    this.buttonStack = document.createElement("div");
    this.buttonStack.className = "fps-pause-actions";

    const hero = document.createElement("div");
    hero.className = "fps-pause-hero";
    hero.innerHTML = `
      <div class="fps-pause-kicker">Match Control</div>
      <div class="fps-pause-heading">Paused</div>
      <div class="fps-pause-subtitle">Pick your next move.</div>
    `;

    this.resumeBtn = this.createPauseButton("Resume", "Back to fight", "fps-btn--primary", () => {
      this.close();
      this.onResumeCallback?.();
    });

    this.joinContainer = document.createElement("div");
    this.joinContainer.className = "fps-pause-join-group";
    this.joinContainer.style.display = "none";

    const settingsBtn = this.createPauseButton("Settings", "Controls and video", "", () => {
      this.onSettingsCallback?.();
    });

    this.spectateBtn = this.createPauseButton("Go Spectator", "Watch the duel", "", () => {
      this.close();
      this.onSpectateCallback?.();
    });
    this.spectateBtn.style.display = "none";

    const separator = document.createElement("div");
    separator.className = "fps-pause-separator";

    const disconnectBtn = this.createPauseButton("Disconnect", "Leave server", "fps-btn--danger", () => {
      this.close();
      this.onDisconnectCallback?.();
    });

    this.buttonStack.appendChild(hero);
    this.buttonStack.appendChild(this.resumeBtn);
    this.buttonStack.appendChild(this.joinContainer);
    this.buttonStack.appendChild(settingsBtn);
    this.buttonStack.appendChild(this.spectateBtn);
    this.buttonStack.appendChild(separator);
    this.buttonStack.appendChild(disconnectBtn);

    this.setContent(this.buttonStack);
  }

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

  public setSpectateVisible(visible: boolean): void {
    this.spectateBtn.style.display = visible ? "" : "none";
  }

  public setResumeVisible(visible: boolean): void {
    this.resumeBtn.style.display = visible ? "" : "none";
  }

  public setJoinVisible(visible: boolean): void {
    this.joinContainer.style.display = visible ? "" : "none";
    if (visible) {
      this.refreshJoinButtons();
    }
  }

  private createPauseButton(label: string, hint: string, variant: string, onClick: () => void): HTMLButtonElement {
    const btn = this.createButton("", `fps-btn--pause ${variant}`.trim(), onClick);
    btn.innerHTML = `
      <span class="fps-pause-btn-label">${label}</span>
      <span class="fps-pause-btn-hint">${hint}</span>
    `;
    return btn;
  }

  /** Players on each side right now, spectators excluded. */
  private teamSizes(): { udon: number; soba: number } {
    const teams = MatchStateManager.getInstance().playerTeams ?? {};
    let udon = 0;
    let soba = 0;
    for (const team of Object.values(teams)) {
      if (team === "udon") udon++;
      else if (team === "soba") soba++;
    }
    return { udon, soba };
  }

  private static describeSide(count: number): string {
    if (count === 0) return "Empty";
    return count === 1 ? "1 player" : `${count} players`;
  }

  private refreshJoinButtons(): void {
    this.joinContainer.innerHTML = "";

    const state = MatchStateManager.getInstance();
    // Team-ness comes from the gametype, not from the presence of team scores:
    // those ship with both sides populated in every gametype, so a free-for-all
    // read as a team game and every player landed in the spectator list.
    const hasTeams = state.teamBased;

    if (hasTeams) {
      // How full each side is, rather than what colour it is.
      //
      // Colour stopped identifying a team when team colour became allegiance —
      // your side is pink and theirs is cyan whichever names they have — so
      // "PINK SIDE" was about to be wrong for half of every match. Size is the
      // fact that actually bears on this choice: picking the bigger side gets
      // you redirected to the smaller one, and this is what says so beforehand.
      const sizes = this.teamSizes();
      const udonBtn = this.createPauseButton(
        "Join Team Udon",
        FPSPauseMenu.describeSide(sizes.udon),
        "fps-btn--team-udon",
        () => {
          this.close();
          this.onJoinGameCallback?.("udon");
        },
      );

      const sobaBtn = this.createPauseButton(
        "Join Team Soba",
        FPSPauseMenu.describeSide(sizes.soba),
        "fps-btn--team-soba",
        () => {
          this.close();
          this.onJoinGameCallback?.("soba");
        },
      );

      this.joinContainer.appendChild(udonBtn);
      this.joinContainer.appendChild(sobaBtn);
    } else {
      const joinBtn = this.createPauseButton("Join Game", "Enter arena", "fps-btn--primary", () => {
        this.close();
        this.onJoinGameCallback?.();
      });

      this.joinContainer.appendChild(joinBtn);
    }
  }
}
