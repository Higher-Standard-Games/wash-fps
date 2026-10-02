// Extracted from FPSHud.ts

import { FPS, getActionKeyLabel } from "../../FPSActions";
import { MatchPhase, MatchStateManager } from "../../MatchStateManager";
import type { FPSHudWidget, HUDState } from "../HudWidget";

// =============================================================================
// Match Lifecycle Widgets (replacing standalone MatchHUD)
// =============================================================================

/**
 * FPSPhaseMessage - Center-screen match phase announcements
 *
 * Subscribes to MatchStateManager.onPhaseChange() for:
 * - Warmup: "WARMUP" + gametype subtitle
 * - Countdown: 3, 2, 1 with pulse animation
 * - Active: "FIGHT!" flash → auto-hide after 2s
 * - PostGame: "MATCH OVER"
 */
export class FPSPhaseMessage implements FPSHudWidget {
  private element: HTMLElement;
  private lastCountdown: number = 0;
  private lastOvertime: number = 0;
  private hideTimeout: ReturnType<typeof setTimeout> | null = null;
  private unsubPhase: (() => void) | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-phase-message hidden";
    // Append directly to body so it's positioned independently of HUD zones
    document.body.appendChild(this.element);

    // Subscribe to phase changes
    const mgr = MatchStateManager.getInstance();
    this.unsubPhase = mgr.onPhaseChange((newPhase, _oldPhase) => {
      this.onPhaseChange(newPhase);
    });
  }

  private onPhaseChange(phase: MatchPhase): void {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }

    const mgr = MatchStateManager.getInstance();
    switch (phase) {
      case MatchPhase.Warmup:
        this.lastCountdown = 0;
        this.showHtml(
          `<div class="fps-phase-title">Warmup</div>` + `<div class="fps-phase-subtitle">${mgr.gametypeName}</div>`,
        );
        break;

      case MatchPhase.Countdown:
        this.lastCountdown = 0;
        break;

      case MatchPhase.Active:
        this.showHtml(`<div class="fps-phase-fight">Fight!</div>`);
        this.hideTimeout = setTimeout(() => this.hideMessage(), 2000);
        break;

      case MatchPhase.PostGame: {
        // Winner banner — FIGHT!-style slam with the authoritative match result.
        // Auto-hides after the slam lands; the post-game scoreboard (also titled
        // with the winner) then owns the screen.
        const winner = mgr.winner;
        const title =
          winner && winner.kind !== "draw" && winner.name ? `${this.escapeHtml(winner.name)} wins!` : "Draw!";
        // Single-match servers are terminal: the way forward is the lobby.
        const subtitle =
          mgr.flow === "single" ? "GG — return to lobby for the next one" : "Match over — next match starting soon...";
        this.showHtml(
          `<div class="fps-phase-fight">${title}</div>` + `<div class="fps-phase-subtitle">${subtitle}</div>`,
        );
        this.hideTimeout = setTimeout(() => this.hideMessage(), 3500);
        break;
      }
    }
  }

  private showHtml(html: string): void {
    this.element.innerHTML = html;
    this.element.classList.remove("hidden");
  }

  /** Escape user-controlled text (player names) before innerHTML interpolation. */
  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  private hideMessage(): void {
    this.element.classList.add("hidden");
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public update(state: HUDState): void {
    const mgr = MatchStateManager.getInstance();

    // During warmup: keep showing (update gametype if it changes)
    if (mgr.isWarmup()) {
      // The ready prompt is the point of the message. Warmup ends when everyone
      // readies, so a player who is not told how to ready is the reason the
      // whole lobby sits through a two-minute timeout. A spectator has nothing
      // to ready; the ready bar's Spectating plate stands in that line.
      const ready = state.watcher
        ? ""
        : mgr.isReady
          ? `<div class="fps-phase-ready">Waiting for others…</div>`
          : `<div class="fps-phase-ready">Press <span class="fps-keycap">${getActionKeyLabel(FPS.READY)}</span> to ready up</div>`;
      this.showHtml(
        `<div class="fps-phase-title">Warmup</div><div class="fps-phase-subtitle">${mgr.gametypeName}</div>${ready}`,
      );
    }

    // During countdown: update the number with re-triggered animation
    if (mgr.isCountdown()) {
      const num = mgr.getCountdownNumber();
      if (num !== this.lastCountdown && num > 0) {
        this.lastCountdown = num;
        this.showHtml(`<div class="fps-phase-countdown">${num}</div>`);
      }
    }

    // Overtime (duel): the phase doesn't change, so watch the counter — a tie
    // at the limit extends the match with a slam instead of ending it.
    const overtime = mgr.overtime;
    if (overtime !== this.lastOvertime) {
      this.lastOvertime = overtime;
      if (overtime > 0 && mgr.phase === MatchPhase.Active) {
        if (this.hideTimeout) clearTimeout(this.hideTimeout);
        this.showHtml(
          `<div class="fps-phase-fight">Overtime!</div><div class="fps-phase-subtitle">+1 minute — no draws</div>`,
        );
        this.hideTimeout = setTimeout(() => this.hideMessage(), 3000);
      }
    }
  }

  public show(): void {
    this.element.classList.remove("hidden");
  }
  public hide(): void {
    this.element.classList.add("hidden");
  }

  public destroy(): void {
    if (this.hideTimeout) clearTimeout(this.hideTimeout);
    if (this.unsubPhase) this.unsubPhase();
    this.element.remove();
  }
}
