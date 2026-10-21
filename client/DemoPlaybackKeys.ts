/**
 * The keyboard over demo playback and highlight reels: what a key does, apart
 * from doing it, so the mapping can be read (and tested) in one place.
 *
 *   Space        play or pause
 *   ← / →        5 seconds back or on (a reel: the previous or next shot)
 *   , / .        one frame back or on, paused
 *   ↑ / ↓        faster or slower
 *   P / N        the previous or next frag
 *   Tab          the next player's eyes (Shift+Tab the previous)
 *   1 – 9        that player's eyes, in the player list's order
 *
 * Esc (leave) and H (hide the overlays) are handled where they were before.
 */

export type DemoKeyAction =
  | { type: "toggle_pause" }
  | { type: "seek"; seconds: number }
  | { type: "shot"; step: 1 | -1 }
  | { type: "frame"; step: 1 | -1 }
  | { type: "speed"; step: 1 | -1 }
  | { type: "frag"; step: 1 | -1 }
  | { type: "player"; step: 1 | -1 }
  | { type: "player_at"; index: number };

export interface DemoKeyContext {
  /** A highlight reel rather than a whole demo: only pause and shots apply. */
  reel: boolean;
  /** The free-flying camera has the movement keys (Space, arrows). */
  freeCamera: boolean;
}

/** How far ← and → move a demo. */
export const DEMO_SEEK_SECONDS = 5;

export function demoKeyAction(
  event: Pick<KeyboardEvent, "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">,
  context: DemoKeyContext,
): DemoKeyAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const movement = event.code === "Space" || event.code.startsWith("Arrow");
  if (movement && context.freeCamera) return null;

  if (event.code === "Space") return { type: "toggle_pause" };
  if (context.reel) {
    if (event.code === "ArrowLeft") return { type: "shot", step: -1 };
    if (event.code === "ArrowRight") return { type: "shot", step: 1 };
    return null;
  }
  switch (event.code) {
    case "ArrowLeft":
      return { type: "seek", seconds: -DEMO_SEEK_SECONDS };
    case "ArrowRight":
      return { type: "seek", seconds: DEMO_SEEK_SECONDS };
    case "Comma":
      return { type: "frame", step: -1 };
    case "Period":
      return { type: "frame", step: 1 };
    case "ArrowUp":
      return { type: "speed", step: 1 };
    case "ArrowDown":
      return { type: "speed", step: -1 };
    case "KeyN":
      return { type: "frag", step: 1 };
    case "KeyP":
      return { type: "frag", step: -1 };
    case "Tab":
      return { type: "player", step: event.shiftKey ? -1 : 1 };
  }
  const digit = /^Digit([1-9])$/.exec(event.code);
  return digit ? { type: "player_at", index: Number(digit[1]) - 1 } : null;
}

/**
 * Where a frag key lands: a couple of seconds before the next (or previous)
 * frag, so it is seen coming. `from` is the playhead; a frag just jumped to
 * counts as passed, so pressing again moves on.
 */
export function fragSeekTick(
  fragTicks: readonly number[],
  from: number,
  step: 1 | -1,
  tickRate: number,
): number | null {
  const leadIn = 2 * tickRate;
  const starts = [...fragTicks].sort((a, b) => a - b).map((tick) => Math.max(0, tick - leadIn));
  const slack = 0.5 * tickRate;
  if (step > 0) return starts.find((tick) => tick > from + slack) ?? null;
  for (let i = starts.length - 1; i >= 0; i--) if (starts[i] < from - slack) return starts[i];
  return null;
}
