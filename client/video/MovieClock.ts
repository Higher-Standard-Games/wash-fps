export const MOVIE_FPS = 60;

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
): Promise<void> {
  if (!Number.isSafeInteger(count) || count < 1 || count > MOVIE_FPS * 240)
    throw new Error("Movie must contain between one frame and four minutes");
  for (let i = 0; i < count; i++) {
    signal.throwIfAborted();
    await abortable(render(movieFrame(i)), signal);
  }
}
