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

    if (state.playback) {
      // A recording: the bar is about readying up, which the watcher is not doing
      this.element.classList.add("hidden");
      this.shown = "";
    } else if (mgr.isWarmup() && !isSpectating) {
      // Joined player: gold count cell + prompt with keycap chip
      const readyText = mgr.isReady
        ? `<span class="fps-ready-text">Ready! Waiting for others</span>`
        : `<span class="fps-ready-text">Press <span class="fps-ready-key">F4</span> when ready</span>`;

      this.write(
        `player|${mgr.isReady}`,
        `<span class="fps-ready-count"><span class="fps-ready-count-label">${mgr.getReadyStatus()}</span></span>${readyText}`,
        () => {
          this.element.classList.remove("hidden", "fps-ready-bar--spectating");
          this.element.classList.toggle("fps-ready-bar--ready", mgr.isReady);
        },
      );
    } else if (isSpectating) {
      // Spectating (in or out of warmup): magenta plate, no count cell
      this.write("spectating", `<span class="fps-ready-text">Spectating</span>`, () => {
        this.element.classList.remove("hidden", "fps-ready-bar--ready");
        this.element.classList.add("fps-ready-bar--spectating");
      });
    } else {
      this.element.classList.add("hidden");
      this.shown = "";
    }
  }

  /** What the bar currently shows: its mode and markup. Empty while hidden. */
  private shown = "";

  /**
   * Put the bar into a state.
   *
   * The classes are applied on every poll, which is free when they already hold and keeps the
   * bar visible if something hid it from outside. The markup is only rewritten when it differs
   * from what is showing: the HUD polls 20 times a second, and rewriting identical markup throws
   * the elements away and restarts their CSS animations each time.
   */
  private write(mode: string, html: string, applyClasses: () => void): void {
    applyClasses();
    const key = `${mode}|${html}`;
    if (key === this.shown) return;
    this.shown = key;
    this.element.innerHTML = html;
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
