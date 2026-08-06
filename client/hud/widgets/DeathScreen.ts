// Extracted from FPSHud.ts
import { FPS, getActionKeyLabel } from "../../FPSActions";
import { MatchStateManager } from "../../MatchStateManager";
import type { FPSHudWidget, HUDState } from "../HudWidget";

// Respawn protection delay in seconds (must match server config)
const RESPAWN_DELAY_SECS = 3;

// =============================================================================
// Phase 3: Death Screen — "YOU GOT FRAGGED"
// =============================================================================

/**
 * FPSDeathScreen - Shows when player dies
 *
 * Displays "YOU GOT FRAGGED", killer name, a countdown timer for respawn
 * protection, and a respawn prompt when the countdown finishes.
 */
export class FPSDeathScreen implements FPSHudWidget {
  private element: HTMLElement;
  private titleEl: HTMLElement;
  private killerEl: HTMLElement;
  private timerEl: HTMLElement;
  private respawnEl: HTMLElement;
  private wasAlive: boolean = true;
  /** This death has already had its panel; do not stage it a second time. */
  private shownForThisDeath: boolean = false;
  private deathTime: number = 0;
  private countdownInterval: number | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-death-screen";
    this.element.style.display = "none";

    // Inner panel with border + glass
    const panel = document.createElement("div");
    panel.className = "fps-death-panel";

    this.titleEl = document.createElement("div");
    this.titleEl.className = "fps-death-title";
    this.titleEl.textContent = "YOU GOT FRAGGED";
    panel.appendChild(this.titleEl);

    // Separator line
    const sep = document.createElement("div");
    sep.className = "fps-death-separator";
    panel.appendChild(sep);

    this.killerEl = document.createElement("div");
    this.killerEl.className = "fps-death-killer";
    panel.appendChild(this.killerEl);

    this.timerEl = document.createElement("div");
    this.timerEl.className = "fps-death-timer";
    panel.appendChild(this.timerEl);

    this.respawnEl = document.createElement("div");
    this.respawnEl.className = "fps-death-respawn";
    panel.appendChild(this.respawnEl);

    this.element.appendChild(panel);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * The panel belongs to the MOMENT of death, and gets it once.
   *
   * The order in a round mode is: you go down, the camera holds on your body
   * and this says what happened, and then a couple of seconds later the camera
   * moves to a living teammate and this gets out of the way — you are watching
   * their fight now, not reading about your own.
   *
   * `shownForThisDeath` is what stops it coming back. Handing the screen over
   * to a teammate is not being alive again, so the hide must not re-arm the
   * show; without it the panel reappeared the moment spectating ended, and
   * announced "YOU GOT FRAGGED" over the round-end camera for a death that
   * happened a minute earlier.
   */
  public update(state: HUDState): void {
    if (!state.localDead) {
      if (!this.wasAlive) {
        // Respawned — hide death screen
        this.wasAlive = true;
        this.stopCountdown();
        this.element.style.display = "none";
      }
      this.shownForThisDeath = false;
      return;
    }

    // Dead, and the camera has moved on to a teammate. Their fight owns the
    // screen; ours is over.
    if (state.spectating !== "") {
      if (!this.wasAlive) {
        this.stopCountdown();
        this.element.style.display = "none";
      }
      return;
    }

    if (this.shownForThisDeath) return;
    this.shownForThisDeath = true;
    this.wasAlive = false;
    this.deathTime = performance.now();

    // Try to find killer from latest kill feed entry
    const feed = state.killFeed;
    if (feed.length > 0) {
      const lastKill = feed[feed.length - 1];
      this.killerEl.innerHTML = `Fragged by <span class="fps-death-killer-name">${this.escapeHtml(lastKill.killerId)}</span>`;
    } else {
      this.killerEl.textContent = "";
    }

    // Start countdown
    this.respawnEl.textContent = "";
    this.respawnEl.style.display = "none";
    this.startCountdown();

    this.element.style.display = "";
  }

  private startCountdown(): void {
    this.stopCountdown();
    this.updateTimer();
    this.countdownInterval = window.setInterval(() => this.updateTimer(), 50);
  }

  private stopCountdown(): void {
    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  private updateTimer(): void {
    // Round modes have no respawn: you are out until the round turns over, so
    // a countdown to a button that does nothing is worse than no countdown.
    // Say what is actually happening instead.
    if (MatchStateManager.getInstance().round > 0) {
      this.timerEl.style.display = "none";
      this.respawnEl.textContent = "WAITING FOR THE NEXT ROUND";
      this.respawnEl.style.display = "";
      this.stopCountdown();
      return;
    }

    const elapsed = (performance.now() - this.deathTime) / 1000;
    const remaining = Math.max(0, RESPAWN_DELAY_SECS - elapsed);

    if (remaining > 0) {
      this.timerEl.textContent = remaining.toFixed(1);
      this.timerEl.style.display = "";
      this.respawnEl.style.display = "none";
    } else {
      this.timerEl.style.display = "none";
      // "PRESS [MOUSE1] TO RESPAWN" — the fire keybind rendered as a keycap.
      this.respawnEl.textContent = "";
      this.respawnEl.appendChild(document.createTextNode("PRESS "));
      const keycap = document.createElement("span");
      keycap.className = "fps-keycap";
      keycap.textContent = getActionKeyLabel(FPS.FIRE);
      this.respawnEl.appendChild(keycap);
      this.respawnEl.appendChild(document.createTextNode(" TO RESPAWN"));
      this.respawnEl.style.display = "";
      this.stopCountdown();
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  public show(): void {
    this.element.style.display = "";
  }

  public hide(): void {
    this.element.style.display = "none";
  }

  public destroy(): void {
    this.stopCountdown();
    this.element.remove();
  }
}
