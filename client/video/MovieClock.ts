export const MOVIE_FPS = 60;
/** A highlight reel's ceiling. */
export const REEL_MAX_SECONDS = 240;
/** A whole recorded match's ceiling: twice a ten-minute match. */
export const MATCH_MAX_SECONDS = 20 * 60;
/** After a full match's last frame: the fade to black and the end card held. */
export const MATCH_END_SECONDS = 5;
/** The longest full-match movie: the longest recording and its end. */
export const MATCH_MOVIE_MAX_SECONDS = MATCH_MAX_SECONDS + MATCH_END_SECONDS;

/** Integer timestamps from a frame index avoid cumulative rounding drift. */
export function movieFrame(index: number, fps = MOVIE_FPS) {
  if (!Number.isSafeInteger(index) || index < 0 || !Number.isInteger(fps) || fps < 1 || fps > 240)
    throw new Error("Invalid movie frame or frame rate");
  const timestampUs = Math.round((index * 1_000_000) / fps);
  return { index, timestampUs, durationUs: Math.round(((index + 1) * 1_000_000) / fps) - timestampUs };
}

/** Abort waits without allowing wall time to enter the movie timeline. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    work.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

/** One sequential producer: encoder/storage pressure delays work, never drops frames. */
export async function renderMovieFrames(
  count: number,
  signal: AbortSignal,
  render: (frame: ReturnType<typeof movieFrame>) => Promise<void>,
  maxSeconds = REEL_MAX_SECONDS,
): Promise<void> {
  if (!Number.isSafeInteger(count) || count < 1 || count > MOVIE_FPS * maxSeconds)
    throw new Error(`Movie must contain between one frame and ${maxSeconds / 60} minutes`);
  for (let i = 0; i < count; i++) {
    signal.throwIfAborted();
    await abortable(render(movieFrame(i)), signal);
  }
}
