import { describe, expect, it } from "vitest";
import { assertReelMovieFrame, collectReelMovieSchedule } from "../ReelMovieSchedule";

describe("frozen reel movie schedule", () => {
  it("retains holds, rewind cuts and slow motion with a finite closing card", async () => {
    const source = [
      { sourceTick: 125, segment: 0, speed: 1, title: true, ended: false },
      { sourceTick: 125, segment: 0, speed: 1, title: false, ended: false },
      { sourceTick: 127, segment: 0, speed: 0.5, title: false, ended: false },
      { sourceTick: 90, segment: 1, speed: 1, title: false, ended: false },
      { sourceTick: 150, segment: 2, speed: 0.4, title: false, ended: true },
    ];
    const deltas: number[] = [];
    const plan = await collectReelMovieSchedule(
      (dt, index) => {
        deltas.push(dt);
        return source[Math.min(index, source.length - 1)];
      },
      new AbortController().signal,
      180,
    );
    expect(plan).toHaveLength(184);
    expect(plan.slice(0, 5)).toEqual(source);
    expect(deltas[0]).toBe(0);
    expect(deltas.slice(1).every((dt) => dt === 1000 / 60)).toBe(true);
    expect(plan.filter((frame) => frame.ended)).toHaveLength(180);
    source[0].sourceTick = 999;
    expect(plan[0].sourceTick).toBe(125);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("rejects a second traversal with a changed cut, source tick, speed or hold", () => {
    const frame = { sourceTick: 100, segment: 0, speed: 1, title: false, ended: false };
    expect(() => assertReelMovieFrame(frame, { ...frame }, 0)).not.toThrow();
    for (const change of [{ sourceTick: 101 }, { segment: 1 }, { speed: 0.5 }, { title: true }, { ended: true }])
      expect(() => assertReelMovieFrame(frame, { ...frame, ...change }, 42)).toThrow("frame 42");
  });

  it("cancels during preparation rather than finishing the whole schedule", async () => {
    const controller = new AbortController();
    await expect(
      collectReelMovieSchedule((_dt, index) => {
        if (index === 3) controller.abort(new Error("cancel preparation"));
        return { sourceTick: index, segment: 0, speed: 1, title: false, ended: false };
      }, controller.signal),
    ).rejects.toThrow("cancel preparation");
  });
});
