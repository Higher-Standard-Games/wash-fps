export const REEL_MINUTES = [1, 2, 3] as const;
export type ReelMinutes = (typeof REEL_MINUTES)[number];

/** Highlight targets use at most a third of the source recording. */
export function reelLengths(durationMs: number): ReelMinutes[] {
  return REEL_MINUTES.filter((minutes) => durationMs >= minutes * 3 * 60_000);
}
