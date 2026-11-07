import { AudioManager } from "../../../../engine/AudioManager";
import type { LoopSfxPlayOptions } from "../../../../engine/audio/AudioV2Sfx";
import { overlapLoopChannel, prependLoopIntro } from "../../../../engine/audio/LoopOverlap";
import { abortable } from "./MovieClock";

export interface PreparedExportSound {
  buffer: AudioBuffer;
  loopStart: number;
}

/** Per-job decoded PCM, with a separate cache for prepared loop windows/intros. */
export class ExportAudioBuffers {
  private readonly decoder = new OfflineAudioContext(2, 1, 48000);
  private readonly raw = new Map<string, Promise<AudioBuffer>>();
  private readonly prepared = new Map<string, Promise<PreparedExportSound>>();
  private retainedBytes = 0;
  private disposed = false;

  constructor(private readonly signal: AbortSignal) {}

  async preload(paths: readonly string[], options: LoopSfxPlayOptions = {}): Promise<void> {
    // The catalogue may include unused optional variants. Used cues are required below.
    await Promise.all(
      paths.map((path) =>
        this.get(path, options).then(
          () => {},
          () => {},
        ),
      ),
    );
  }

  get(path: string, options: LoopSfxPlayOptions = {}): Promise<PreparedExportSound> {
    const key = JSON.stringify([path, options.loopRegion, options.overlapSeconds, options.intro]);
    let prepared = this.prepared.get(key);
    if (!prepared) {
      prepared = this.prepare(path, options);
      this.prepared.set(key, prepared);
    }
    return prepared;
  }

  private decode(path: string): Promise<AudioBuffer> {
    let work = this.raw.get(path);
    if (!work) {
      work = (async () => {
        const bytes = await abortable(AudioManager.getInstance().readSfxBytes(path), this.signal);
        const buffer = await abortable(this.decoder.decodeAudioData(bytes.slice(0)), this.signal);
        this.retain(buffer);
        return buffer;
      })();
      this.raw.set(path, work);
    }
    return work;
  }

  private retain(buffer: AudioBuffer): void {
    if (this.disposed) throw new Error("Audio preparation was disposed");
    this.retainedBytes += buffer.length * buffer.numberOfChannels * 4;
    if (this.retainedBytes > 64 * 1024 * 1024) throw new Error("The reel exceeds the decoded-sound memory budget");
  }

  private async prepare(path: string, options: LoopSfxPlayOptions): Promise<PreparedExportSound> {
    const raw = await this.decode(path);
    const region = options.loopRegion;
    const overlap = options.overlapSeconds ?? 0;
    if (!region && !overlap && !options.intro) return { buffer: raw, loopStart: 0 };
    const start = region ? Math.max(0, Math.round(region.startSeconds * raw.sampleRate)) : 0;
    const end = region ? Math.min(raw.length, Math.round(region.endSeconds * raw.sampleRate)) : raw.length;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
      throw new Error(`Invalid loop window: ${path}`);
    let channels = Array.from({ length: raw.numberOfChannels }, (_, channel) =>
      overlapLoopChannel(raw.getChannelData(channel).subarray(start, end), Math.round(overlap * raw.sampleRate)),
    );
    const loopFrames = channels[0].length;
    if (options.intro) {
      const attack = await this.decode(options.intro.path);
      if (attack.numberOfChannels !== raw.numberOfChannels) throw new Error(`Loop/intro channel mismatch: ${path}`);
      channels = channels.map((channel, index) =>
        prependLoopIntro(
          attack.getChannelData(index),
          channel,
          options.intro!.holdSeconds * raw.sampleRate,
          options.intro!.fadeSeconds * raw.sampleRate,
        ),
      );
    }
    const buffer = this.decoder.createBuffer(channels.length, channels[0].length, raw.sampleRate);
    channels.forEach((samples, index) => {
      buffer.copyToChannel(samples, index);
    });
    this.retain(buffer);
    return { buffer, loopStart: (channels[0].length - loopFrames) / raw.sampleRate };
  }

  dispose(): void {
    this.disposed = true;
    this.raw.clear();
    this.prepared.clear();
  }
}
