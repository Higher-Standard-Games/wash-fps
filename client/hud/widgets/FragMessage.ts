// Extracted from FPSHud.ts
import type { FPSHudWidget, HUDState } from "../HudWidget";

// =============================================================================
// Phase 2: Frag Message
// =============================================================================

/**
 * FPSFragMessage - "FRAGGED PLAYER" center screen message, for frags by the
 * player the view is behind: you, or whoever a demo or spectator follows
 *
 * Reads the kill feed and shows a message when the local player takes a frag.
 * Auto-removes after animation completes.
 */
export class FPSFragMessage implements FPSHudWidget {
  private element: HTMLElement;
  /** Highest kill feed `seq` already looked at; the feed's length cannot say */
  private seenSeq: number | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-frag-container";
    this.element.style.display = "flex";
    this.element.style.flexDirection = "column";
    this.element.style.alignItems = "center";
    this.element.style.gap = "4px";
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public update(state: HUDState): void {
    const feed = state.killFeed;
    const newest = feed.length > 0 ? feed[feed.length - 1].seq : 0;
    // Frags already in the feed when the HUD came up are someone else's news
    if (this.seenSeq === null) {
      this.seenSeq = newest;
      return;
    }
    if (newest <= this.seenSeq) return;

    for (const kill of feed) {
      if (kill.seq <= this.seenSeq) continue;
      if (kill.byViewed && !kill.ofViewed) this.showFragMessage(kill.victimName);
    }
    this.seenSeq = newest;
  }

  private showFragMessage(victimName: string): void {
    const msg = document.createElement("div");
    msg.className = "fps-frag-message";
    msg.textContent = `FRAGGED ${victimName}`;
    this.element.appendChild(msg);

    // Remove after animation (2.5s float-up)
    setTimeout(() => msg.remove(), 2600);
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
