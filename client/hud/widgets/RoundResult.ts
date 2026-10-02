import { MatchPhase, MatchStateManager } from "../../MatchStateManager";
import type { FPSHudWidget, HUDState } from "../HudWidget";

// =============================================================================
// Round Result — the centre-screen banner during the round-end intermission
// =============================================================================

/**
 * How long the explosion gets before the banner covers it.
 *
 * The server runs one intermission phase, so the two beats are separated here:
 * the detonation plays uninterrupted, then the result appears over the settling
 * debris. A banner that arrives with the blast hides the best thing that
 * happens in the mode.
 */
const EXPLOSION_GRACE_SECONDS = 1.5;

/** Headline per reason. The server sends a key; the wording lives here. */
function headline(reason: string, winnerName: string): { lead: string | null; result: string } {
  switch (reason) {
    case "defused":
      return { lead: "BOMB DEFUSED", result: `${winnerName} wins the round` };
    case "detonated":
      return { lead: "BOMB DETONATED", result: `${winnerName} wins the round` };
    case "timeout":
      return { lead: "TIME UP", result: `${winnerName} wins the round` };
    default:
      return { lead: null, result: `${winnerName} wins the round` };
  }
}

/**
 * FPSRoundResult — what just happened, and who won it.
 *
 * Shown only while `MatchPhase.RoundEnd` is live, which is a phase the server
 * owns, so the banner cannot outlast the beat it belongs to or appear during a
 * round. It reads the same `roundResult` every client gets, so two players
 * never see different accounts of the same round.
 */
export class FPSRoundResult implements FPSHudWidget {
  private element: HTMLElement;
  private leadEl: HTMLElement;
  private resultEl: HTMLElement;
  private rendered: string | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-round-result";
    this.element.style.display = "none";

    this.leadEl = document.createElement("div");
    this.leadEl.className = "fps-round-result-lead";
    this.element.appendChild(this.leadEl);

    this.resultEl = document.createElement("div");
    this.resultEl.className = "fps-round-result-text";
    this.element.appendChild(this.resultEl);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public update(_state: HUDState): void {
    const match = MatchStateManager.getInstance();
    const result = match.roundResult;

    if (match.phase !== MatchPhase.RoundEnd || !result) {
      this.clear();
      return;
    }

    // `timeRemaining` counts DOWN through the intermission, so elapsed time is
    // what is left subtracted from the whole. Using it rather than a local
    // timer keeps the banner in step with the server even after a stall.
    const total = match.timeRemaining;
    const elapsed = this.intermissionLength - total;
    if (elapsed < EXPLOSION_GRACE_SECONDS && result.reason === "detonated") {
      this.clear();
      return;
    }

    const { lead, result: text } = headline(result.reason, result.winnerName);
    const signature = `${result.round}|${result.reason}|${result.winnerName}`;
    if (signature === this.rendered) return;
    this.rendered = signature;

    this.leadEl.textContent = lead ?? "";
    this.leadEl.style.display = lead ? "" : "none";
    this.resultEl.textContent = text;
    this.element.classList.toggle("fps-round-result--defused", result.reason === "defused");
    this.element.classList.toggle("fps-round-result--detonated", result.reason === "detonated");
    this.element.style.display = "";
  }

  /**
   * Longest intermission seen this match.
   *
   * The client is never told the phase's configured length, only what is left
   * of it — so the first tick of the phase, which reports very nearly the whole
   * duration, is the measurement.
   */
  private intermissionLength = 5;

  private clear(): void {
    const match = MatchStateManager.getInstance();
    if (match.phase === MatchPhase.RoundEnd) {
      this.intermissionLength = Math.max(this.intermissionLength, match.timeRemaining);
    }
    if (this.rendered === null) return;
    this.rendered = null;
    this.element.style.display = "none";
  }

  public show(): void {
    // Visibility is state-driven via update(); nothing to force here.
  }

  public hide(): void {
    this.element.style.display = "none";
  }

  public destroy(): void {
    this.element.remove();
  }
}
