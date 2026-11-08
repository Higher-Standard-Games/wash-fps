import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportAudioCapture } from "../ExportAudioCapture";
import { mixExportAudio } from "../ExportAudioMixer";
import { musicPlaybackWindow, parseSongStart, soundtrackTitle } from "../ExportMusicSelection";

afterEach(() => vi.unstubAllGlobals());

describe("highlight soundtrack selection", () => {
  it.each([
    ["0:00", 0],
    ["1:23.250", 83.25],
    ["01:02:03.5", 3723.5],
    ["90", 90],
  ])("parses %s", (input, expected) => {
    expect(parseSongStart(String(input))).toBe(expected);
  });

  it.each(["", "-1", "1:60", "1:2", "NaN", "1:00:99", "1.1234"])("rejects invalid timestamp %s", (input) => {
    expect(() => parseSongStart(input)).toThrow();
  });

  it("uses the chosen song position and stops at either the song or movie end", () => {
    expect(musicPlaybackWindow(180, 30, 60)).toEqual({ offset: 30, duration: 60, fadeIn: 0.25, fadeOut: 1.5 });
    expect(musicPlaybackWindow(180, 179.8, 60).duration).toBeCloseTo(0.2);
    expect(() => musicPlaybackWindow(180, 180, 60)).toThrow("before the end");
  });

  it("derives readable titles from OST package paths", () => {
    expect(soundtrackTitle("music/ramen_will_be_ours_washoi!.mp3")).toBe("Ramen Will Be Ours Washoi!");
    expect(soundtrackTitle("endgame_udon.mp3")).toBe("Endgame Udon");
  });

  it("schedules one continuous song at the chosen offset without applying the movie's slow motion", async () => {
    const parameter = () => ({ value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
    const source = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      playbackRate: parameter(),
    };
    const gain = { connect: vi.fn(), disconnect: vi.fn(), gain: parameter() };
    const createBufferSource = vi.fn(() => source);
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        destination = {};
        listener = Object.fromEntries(
          ["positionX", "positionY", "positionZ", "forwardX", "forwardY", "forwardZ", "upX", "upY", "upZ"].map(
            (key) => [key, parameter()],
          ),
        );
        createBufferSource = createBufferSource;
        createGain = () => gain;
        startRendering = async () => ({ numberOfChannels: 2, getChannelData: () => new Float32Array(1) });
      },
    );
    const capture = new ExportAudioCapture(async () => {});
    capture.begin();
    capture.setTime(0, 0.4);
    capture.sampleListener({
      position: { x: 0, y: 0, z: 0 },
      forward: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
    });
    const plan = capture.snapshot(60),
      prepare = vi.fn();
    const signal = new AbortController().signal;
    const silent = await mixExportAudio(plan, prepare, signal);
    expect(silent.voices).toBe(0);
    expect(createBufferSource).not.toHaveBeenCalled();
    const mixed = await mixExportAudio(plan, prepare, signal, {
      buffer: { duration: 180 } as AudioBuffer,
      startSeconds: 30,
    });
    expect(mixed.voices).toBe(1);
    expect(source.start).toHaveBeenCalledWith(0, 30);
    expect(source.stop).toHaveBeenCalledWith(60);
    expect(source.playbackRate.value).toBe(1);
    expect(source.playbackRate.setValueAtTime).not.toHaveBeenCalled();
    expect(gain.gain.linearRampToValueAtTime.mock.calls).toEqual([
      [0.8, 0.25],
      [0, 60],
    ]);
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "layers effects under selected music while preserving game-only gain (music=%s)",
    async (withMusic) => {
      const parameter = () => ({ value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
      const gains: ReturnType<typeof parameter>[] = [];
      vi.stubGlobal(
        "OfflineAudioContext",
        class {
          destination = {};
          listener = Object.fromEntries(
            ["positionX", "positionY", "positionZ", "forwardX", "forwardY", "forwardZ", "upX", "upY", "upZ"].map(
              (key) => [key, parameter()],
            ),
          );
          createBufferSource = () => ({
            connect() {},
            disconnect() {},
            start() {},
            stop() {},
            detune: parameter(),
            playbackRate: parameter(),
          });
          createGain = () => {
            const gain = parameter();
            gains.push(gain);
            return { gain, connect() {}, disconnect() {} };
          };
          startRendering = async () => ({ numberOfChannels: 2, getChannelData: () => new Float32Array(1) });
        },
      );
      const capture = new ExportAudioCapture(async () => {});
      capture.begin();
      capture.play2D("shot", { volume: 0.6 });
      capture.sampleListener({
        position: { x: 0, y: 0, z: 0 },
        forward: { x: 0, y: 0, z: -1 },
        up: { x: 0, y: 1, z: 0 },
      });
      await mixExportAudio(
        capture.snapshot(2),
        async () => ({ buffer: { duration: 1 } as AudioBuffer, loopStart: 0 }),
        new AbortController().signal,
        withMusic ? { buffer: { duration: 180 } as AudioBuffer, startSeconds: 30 } : undefined,
      );
      expect(gains[gains.length - 1].setValueAtTime).toHaveBeenCalledWith(withMusic ? 0.21 : 0.6, 0);
    },
  );
});
