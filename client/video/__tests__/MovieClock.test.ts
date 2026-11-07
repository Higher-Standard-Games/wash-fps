import { describe, expect, it } from "vitest";
import { abortable, movieFrame, renderMovieFrames } from "../MovieClock";

describe("movie frame ownership", () => {
  it("ends three minutes exactly without accumulating rounded durations", () => {
    let end = 0;
    for (let i = 0; i < 10800; i++) {
      const frame = movieFrame(i);
      expect(frame.timestampUs).toBe(end);
      end += frame.durationUs;
    }
    expect(end).toBe(180_000_000);
  });

  it("waits for the sink before producing the next frame", async () => {
    const seen: number[] = [];
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = renderMovieFrames(3, new AbortController().signal, async (frame) => {
      seen.push(frame.timestampUs);
      if (frame.index === 0) await waiting;
    });
    await Promise.resolve();
    expect(seen).toEqual([0]);
    release();
    await job;
    expect(seen).toEqual([0, 16667, 33333]);
  });

  it("interrupts a stalled encoder wait and does not produce another frame", async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    const job = renderMovieFrames(600, controller.signal, async (frame) => {
      seen.push(frame.index);
      await new Promise<void>(() => {});
    });
    controller.abort(new Error("cancelled"));
    await expect(job).rejects.toThrow("cancelled");
    expect(seen).toEqual([0]);
  });

  it("observes a late rejection after cancellation", async () => {
    const controller = new AbortController();
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const job = abortable(pending, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(job).rejects.toThrow("cancelled");
    fail(new Error("late encoder failure"));
    await Promise.resolve();
  });

  it.each([-1, NaN, 0.5, Infinity])("rejects invalid frame %s", (index) => {
    expect(() => movieFrame(index)).toThrow();
  });
});
