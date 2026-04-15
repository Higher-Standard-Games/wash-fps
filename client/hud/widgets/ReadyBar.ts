// Extracted from FPSHud.ts

import { CameraSystem } from "../../../../../engine/camera/CameraSystem";
import { MatchStateManager } from "../../MatchStateManager";
import type { FPSHudWidget, HUDState } from "../HudWidget";

/**
 * FPSReadyBar - Ready status bar during warmup
 *
 * Shows ready count and F4 keybind. Only visible during Warmup phase.
 */
export class FPSReadyBar implements FPSHudWidget {
  private element: HTMLElement;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-ready-bar hidden";
    // Positioned independently from HUD zones
    document.body.appendChild(this.element);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public update(_state: HUDState): void {
    const mgr = MatchStateManager.getInstance();
    const controller = CameraSystem.getInstance()?.getActiveController();
    const isSpectating = controller?.type === "freefly";

    if (mgr.isWarmup()) {
      this.element.classList.remove("hidden");

      if (isSpectating) {
        // Spectator mode: show "SPECTATING" (or player name when chasing)
        this.element.innerHTML = "SPECTATING";
        this.element.classList.remove("fps-ready-bar--ready");
      } else {
        // Joined player: show ready counter and F4 prompt
        const readyText = mgr.isReady ? "✓ Ready" : `Press <span class="fps-ready-key">F4</span> when ready`;

        this.element.innerHTML = `${mgr.getReadyStatus()} — ${readyText}`;
        this.element.classList.toggle("fps-ready-bar--ready", mgr.isReady);
      }
    } else if (isSpectating) {
      // Outside warmup but spectating: still show "SPECTATING"
      this.element.classList.remove("hidden");
      this.element.innerHTML = "SPECTATING";
      this.element.classList.remove("fps-ready-bar--ready");
    } else {
      this.element.classList.add("hidden");
    }
  }

  public show(): void {
    this.element.classList.remove("hidden");
  }
  public hide(): void {
    this.element.classList.add("hidden");
  }

  public destroy(): void {
    this.element.remove();
  }
}
