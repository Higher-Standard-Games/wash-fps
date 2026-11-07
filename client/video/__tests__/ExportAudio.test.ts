import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { describe, expect, it } from "vitest";
import { assertAudioAgreement, assertAudioMovieRates } from "../ExportAudioAgreement";
import { ExportAudioCapture } from "../ExportAudioCapture";
import { ExportAudioTimeline } from "../ExportAudioTimeline";

describe("offline game sound timeline", () => {
  it("detects a one-frame lag in the rate applied after a slow-motion picture", () => {
    const capture = new ExportAudioCapture(async () => {});
    capture.begin();
    const camera = { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } };
    for (const [i, rate] of [1, 0.4, 1].entries()) {
      capture.setTime(i / 60, rate);
      capture.sampleListener(camera);
    }
    const plan = capture.snapshot(3 / 60),
      schedule = [{ speed: 1 }, { speed: 0.4 }, { speed: 1 }];
    expect(() => assertAudioMovieRates(plan, schedule)).not.toThrow();
    plan.listeners[1].rate = 1;
    expect(() => assertAudioMovieRates(plan, schedule)).toThrow("frozen movie schedule");
  });
  it("rejects non-finite rate sample times and mismatched replayed sound choices", () => {
    expect(
      () =>
        new ExportAudioTimeline(
          [
            { time: 0, rate: 1 },
            { time: Number.NaN, rate: 1 },
          ],
          1,
        ),
    ).toThrow("rate schedule");
    const first = new ExportAudioCapture(async () => {});
    first.begin();
    first.play2D("shot-1", {});
    const plan = first.snapshot(1),
      replay = structuredClone(plan);
    expect(() => assertAudioAgreement(plan, replay)).not.toThrow();
    replay.cues[0].path = "shot-2";
    expect(() => assertAudioAgreement(plan, replay)).toThrow("sound timeline changed");
  });
  it("copies accessor-based engine vectors into transferable audio data", async () => {
    const sink = new ExportAudioCapture(async () => {});
    sink.begin();
    const position = new Vector3(1, 2, 3);
    sink.play3D("shot", position, {});
    const loop = await sink.playLoop3D("beam", position, {});
    position.x = 4;
    loop!.setPosition!(position);
    sink.sampleListener({ position, forward: new Vector3(0, 0, -1), up: Vector3.Up() });
    position.x = 9;
    const plan = sink.snapshot(1);
    expect(plan.cues[0].positions[0].position).toEqual({ x: 1, y: 2, z: 3 });
    expect(plan.cues[1].positions[1].position).toEqual({ x: 4, y: 2, z: 3 });
    expect(plan.listeners[0]).toMatchObject({ position: { x: 4, y: 2, z: 3 }, forward: { x: 0, y: 0, z: -1 } });
    expect(() => sink.play3D("invalid", new Vector3(Number.NaN, 0, 0), {})).toThrow("Invalid offline sound position");
  });
  it("integrates and inverts slow motion across eased frame-rate samples", () => {
    const timeline = new ExportAudioTimeline(
      [
        { time: 0, rate: 1 },
        { time: 1, rate: 0.5 },
        { time: 2, rate: 0.75 },
        { time: 3, rate: 1.2 },
      ],
      4,
    );
    expect(timeline.sourceAt(2)).toBe(1.5);
    expect(timeline.sourceAt(4)).toBeCloseTo(3.45);
    for (let time = 0; time <= 4; time += 0.01) expect(timeline.timeAt(timeline.sourceAt(time))).toBeCloseTo(time, 8);
  });

  it("records trigger time, copied source movement, loop lifetime and shot boundaries", async () => {
    const sink = new ExportAudioCapture(async () => {});
    const position = { x: 1, y: 2, z: 3 };
    const ambient = await sink.playLoop3D("ambient", position, {});
    sink.play2D("preparation-click", {});
    sink.begin();
    sink.setTime(0.5, 0.4);
    sink.play2D("shot", { volume: 0.9 });
    const beam = await sink.playLoop3D("beam", position, { pitch: 150 });
    position.x = 100;
    sink.setTime(0.75, 0.4);
    beam!.setPosition!(position);
    sink.cut(1, 1);
    sink.setTime(1, 1);
    beam!.stop();
    beam!.stop();
    const plan = sink.snapshot(2);
    ambient!.stop();
    expect(plan.cues.map((cue) => cue.path)).toEqual(["ambient", "shot", "beam"]);
    expect(plan.cues[0].end).toBeNull();
    expect(plan.cues[1]).toMatchObject({ start: 0.5, rate: 0.4, scope: 0 });
    expect(plan.cues[2]).toMatchObject({ start: 0.5, end: 1, options: { pitch: 150 } });
    expect(plan.cues[2].positions).toEqual([
      { time: 0.5, position: { x: 1, y: 2, z: 3 } },
      { time: 0.75, position: { x: 100, y: 2, z: 3 } },
    ]);
    expect(plan.scopeEnds.get(0)).toBe(1);
    expect(plan.scopeStarts.get(1)).toBe(1);
  });

  it("rejects aborted loop creation without retaining a voice", async () => {
    const sink = new ExportAudioCapture(async () => {}),
      controller = new AbortController();
    controller.abort();
    expect(await sink.playLoop3D("beam", null, {}, controller.signal)).toBeNull();
    expect(sink.snapshot(1).cues).toHaveLength(0);
  });
});
