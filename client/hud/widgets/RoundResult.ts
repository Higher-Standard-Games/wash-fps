import type { RoundResult } from "../../../../../shared/server/gametype";
import { MatchPhase, MatchStateManager } from "../../MatchStateManager";
import type { FPSHudWidget, HUDState } from "../HudWidget";

// =============================================================================
// Round Result — the intermission between rounds of a round mode
// =============================================================================

/**
 * How long the explosion gets before the overlay covers it.
 *
 * The server runs one intermission phase, so the two beats are separated here:
 * the detonation plays uninterrupted, then the result comes up over the
 * settling debris. A result that arrives with the blast hides the best thing
 * that happens in the mode.
 */
const EXPLOSION_GRACE_SECONDS = 1.5;

/** What ended the round, over the winner. The server sends a key; the wording lives here. */
function leadFor(reason: RoundResult["reason"]): string | null {
  switch (reason) {
    case "defused":
      return "Bomb defused";
    case "detonated":
      return "Bomb detonated";
    case "timeout":
      return "Time up";
    default:
      return null;
  }
}

/**
 * FPSRoundResult — who won the round, the score, and when the next one starts.
 *
 * Covers the whole gap between rounds of a round mode (S&D, Amphi): the
 * round-end beat and the next round's freeze, on a dimmed screen like the
 * end screen's. The winner stands on a gold plate, the teams' rounds under
 * it, and a count runs down to the next round going live, when the overlay
 * lifts. It reads only the match state every client gets, so two players never
 * see different accounts of the same round.
 */
export class FPSRoundResult implements FPSHudWidget {
  private element: HTMLElement;
  private leadEl: HTMLElement;
  private winnerEl: HTMLElement;
  private wonEl: HTMLElement;
  private scoreEl: HTMLElement;
  private countEl: HTMLElement;
  private countNumberEl: HTMLElement;
  /** The round, reason and score drawn, so an unchanged result is not redrawn. */
  private rendered: string | null = null;
  private renderedCount: number | null = null;

  /**
   * Longest round-end beat seen this match.
   *
   * The client is never told the phase's configured length, only what is left
   * of it — so the first tick of the phase, which reports very nearly the whole
   * duration, is the measurement.
   */
  private intermissionLength = 5;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-round-result";

    const card = document.createElement("div");
    card.className = "fps-round-result-card";
    this.leadEl = document.createElement("div");
    this.leadEl.className = "fps-round-result-lead";
    this.winnerEl = document.createElement("div");
    this.winnerEl.className = "fps-round-result-winner";
    this.wonEl = document.createElement("div");
    this.wonEl.className = "fps-round-result-won";
    this.scoreEl = document.createElement("div");
    this.scoreEl.className = "fps-round-result-score";
    card.append(this.leadEl, this.winnerEl, this.wonEl, this.scoreEl);

    this.countEl = document.createElement("div");
    this.countEl.className = "fps-round-result-next";
    const label = document.createElement("span");
    label.textContent = "Get ready for the next round";
    this.countNumberEl = document.createElement("span");
    this.countNumberEl.className = "fps-round-result-count";
    this.countEl.append(label, this.countNumberEl);

    this.element.append(card, this.countEl);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public update(_state: HUDState): void {
    const match = MatchStateManager.getInstance();
    const result = this.currentResult(match);
    if (!result) {
      this.clear(match);
      return;
    }

    this.draw(match, result);
    // Through the round end and the freeze; an older recording knows only the phase's own time
    const left = match.nextRoundIn ?? match.timeRemaining;
    const count = Math.max(1, Math.ceil(left));
    if (count !== this.renderedCount) {
      this.renderedCount = count;
      this.countNumberEl.textContent = String(count);
      // Restart the stamp on every new number
      this.countNumberEl.classList.remove("is-ticking");
      void this.countNumberEl.offsetWidth;
      this.countNumberEl.classList.add("is-ticking");
    }
    this.element.classList.add("fps-round-result--shown");
  }

  /** The round just decided, while its intermission runs; null when none is. */
  private currentResult(match: MatchStateManager): RoundResult | null {
    const result = match.lastRoundResult;
    if (!result) return null;
    if (match.phase === MatchPhase.RoundEnd) {
      if (result.round !== match.round) return null;
      // A detonation plays out before the result covers it
      if (result.reason === "detonated" && this.intermissionLength - match.timeRemaining < EXPLOSION_GRACE_SECONDS)
        return null;
      return result;
    }
    // The next round's freeze: the round before it is still the news
    if (match.phase === MatchPhase.Countdown && match.nextRoundIn !== null && result.round === match.round - 1)
      return result;
    return null;
  }

  private draw(match: MatchStateManager, result: RoundResult): void {
    const scores = match.teamScores as Record<string, number>;
    const names = match.teamNames as Record<string, string>;
    const signature = `${result.round}|${result.reason}|${result.winnerName}|${scores.udon}|${scores.soba}`;
    if (signature === this.rendered) return;
    this.rendered = signature;

    const lead = leadFor(result.reason);
    this.leadEl.textContent = lead ?? "";
    this.leadEl.style.display = lead ? "" : "none";
    this.winnerEl.textContent = result.winner ? result.winnerName : "Round drawn";
    this.wonEl.textContent = result.winner ? "won the round!" : "";
    this.wonEl.style.display = result.winner ? "" : "none";
    this.element.classList.toggle("fps-round-result--defused", result.reason === "defused");
    this.element.classList.toggle("fps-round-result--detonated", result.reason === "detonated");

    // The rounds each side has, the winner's number lit, Soba left and Udon
    // right as the scoreboard puts them
    this.scoreEl.replaceChildren(
      this.side("soba", names.soba ?? "Team Soba", scores.soba ?? 0, result.winner === "soba", "left"),
      Object.assign(document.createElement("span"), { className: "fps-round-result-dash", textContent: ":" }),
      this.side("udon", names.udon ?? "Team Udon", scores.udon ?? 0, result.winner === "udon", "right"),
    );
  }

  private side(team: string, name: string, score: number, won: boolean, position: "left" | "right"): HTMLElement {
    const side = document.createElement("div");
    side.className = `fps-round-result-side fps-round-result-side--${team}${won ? " is-winner" : ""}`;
    const label = document.createElement("span");
    label.className = "fps-round-result-team";
    label.textContent = name;
    const number = document.createElement("span");
    number.className = "fps-round-result-rounds";
    number.textContent = String(score);
    side.append(...(position === "left" ? [label, number] : [number, label]));
    return side;
  }

  private clear(match: MatchStateManager): void {
    if (match.phase === MatchPhase.RoundEnd) {
      this.intermissionLength = Math.max(this.intermissionLength, match.timeRemaining);
    }
    if (this.rendered === null) return;
    this.rendered = null;
    this.renderedCount = null;
    this.element.classList.remove("fps-round-result--shown");
  }

  public show(): void {
    // Visibility is state-driven via update(); nothing to force here.
  }

  public hide(): void {
    this.element.classList.remove("fps-round-result--shown");
  }

  public destroy(): void {
    this.element.remove();
  }
}
