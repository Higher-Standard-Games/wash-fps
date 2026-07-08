// Extracted from FPSHud.ts

import { MatchStateManager } from "../../MatchStateManager";
import type { FPSHudWidget, HUDState } from "../HudWidget";

/**
 * FPSTimer - Match timer display
 */
export class FPSTimer implements FPSHudWidget {
  private element: HTMLElement;
  private textEl: HTMLElement;
  private currentTime: string = "";

  constructor() {
    const el = document.createElement("div");
    el.className = "fps-timer";

    const caption = document.createElement("span");
    caption.className = "fps-timer-caption";
    caption.textContent = "TIME";
    el.appendChild(caption);

    this.textEl = document.createElement("span");
    this.textEl.className = "fps-timer-text";
    el.appendChild(this.textEl);

    this.element = el;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public update(_state: HUDState): void {
    const match = MatchStateManager.getInstance();
    const timeRemaining = match.timeRemaining;
    if (timeRemaining <= 0 && match.isWarmup()) {
      // No time limit during warmup — dimmed idle plate
      if (this.currentTime !== "--:--") {
        this.currentTime = "--:--";
        this.textEl.textContent = "--:--";
        this.element.classList.add("fps-timer--idle");
        this.element.classList.remove("fps-timer--warning", "fps-timer--critical");
      }
      return;
    }

    const timeStr = match.getTimeString();

    if (timeStr === this.currentTime) return;
    this.currentTime = timeStr;
    this.textEl.textContent = timeStr;

    // Warning states
    this.element.classList.remove("fps-timer--idle", "fps-timer--warning", "fps-timer--critical");
    if (timeRemaining <= 10) {
      this.element.classList.add("fps-timer--critical");
    } else if (timeRemaining <= 30) {
      this.element.classList.add("fps-timer--warning");
    }
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
