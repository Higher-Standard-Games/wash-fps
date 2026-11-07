import type { DemoService } from "../DemoService";
import type { DemoViewer } from "../DemoViewer";
import { abortable } from "./MovieClock";

/** Reconstruct a shot's transient state with sequential, unrecorded source steps. */
export async function warmShot(
  service: DemoService,
  viewer: DemoViewer,
  signal: AbortSignal,
  step: (sourceDeltaMs: number, remainingSourceMs: number) => Promise<void>,
  attempt?: () => void,
  leadIns: readonly number[] = [2, 11],
): Promise<number> {
  const landing = viewer.getInfo();
  const tickRate = landing.header!.tickRate;
  const firstTick = service.loadedDemoReader!.readIndex().entries[0].tick;
  const speed = viewer.getSpeed();
  try {
    for (const seconds of leadIns) {
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 11) throw new Error("Invalid shot lead-in");
      signal.throwIfAborted();
      viewer.setSpeed(1);
      viewer.seekToTick(Math.max(firstTick, landing.playheadTick - seconds * tickRate));
      viewer.play();
      attempt?.();
      let steps = 0;
      while (viewer.getInfo().playheadTick < landing.playheadTick - 0.000001) {
        signal.throwIfAborted();
        const remaining = ((landing.playheadTick - viewer.getInfo().playheadTick) * 1000) / tickRate;
        await step(Math.min(1000 / 60, remaining), remaining);
        if (++steps > 11 * 60 + 4) throw new Error("Shot pre-roll did not reach its landing frame");
        if (steps % 30 === 0) await abortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
      }
      const missing = service.getUnresolvedPlaybackProjectiles();
      if (!missing.length) return seconds;
      if (seconds === leadIns[leadIns.length - 1])
        throw new Error(`The shot is missing projectile spawn data: ${missing.join(", ")}`);
    }
    throw new Error("No shot lead-in was supplied");
  } finally {
    viewer.setSpeed(speed);
    if (landing.state !== "playing") viewer.pause();
  }
}
