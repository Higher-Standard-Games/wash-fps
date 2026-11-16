import { describe, expect, it } from "vitest";
import { type BeatSource, detectBeats } from "../MusicBeats";

const RATE = 22050;

/** A click track: a short decaying burst every beat, on a quiet hum, from `phase` seconds. */
function clicks(bpm: number, seconds: number, phase = 0): BeatSource {
  const data = new Float32Array(Math.round(seconds * RATE));
  const period = 60 / bpm;
  for (let i = 0; i < data.length; i++) data[i] = 0.02 * Math.sin((2 * Math.PI * 110 * i) / RATE);
  for (let t = phase; t < seconds; t += period) {
    const start = Math.round(t * RATE);
    for (let i = 0; i < RATE * 0.03 && start + i < data.length; i++) {
      data[start + i] += 0.8 * Math.exp(-i / (RATE * 0.006)) * (i % 2 === 0 ? 1 : -1);
    }
  }
  return { sampleRate: RATE, length: data.length, numberOfChannels: 1, getChannelData: () => data };
}

describe("detectBeats", () => {
  it("finds a steady beat's tempo and where its beats land", () => {
    const beats = detectBeats(clicks(128, 20, 0.25), 0, 20);
    const period = 60 / 128;
    expect(beats.length).toBeGreaterThan(35);
    const gaps = beats.slice(1).map((b, i) => b - beats[i]);
    const median = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    expect(median).toBeCloseTo(period, 1);
    // Every beat within 20 ms of a click
    for (const beat of beats) {
      const offset = (((beat - 0.25) % period) + period) % period;
      expect(Math.min(offset, period - offset)).toBeLessThan(0.02);
    }
  });

  it("reads only the stretch asked for", () => {
    const beats = detectBeats(clicks(100, 30), 10, 10);
    expect(beats[0]).toBeGreaterThanOrEqual(10);
    expect(beats.at(-1)!).toBeLessThan(20);
  });

  it("gives no beats for a song without a steady one", () => {
    const data = new Float32Array(RATE * 20);
    let seed = 7;
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 16807) % 2147483647;
      data[i] = 0.3 * (seed / 2147483647 - 0.5);
    }
    const source = { sampleRate: RATE, length: data.length, numberOfChannels: 1, getChannelData: () => data };
    expect(detectBeats(source, 0, 20)).toEqual([]);
  });
});
