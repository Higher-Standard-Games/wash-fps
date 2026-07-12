// Extracted from FPSHud.ts
import type { FPSHudWidget, HUDState } from "../HudWidget";

// =============================================================================
// Phase 2: Pickup Toast
// =============================================================================

/**
 * FPSPickupToast — cartoonish "picked up X" banners (weapon/ammo/armor/health).
 *
 * Driven by the server `pickup_notify` event (GameEvents calls showPickup with
 * the server-formatted label, for the local player only) — exact for every item
 * type and demo-faithful. The old client-side weapon-array diff heuristic is
 * gone (it missed armor/health/ammo and could double-fire).
 */
export class FPSPickupToast implements FPSHudWidget {
  private element: HTMLElement;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-toast-container";
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Show a pickup notification — a gold "clock-slab" banner that pops in and
   * floats up.
   */
  public showPickup(text: string): void {
    const toast = document.createElement("div");
    toast.className = "fps-pickup-toast";

    // Leading "+" badge so a pickup instantly reads as "you gained something".
    const plus = document.createElement("span");
    plus.className = "fps-pickup-toast-plus";
    plus.textContent = "+";
    toast.appendChild(plus);

    const label = document.createElement("span");
    label.className = "fps-pickup-toast-label";
    // Strip any leading "+" the server label may already carry (avoid "+ +").
    label.textContent = text.replace(/^\s*\+\s*/, "");
    toast.appendChild(label);

    this.element.appendChild(toast);

    // Remove after the slam → hold → tumble animation completes.
    setTimeout(() => toast.remove(), 2300);
  }

  public update(_state: HUDState): void {
    // No per-frame work — toasts are driven by the server `pickup_notify` event.
  }

  public show(): void {
    this.element.style.display = "";
  }

  public hide(): void {
    this.element.style.display = "none";
  }

  public destroy(): void {
    this.element.remove();
  }
}
