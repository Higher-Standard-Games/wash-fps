import { abortable, MOVIE_FPS } from "./MovieClock";

export interface ReelMovieFrame {
  sourceTick: number;
  segment: number;
  speed: number;
  title: boolean;
  ended: boolean;
}

/** Sample the shared cinematic player, including its seek rounding and eased speeds. */
export async function collectReelMovieSchedule(
  step: (deltaMs: number, index: number) => ReelMovieFrame | Promise<ReelMovieFrame>,
  signal: AbortSignal,
  closingFrames = 3 * MOVIE_FPS,
): Promise<ReadonlyArray<Readonly<ReelMovieFrame>>> {
  if (!Number.isSafeInteger(closingFrames) || closingFrames < 1 || closingFrames > 10 * MOVIE_FPS)
    throw new Error("Invalid closing-card duration");
  const frames: Readonly<ReelMovieFrame>[] = [];
  let closing = -1;
  for (let i = 0; i < 240 * MOVIE_FPS; i++) {
    signal.throwIfAborted();
    const frame = await abortable(Promise.resolve(step(i === 0 ? 0 : 1000 / MOVIE_FPS, i)), signal);
    if (!Number.isFinite(frame.sourceTick) || !Number.isFinite(frame.speed) || frame.speed <= 0)
      throw new Error("Invalid cinematic movie clock");
    frames.push(Object.freeze({ ...frame }));
    if (frame.ended) {
      if (closing < 0) closing = closingFrames;
      if (--closing === 0) return Object.freeze(frames);
    } else if (closing >= 0) throw new Error("The reel resumed after its closing card");
    if (i % 60 === 0) await abortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
  }
  throw new Error("The selected reel exceeds the four-minute export limit");
}

/** Both traversals must use exactly the frozen movie/source mapping. */
export function assertReelMovieFrame(expected: Readonly<ReelMovieFrame>, actual: ReelMovieFrame, index: number): void {
  if (
    expected.segment !== actual.segment ||
    expected.title !== actual.title ||
    expected.ended !== actual.ended ||
    Math.abs(expected.sourceTick - actual.sourceTick) > 0.00001 ||
    Math.abs(expected.speed - actual.speed) > 0.00001
  )
    throw new Error(`Reel traversal diverged at movie frame ${index}`);
}
