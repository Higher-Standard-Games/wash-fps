import type { CanvasSource, Mp4OutputFormat, Output, StreamTarget } from "mediabunny";
import { abortable, MOVIE_FPS, type movieFrame } from "./MovieClock";
import { TemporaryVideo } from "./TemporaryVideo";

/** A highlight reel's picture: short, so as sharp as the encoder will make it. */
const REEL_VIDEO_BITRATE = 20_000_000;
const AUDIO_BITRATE = 192_000;

export interface Mp4WriterOptions {
  /** Target video bitrate in bits per second. */
  videoBitrate?: number;
  /** Ceiling for the encoded file. */
  maxBytes?: number;
}

/** Bytes a movie of this length may take at a bitrate, with room for a busy scene. */
export function movieBytes(seconds: number, videoBitrate: number): number {
  return Math.ceil(((seconds * (videoBitrate + AUDIO_BITRATE)) / 8) * 1.25);
}

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

  static async assertSupported(width: number, height: number, withAudio: boolean, videoBitrate = REEL_VIDEO_BITRATE) {
    if (typeof VideoEncoder === "undefined")
      throw new Error("Video export requires a browser with H.264 WebCodecs encoding");
    const media = await import("mediabunny");
    const quality = new media.Quality({ bitrate: videoBitrate });
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
        quality: new media.Quality({ bitrate: AUDIO_BITRATE }),
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
    options: Mp4WriterOptions = {},
  ): Promise<Mp4Writer> {
    signal.throwIfAborted();
    const videoBitrate = options.videoBitrate ?? REEL_VIDEO_BITRATE;
    const media = await Mp4Writer.assertSupported(canvas.width, canvas.height, !!audio, videoBitrate);
    const quality = new media.Quality({ bitrate: videoBitrate });
    signal.throwIfAborted();
    const temporary = await TemporaryVideo.create(
      options.maxBytes === undefined ? Math.ceil(seconds * 2_500_000 * 1.25) : movieBytes(seconds, videoBitrate),
      options.maxBytes,
    );
    const output = new media.Output({
      format: new media.Mp4OutputFormat({ fastStart: false }),
      target: new media.StreamTarget(temporary.stream, { chunked: true, chunkSize: 64 * 1024 }),
    });
    const video = new media.CanvasSource(canvas, { codec: "avc", quality, keyFrameInterval: 1 });
    output.addVideoTrack(video, { frameRate: MOVIE_FPS });
    const audioSource = audio
      ? new media.AudioBufferSource({ codec: "aac", quality: new media.Quality({ bitrate: AUDIO_BITRATE }) })
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

  /**
   * A copy of a finished silent movie with an audio track: its encoded video
   * packets as they are, and the sound `feed` hands over one buffer after
   * another. The silent movie is left for its owner to discard.
   */
  static async withAudio(
    silent: TemporaryVideo,
    seconds: number,
    signal: AbortSignal,
    feed: (add: (buffer: AudioBuffer) => Promise<void>) => Promise<void>,
    maxBytes: number,
  ): Promise<TemporaryVideo> {
    signal.throwIfAborted();
    const media = await import("mediabunny");
    const file = await silent.file();
    const input = new media.Input({ source: new media.BlobSource(file), formats: [media.MP4] });
    let temporary: TemporaryVideo | undefined;
    let output: Output<Mp4OutputFormat, StreamTarget> | undefined;
    let audioDone: Promise<void> | undefined;
    try {
      const track = await abortable(input.getPrimaryVideoTrack(), signal);
      if (!track) throw new Error("The silent movie has no video track");
      const decoderConfig = await abortable(track.getDecoderConfig(), signal);
      if (!decoderConfig) throw new Error("The silent movie has no decoder configuration");
      temporary = await TemporaryVideo.create(file.size + Math.ceil(((seconds * AUDIO_BITRATE) / 8) * 1.25), maxBytes);
      output = new media.Output({
        format: new media.Mp4OutputFormat({ fastStart: false }),
        target: new media.StreamTarget(temporary.stream, { chunked: true, chunkSize: 64 * 1024 }),
      });
      const video = new media.EncodedVideoPacketSource("avc");
      output.addVideoTrack(video, { frameRate: MOVIE_FPS });
      const audio = new media.AudioBufferSource({
        codec: "aac",
        quality: new media.Quality({ bitrate: AUDIO_BITRATE }),
      });
      output.addAudioTrack(audio);
      await abortable(output.start(), signal);
      let audioError: unknown;
      // Both tracks advance together: the muxer interleaves them by time.
      audioDone = feed((buffer) => abortable(audio.add(buffer), signal))
        .then(() => audio.close())
        .catch((error) => {
          audioError = error;
          audio.close();
        });
      let first = true;
      for await (const packet of new media.EncodedPacketSink(track).packets()) {
        signal.throwIfAborted();
        if (audioError !== undefined) throw audioError;
        await abortable(video.add(packet, first ? { decoderConfig } : undefined), signal);
        first = false;
      }
      if (first) throw new Error("The silent movie has no frames");
      video.close();
      await abortable(audioDone, signal);
      if (audioError !== undefined) throw audioError;
      await abortable(output.finalize(), signal);
      temporary.finish();
      return temporary;
    } catch (error) {
      try {
        await output?.cancel();
        await audioDone;
      } finally {
        await temporary?.dispose();
      }
      throw error;
    } finally {
      input.dispose();
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
