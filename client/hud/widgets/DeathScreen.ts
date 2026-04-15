// Extracted from FPSHud.ts
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

  public update(state: HUDState): void {
    if (state.dead && this.wasAlive) {
      // Just died — show death screen
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
    } else if (!state.dead && !this.wasAlive) {
      // Respawned — hide death screen
      this.wasAlive = true;
      this.stopCountdown();
      this.element.style.display = "none";
    }
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
    const elapsed = (performance.now() - this.deathTime) / 1000;
    const remaining = Math.max(0, RESPAWN_DELAY_SECS - elapsed);

    if (remaining > 0) {
      this.timerEl.textContent = remaining.toFixed(1);
      this.timerEl.style.display = "";
      this.respawnEl.style.display = "none";
    } else {
      this.timerEl.style.display = "none";
      this.respawnEl.textContent = "PRESS FIRE TO RESPAWN";
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
