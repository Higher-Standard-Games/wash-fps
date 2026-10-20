/**
 * Keeps a chat log on its newest message.
 *
 * A log is pinned to the bottom until the reader scrolls up, and pinned again
 * when they scroll back down. While pinned it stays at the bottom through
 * anything that changes its size: new messages, history arriving before the log
 * is on screen, a hidden page coming back, the window resizing.
 */

/** Within this many pixels of the bottom counts as at the bottom. */
const BOTTOM_SLACK = 40;

export class ChatScroll {
  private pinned = true;
  private readonly observer: ResizeObserver | null;

  constructor(private readonly log: HTMLElement) {
    log.addEventListener("scroll", () => {
      // A log that is not laid out (hidden page) scrolls to 0; that is not the reader
      if (log.clientHeight === 0) return;
      this.pinned = log.scrollHeight - log.scrollTop - log.clientHeight < BOTTOM_SLACK;
    });
    this.observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.follow());
    this.observer?.observe(log);
  }

  /** Call after adding or removing messages. */
  follow(): void {
    if (this.pinned) this.log.scrollTop = this.log.scrollHeight;
  }

  /** Back to the newest message, e.g. after the history loads. */
  toBottom(): void {
    this.pinned = true;
    this.follow();
    // History often lands before the log has its height; finish once it is laid out
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(() => this.follow());
  }

  destroy(): void {
    this.observer?.disconnect();
  }
}
