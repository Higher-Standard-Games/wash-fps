import { getAmmoStatus } from "../../AmmoStatus";
import { FPS, getActionKeyLabel } from "../../FPSActions";
import type { FPSHudWidget, HUDState } from "../HudWidget";

// =============================================================================
// Ammo Warning — "OUT OF AMMO" / "RELOAD" print-slab banner
// =============================================================================

/**
 * FPSAmmoWarning — a persistent gold "clock-slab" banner shown just above the
 * speedometer that surfaces two ammo states for the equipped weapon:
 *
 *  - OUT OF AMMO (red slab, urgent) — weapon has no clip and no reserve.
 *  - RELOAD (gold slab) — clip weapon whose magazine is low/empty with reserve
 *    to reload from (~20% of clip left).
 *
 * The signal comes from getAmmoStatus() — the same derivation that drives the
 * red-X crosshair — so the banner and the reticle never disagree. Hidden while
 * dead/spectating or when the weapon is fine.
 */
type WarningKind = "none" | "out" | "reload";

export class FPSAmmoWarning implements FPSHudWidget {
  private element: HTMLElement;
  private label: HTMLElement;
  private current: WarningKind = "none";

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-ammo-warning";
    this.element.style.display = "none";

    this.label = document.createElement("span");
    this.label.className = "fps-ammo-warning-label";
    this.element.appendChild(this.label);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public update(state: HUDState): void {
    let kind: WarningKind = "none";
    if (!state.dead) {
      const status = getAmmoStatus(state.currentWeapon, state.ammo[state.currentWeapon]);
      if (status.outOfAmmo) kind = "out";
      else if (status.lowClip) kind = "reload";
    }

    if (kind === this.current) return;
    this.current = kind;

    if (kind === "none") {
      this.element.style.display = "none";
      return;
    }

    // Build label content. RELOAD is actionable, so it shows the live reload
    // keybind as a keycap chip after the word.
    this.label.textContent = "";
    if (kind === "out") {
      this.label.textContent = "OUT OF AMMO";
    } else {
      this.label.appendChild(document.createTextNode("RELOAD "));
      const keycap = document.createElement("span");
      keycap.className = "fps-keycap";
      keycap.textContent = getActionKeyLabel(FPS.RELOAD);
      this.label.appendChild(keycap);
    }
    this.element.classList.toggle("fps-ammo-warning--out", kind === "out");
    this.element.classList.toggle("fps-ammo-warning--reload", kind === "reload");
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
