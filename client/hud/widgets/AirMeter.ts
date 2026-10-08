import { Game } from "../../../Game";
import type { FPSHudWidget, HUDState } from "../HudWidget";

// =============================================================================
// Air Meter — how long you can stay under
// =============================================================================

/** Below this fraction the meter switches to its urgent look. */
const LOW_AIR = 0.3;

/** Rendering steps. The bar moves in 5% jumps, not per-frame. */
const STEPS = 20;

/**
 * FPSAirMeter — a breath gauge, shown only while the head is under.
 *
 * Reads the client-side air mirror rather than replicated state: the server
 * owns the drowning damage, and a bar that disagrees by a tenth of a second
 * costs nothing, so paying protocol for it would be the wrong trade.
 *
 * Hidden entirely when there is nothing to say. A permanent meter reading
 * "full" is noise on a HUD that already has to carry health, armor, ammo and a
 * weapon rack — air only matters in the seconds when it is running out.
 *
 * Quantised to twenty steps for the same reason the powerup timer renders on
 * whole seconds: rewriting layout every frame for a bar nobody can read that
 * finely is churn.
 */
export class FPSAirMeter implements FPSHudWidget {
  private element: HTMLElement;
  private fill: HTMLElement;
  private label: HTMLElement;
  /** Last rendered step, or null when hidden. */
  private rendered: number | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-air-meter";
    this.element.style.display = "none";

    this.label = document.createElement("span");
    this.label.className = "fps-air-meter-label";
    this.label.textContent = "AIR";
    this.element.appendChild(this.label);

    const track = document.createElement("div");
    track.className = "fps-air-meter-track";
    this.fill = document.createElement("div");
    this.fill.className = "fps-air-meter-fill";
    track.appendChild(this.fill);
    this.element.appendChild(track);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public update(state: HUDState): void {
    const game = Game.getInstance();
    const air = game.localAirFraction;

    // Full air, or dead: nothing worth a line of HUD. Dying underwater should
    // take the meter with it rather than leave it frozen on the death screen.
    // Our own death, not the watched player's: the air is ours, and a living
    // teammate on screen put it back up as DROWNING (L4).
    if (state.localDead || air >= 1) {
      if (this.rendered !== null) {
        this.rendered = null;
        this.element.style.display = "none";
      }
      return;
    }

    const step = Math.round(air * STEPS);
    if (step === this.rendered) return;
    this.rendered = step;

    this.fill.style.width = `${(step / STEPS) * 100}%`;
    this.element.classList.toggle("fps-air-meter--low", air <= LOW_AIR);
    // Out of air entirely: the bar is empty and the damage has started, so the
    // label carries the news the bar no longer can.
    this.element.classList.toggle("fps-air-meter--drowning", game.localDrowning);
    this.label.textContent = game.localDrowning ? "DROWNING" : "AIR";
    this.element.style.display = "";
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
