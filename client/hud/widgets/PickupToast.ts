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
  /** Only one toast is shown at a time (a rapid pickup burst would otherwise
   *  flood the screen). A new pickup replaces the current one in place. */
  private currentToast: HTMLElement | null = null;
  private removeTimer: number | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-toast-container";
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Show a pickup notification — a gold "clock-slab" banner that pops in and
   * floats up. Grabbing several items in quick succession replaces the banner
   * (latest wins) instead of stacking a wall of toasts.
   */
  public showPickup(text: string): void {
    // Replace any existing toast so pickups don't pile up on screen.
    if (this.removeTimer !== null) {
      clearTimeout(this.removeTimer);
      this.removeTimer = null;
    }
    this.currentToast?.remove();

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
    this.currentToast = toast;

    // Remove after the slam → hold → tumble animation completes.
    this.removeTimer = window.setTimeout(() => {
      toast.remove();
      if (this.currentToast === toast) this.currentToast = null;
      this.removeTimer = null;
    }, 2300);
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
