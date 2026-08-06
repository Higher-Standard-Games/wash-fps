import { activeLocalPowerups } from "../../LocalPowerupState";
import type { FPSHudWidget, HUDState } from "../HudWidget";

// =============================================================================
// Powerup Timer — countdown slab for the local player's active powerups
// =============================================================================

/** Display name + slab modifier per powerup kind. */
const POWERUP_STYLE: Record<string, { label: string; modifier: string }> = {
  quad: { label: "QUAD", modifier: "fps-powerup-timer--quad" },
};

/** Below this many seconds the slab switches to the urgent "about to lapse" look. */
const EXPIRING_SECONDS = 5;

/**
 * FPSPowerupTimer — a countdown slab shown while the local player holds a
 * powerup. Reads LocalPowerupState, which is fed by the server's per-snapshot
 * `powerup_state` event and expires on its own deadline, so the widget cannot
 * outlive the effect it is advertising.
 *
 * Deliberately re-renders only when the displayed WHOLE second changes: update()
 * runs every frame, and rewriting textContent at 250Hz for a 1Hz countdown is
 * pure layout churn.
 */
export class FPSPowerupTimer implements FPSHudWidget {
  private element: HTMLElement;
  /** Last rendered "kind:seconds" so identical frames are skipped. */
  private rendered: string | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-powerup-timer";
    this.element.style.display = "none";
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public update(state: HUDState): void {
    // Dead players hold nothing — the server clears powerups on respawn, but
    // hiding immediately avoids a frame of stale countdown on the death screen.
    const active = state.dead ? [] : activeLocalPowerups();

    if (active.length === 0) {
      if (this.rendered !== null) {
        this.rendered = null;
        this.element.style.display = "none";
        this.element.textContent = "";
      }
      return;
    }

    // One powerup is live today (quad); sort so the display order is stable if
    // a second kind is ever added.
    active.sort((a, b) => a.kind.localeCompare(b.kind));

    const key = active.map((p) => `${p.kind}:${Math.ceil(p.seconds)}`).join("|");
    if (key === this.rendered) return;
    this.rendered = key;

    this.element.textContent = "";
    for (const { kind, seconds } of active) {
      const style = POWERUP_STYLE[kind];
      if (!style) continue;

      const slab = document.createElement("div");
      slab.className = `fps-powerup-timer-slab ${style.modifier}`;
      if (seconds <= EXPIRING_SECONDS) slab.classList.add("fps-powerup-timer-slab--expiring");

      const name = document.createElement("span");
      name.className = "fps-powerup-timer-label";
      name.textContent = style.label;
      slab.appendChild(name);

      const count = document.createElement("span");
      count.className = "fps-powerup-timer-count";
      count.textContent = String(Math.ceil(seconds));
      slab.appendChild(count);

      this.element.appendChild(slab);
    }
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
