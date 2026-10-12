/**
 * LobbyFullNotice — what a player turned away at the lobby's player cap sees:
 * the servers are full, a countdown to the next try, and a key to try now.
 *
 * It sits over a corner of the lobby rather than covering it, so settings,
 * demos and the rest of the menu still work while the player waits.
 */

import { createRaisedKey, setRaisedKeyText } from "../../../engine/ui/components/RaisedKey";

/** Waits are spread this far either side of the lobby's, so turned-away players don't all return at once. */
const RETRY_JITTER_SEC = 10;
const MIN_WAIT_SEC = 5;
/** When the lobby gives no wait. */
const DEFAULT_WAIT_SEC = 60;

/** How long to wait before the next try: the lobby's wait, give or take RETRY_JITTER_SEC. */
export function retryDelaySec(retryAfterSec: number | undefined, random: () => number = Math.random): number {
  const base = retryAfterSec && retryAfterSec > 0 ? retryAfterSec : DEFAULT_WAIT_SEC;
  const jitter = Math.round((random() * 2 - 1) * RETRY_JITTER_SEC);
  return Math.max(MIN_WAIT_SEC, base + jitter);
}

export class LobbyFullNotice {
  readonly root: HTMLElement;
  private readonly countdownEl: HTMLElement;
  private readonly tryKey: HTMLButtonElement;
  private readonly retry: () => void;
  private tick: ReturnType<typeof setInterval> | null = null;
  private secondsLeft = 0;

  /** `retry` runs when the countdown ends or the player presses Try now. */
  constructor(retry: () => void) {
    this.retry = retry;
    this.root = document.createElement("section");
    this.root.className = "lobby-full";
    this.root.setAttribute("aria-labelledby", "lobby-full-title");

    const title = document.createElement("h2");
    title.className = "lobby-full__title";
    title.id = "lobby-full-title";
    title.textContent = "Servers are full";

    const text = document.createElement("p");
    text.className = "lobby-full__text";
    text.setAttribute("role", "status");
    text.textContent = "The maximum number of players are online. Please try again shortly.";

    this.countdownEl = document.createElement("p");
    this.countdownEl.className = "lobby-full__countdown";

    this.tryKey = createRaisedKey({ label: "Try now", variants: ["sm", "cream"] });
    this.tryKey.addEventListener("click", () => this.tryNow());

    const row = document.createElement("div");
    row.className = "lobby-full__row";
    row.append(this.countdownEl, this.tryKey);
    this.root.append(title, text, row);
  }

  get isOpen(): boolean {
    return this.root.isConnected;
  }

  /** Show the notice in `parent` (if it isn't already) and count down to the next try. */
  wait(parent: HTMLElement, retryAfterSec: number | undefined): void {
    if (!this.root.isConnected) parent.appendChild(this.root);
    this.stopTick();
    this.secondsLeft = retryDelaySec(retryAfterSec);
    this.tryKey.disabled = false;
    setRaisedKeyText(this.tryKey, "Try now");
    this.showCountdown();
    this.tick = setInterval(() => {
      this.secondsLeft--;
      if (this.secondsLeft <= 0) this.tryNow();
      else this.showCountdown();
    }, 1000);
  }

  close(): void {
    this.stopTick();
    this.root.remove();
  }

  private tryNow(): void {
    this.stopTick();
    this.tryKey.disabled = true;
    setRaisedKeyText(this.tryKey, "Trying…");
    this.countdownEl.textContent = "Connecting…";
    this.retry();
  }

  private showCountdown(): void {
    this.countdownEl.textContent = `Retrying in ${this.secondsLeft} s…`;
  }

  private stopTick(): void {
    if (this.tick !== null) clearInterval(this.tick);
    this.tick = null;
  }
}
