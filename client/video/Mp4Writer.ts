import type { CanvasSource, Mp4OutputFormat, Output, StreamTarget } from "mediabunny";
import { abortable, MOVIE_FPS, type movieFrame } from "./MovieClock";
import { TemporaryVideo } from "./TemporaryVideo";

/** Export-only encoder adapter, loaded on demand with its pinned muxer. */
export class Mp4Writer {
  private audioPromise: Promise<void> | null = null;
  private audioError: unknown;
  private constructor(
    readonly temporary: TemporaryVideo,
    private readonly output: Output<Mp4OutputFormat, StreamTarget>,
    private readonly video: CanvasSource,
    private readonly signal: AbortSignal,
  ) {}

  static async assertSupported(width: number, height: number, withAudio: boolean) {
    if (typeof VideoEncoder === "undefined")
      throw new Error("Video export requires a browser with H.264 WebCodecs encoding");
    const media = await import("mediabunny");
    const quality = new media.Quality({ bitrate: 20_000_000 });
    if (
      !(await media.canEncodeVideo("avc", {
        width,
        height,
        frameRate: MOVIE_FPS,
        quality,
      }))
    )
      throw new Error("This browser cannot encode H.264 at the selected dimensions and 60 FPS");
    if (
      withAudio &&
      !(await media.canEncodeAudio("aac", {
        numberOfChannels: 2,
        sampleRate: 48000,
        quality: new media.Quality({ bitrate: 192_000 }),
      }))
    )
      throw new Error("This browser cannot encode stereo AAC audio at 48 kHz");
    return media;
  }

  static async create(
    canvas: HTMLCanvasElement,
    seconds: number,
    signal: AbortSignal,
    audio?: AudioBuffer,
  ): Promise<Mp4Writer> {
    signal.throwIfAborted();
    const media = await Mp4Writer.assertSupported(canvas.width, canvas.height, !!audio);
    const quality = new media.Quality({ bitrate: 20_000_000 });
    signal.throwIfAborted();
    const temporary = await TemporaryVideo.create(Math.ceil(seconds * 2_500_000 * 1.25));
    const output = new media.Output({
      format: new media.Mp4OutputFormat({ fastStart: false }),
      target: new media.StreamTarget(temporary.stream, { chunked: true, chunkSize: 64 * 1024 }),
    });
    const video = new media.CanvasSource(canvas, { codec: "avc", quality, keyFrameInterval: 1 });
    output.addVideoTrack(video, { frameRate: MOVIE_FPS });
    const audioSource = audio
      ? new media.AudioBufferSource({ codec: "aac", quality: new media.Quality({ bitrate: 192_000 }) })
      : null;
    if (audioSource) output.addAudioTrack(audioSource);
    const writer = new Mp4Writer(temporary, output, video, signal);
    try {
      await abortable(output.start(), signal);
      if (audioSource && audio) {
        // Feed both tracks concurrently: a whole audio-track await can deadlock on video pressure.
        writer.audioPromise = audioSource
          .add(audio)
          .then(
            () => {
              audioSource.close();
            },
            (error) => {
              writer.audioError = error;
              audioSource.close();
            },
          )
          .catch((error) => {
            writer.audioError = error;
          });
      }
      return writer;
    } catch (error) {
      await writer.dispose();
      throw error;
    }
  }

  async add(frame: ReturnType<typeof movieFrame>): Promise<void> {
    if (this.audioError !== undefined) throw this.audioError;
    await abortable(this.video.add(frame.timestampUs / 1_000_000, frame.durationUs / 1_000_000), this.signal);
  }

  async finish(): Promise<TemporaryVideo> {
    this.video.close();
    if (this.audioPromise) await abortable(this.audioPromise, this.signal);
    if (this.audioError !== undefined) throw this.audioError;
    await abortable(this.output.finalize(), this.signal);
    this.temporary.finish();
    return this.temporary;
  }

  async dispose(): Promise<void> {
    try {
      await this.output.cancel();
      await this.audioPromise;
    } finally {
      await this.temporary.dispose();
    }
  }
}
