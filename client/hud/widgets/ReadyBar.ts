// Extracted from FPSHud.ts

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

  public update(state: HUDState): void {
    const mgr = MatchStateManager.getInstance();
    // A spectator has no F4 to press, whether chasing someone or flying free.
    const isSpectating = state.watcher;

    if (mgr.isWarmup() && !isSpectating) {
      // Joined player: gold count cell + prompt with keycap chip
      const readyText = mgr.isReady
        ? `<span class="fps-ready-text">Ready! Waiting for others</span>`
        : `<span class="fps-ready-text">Press <span class="fps-ready-key">F4</span> when ready</span>`;

      this.element.classList.remove("hidden", "fps-ready-bar--spectating");
      this.element.innerHTML = `<span class="fps-ready-count">${mgr.getReadyStatus()}</span>${readyText}`;
      this.element.classList.toggle("fps-ready-bar--ready", mgr.isReady);
    } else if (isSpectating) {
      // Spectating (in or out of warmup): magenta plate, no count cell
      this.element.classList.remove("hidden", "fps-ready-bar--ready");
      this.element.classList.add("fps-ready-bar--spectating");
      this.element.innerHTML = `<span class="fps-ready-text">Spectating</span>`;
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
