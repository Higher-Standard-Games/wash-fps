import type { ExportAudioPlan, ExportSoundCue } from "./ExportAudioCapture";

const rounded = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const point = (value: { x: number; y: number; z: number }) => [value.x, value.y, value.z].map(rounded);
const signature = (cue: ExportSoundCue) =>
  JSON.stringify({
    path: cue.path,
    start: rounded(cue.start),
    end: cue.end === null ? null : rounded(cue.end),
    scope: cue.scope,
    rate: rounded(cue.rate),
    loop: cue.loop,
    options: cue.options,
    positions: cue.positions.map((sample) => [rounded(sample.time), ...point(sample.position)]),
  });

/** The sampled rate describes the source interval after each pictured frame. */
export function assertAudioMovieRates(plan: ExportAudioPlan, frames: readonly { speed: number }[]): void {
  if (
    plan.listeners.length !== frames.length ||
    plan.listeners.some((frame, i) => Math.abs(frame.rate - frames[i].speed) > 0.000001)
  )
    throw new Error("Sound rates do not match the frozen movie schedule");
}

/** A prepared mix is valid only for the exact sound choices and camera path replayed in video. */
export function assertAudioAgreement(prepared: ExportAudioPlan, rendered: ExportAudioPlan): void {
  const a = prepared.cues.map(signature).sort(),
    b = rendered.cues.map(signature).sort();
  const mismatch = a.findIndex((value, index) => value !== b[index]);
  if (a.length !== b.length || mismatch >= 0)
    throw Object.assign(new Error("The sound timeline changed during rendering. Retry the export."), {
      cause: { preparedCount: a.length, renderedCount: b.length, preparedCue: a[mismatch], renderedCue: b[mismatch] },
    });
  if (prepared.listeners.length !== rendered.listeners.length) throw new Error("Audio listener frame coverage changed");
  for (let i = 0; i < prepared.listeners.length; i++) {
    const first = prepared.listeners[i],
      second = rendered.listeners[i];
    if (
      first.scope !== second.scope ||
      Math.abs(first.time - second.time) > 0.000001 ||
      Math.abs(first.rate - second.rate) > 0.000001 ||
      [first.position, first.forward, first.up].some((value, index) => {
        const next = [second.position, second.forward, second.up][index];
        return (
          Math.abs(value.x - next.x) > 0.0001 ||
          Math.abs(value.y - next.y) > 0.0001 ||
          Math.abs(value.z - next.z) > 0.0001
        );
      })
    )
      throw new Error(`Audio listener traversal diverged at movie frame ${i}`);
  }
}
