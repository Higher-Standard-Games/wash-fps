import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExportAudioPlan, ExportSoundCue } from "../ExportAudioCapture";
import { mixExportAudio, streamExportAudio } from "../ExportAudioMixer";

/** Just enough of an offline graph: buffer sources through gains, nearest-sample playback. */
class Param {
  value = 0;
  readonly events: Array<{ ramp: boolean; value: number; time: number }> = [];
  setValueAtTime(value: number, time: number) {
    this.events.push({ ramp: false, value, time });
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ ramp: true, value, time });
  }
  at(time: number): number {
    let value = this.value;
    let from = Number.NEGATIVE_INFINITY;
    for (const event of [...this.events].sort((a, b) => a.time - b.time)) {
      if (event.time <= time) {
        value = event.value;
        from = event.time;
      } else {
        if (event.ramp && Number.isFinite(from)) value += ((event.value - value) * (time - from)) / (event.time - from);
        break;
      }
    }
    return value;
  }
}

class Buffer {
  readonly channels: Float32Array[];
  constructor(
    count: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: count }, () => new Float32Array(length));
  }
  get numberOfChannels() {
    return this.channels.length;
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(channel: number) {
    return this.channels[channel];
  }
}

class Node {
  output: Node | null = null;
  connect(node: Node) {
    this.output = node;
  }
  disconnect() {}
}

class Source extends Node {
  buffer: Buffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly detune = { value: 0 };
  readonly playbackRate = new Param();
  when = 0;
  offset = 0;
  until = Number.POSITIVE_INFINITY;
  start(when: number, offset = 0) {
    this.when = when;
    this.offset = offset;
  }
  stop(when: number) {
    this.until = when;
  }
}

class Gain extends Node {
  readonly gain = new Param();
}

class Context {
  readonly destination = new Node();
  readonly listener = Object.fromEntries(
    ["positionX", "positionY", "positionZ", "forwardX", "forwardY", "forwardZ", "upX", "upY", "upZ"].map((name) => [
      name,
      new Param(),
    ]),
  );
  private readonly sources: Source[] = [];
  constructor(
    readonly channels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {}
  createBufferSource() {
    const source = new Source();
    this.sources.push(source);
    return source;
  }
  createGain() {
    return new Gain();
  }
  async startRendering() {
    const out = new Buffer(this.channels, this.length, this.sampleRate);
    for (const source of this.sources) {
      const gain = source.output as Gain;
      const buffer = source.buffer!;
      for (let i = 0; i < this.length; i++) {
        const time = i / this.sampleRate;
        if (time < source.when || time >= source.until) continue;
        let position = source.offset + (time - source.when) * source.playbackRate.at(time);
        if (source.loop && position >= buffer.duration)
          position = source.loopStart + ((position - source.loopStart) % (buffer.duration - source.loopStart));
        const index = Math.round(position * buffer.sampleRate);
        if (index >= buffer.length) continue;
        for (let channel = 0; channel < this.channels; channel++)
          out.channels[channel][i] += buffer.channels[0][index] * gain.gain.at(time);
      }
    }
    return out;
  }
}

afterEach(() => vi.unstubAllGlobals());

const RATE = 1000;
function sound(seconds: number) {
  const buffer = new Buffer(1, seconds * RATE, RATE);
  // A slope: any misplaced offset shows as a step
  for (let i = 0; i < buffer.length; i++) buffer.channels[0][i] = 0.1 + (0.5 * i) / buffer.length;
  return buffer as unknown as AudioBuffer;
}

function cue(path: string, start: number, end: number | null, loop = false): ExportSoundCue {
  return { path, start, end, scope: 0, rate: 1, loop, options: {}, positions: [] };
}

function plan(duration: number, cues: ExportSoundCue[]): ExportAudioPlan {
  const listeners = Array.from({ length: Math.round(duration * 60) }, (_, i) => ({
    time: i / 60,
    rate: 1,
    scope: 0,
    position: { x: 0, y: 0, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
  }));
  return {
    cues,
    listeners,
    scopeStarts: new Map([
      [-1, 0],
      [0, 0],
    ]),
    scopeEnds: new Map([[0, duration]]),
    duration,
  };
}

describe("windowed match audio", () => {
  it("joins its windows into the same mix as one piece, at the same level", async () => {
    vi.stubGlobal(
      "OfflineAudioContext",
      class extends Context {
        constructor(channels: number, length: number, sampleRate: number) {
          super(channels, length, sampleRate);
        }
      },
    );
    const sounds = new Map([
      ["shot", sound(0.7)],
      ["long", sound(2.5)],
      ["hum", sound(0.4)],
    ]);
    const prepare = async (path: string) => ({ buffer: sounds.get(path)!, loopStart: 0.1 });
    const movie = plan(4, [
      cue("shot", 0.2, null),
      // Plays across two window edges
      cue("long", 0.8, null),
      cue("hum", 1.5, 3.7, true),
      cue("shot", 2.9, null),
    ]);
    const signal = new AbortController().signal;
    const whole = await mixExportAudio(movie, prepare, signal);
    const parts: Buffer[] = [];
    const streamed = await streamExportAudio(
      movie,
      prepare,
      signal,
      async (buffer) => {
        parts.push(buffer as unknown as Buffer);
      },
      undefined,
      1,
    );
    expect(parts).toHaveLength(4);
    expect(streamed.gain).toBeCloseTo(whole.gain, 9);
    const joined = parts.flatMap((part) => [...part.channels[0]]);
    const reference = [...whole.buffer.getChannelData(0)];
    expect(joined).toHaveLength(reference.length);
    // Rounding can move a nearest sample by one where a sound starts or loops: a handful, not a window
    const mismatched = joined.filter((value, i) => Math.abs(value - reference[i]) > 0.002).length;
    expect(mismatched).toBeLessThan(10);
    expect(reference.reduce((max, value) => Math.max(max, value), 0)).toBeGreaterThan(0.5);
  });
});
