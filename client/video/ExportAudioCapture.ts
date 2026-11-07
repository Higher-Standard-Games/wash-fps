import type {
  LoopSfxPlayOptions,
  SfxLoop,
  SfxPlayOptions,
  SpatialSfxPlayOptions,
} from "../../../../engine/audio/AudioV2Sfx";
import type { SfxPosition, SfxSink } from "../../../../engine/audio/SfxSink";

// Vector implementations can expose coordinates through prototype accessors.
function copyPosition({ x, y, z }: SfxPosition): SfxPosition {
  if (![x, y, z].every(Number.isFinite)) throw new Error("Invalid offline sound position");
  return { x, y, z };
}

export interface ExportSoundCue {
  path: string;
  start: number;
  end: number | null;
  scope: number;
  rate: number;
  loop: boolean;
  options: LoopSfxPlayOptions;
  positions: Array<{ time: number; position: SfxPosition }>;
}

export interface ExportListenerFrame {
  time: number;
  rate: number;
  scope: number;
  position: SfxPosition;
  forward: SfxPosition;
  up: SfxPosition;
}

export interface ExportAudioPlan {
  cues: ExportSoundCue[];
  listeners: ExportListenerFrame[];
  scopeStarts: Map<number, number>;
  scopeEnds: Map<number, number>;
  duration: number;
}

/** Collects trigger times synchronously; decode completion never decides a cue's timestamp. */
export class ExportAudioCapture implements SfxSink {
  private time = 0;
  private rate = 1;
  private scope = -1;
  private recording = false;
  private readonly cues: ExportSoundCue[] = [];
  private readonly listeners: ExportListenerFrame[] = [];
  private readonly scopeStarts = new Map<number, number>([[-1, 0]]);
  private readonly scopeEnds = new Map<number, number>();
  private motionSamples = 0;

  constructor(private readonly prepare: (paths: readonly string[], options?: LoopSfxPlayOptions) => Promise<void>) {}

  get nowMs(): number {
    return this.time * 1000;
  }

  begin(): void {
    this.recording = true;
    this.cut(0, 0);
  }

  setTime(seconds: number, rate: number): void {
    if (!Number.isFinite(seconds) || !Number.isFinite(rate) || rate <= 0)
      throw new Error("Invalid offline sound clock");
    this.time = seconds;
    this.rate = rate;
  }

  cut(seconds: number, scope: number): void {
    if (this.scope >= 0 && this.scope !== scope) this.scopeEnds.set(this.scope, seconds);
    this.scope = scope;
    this.scopeStarts.set(scope, seconds);
  }

  preload(paths: readonly string[], options?: LoopSfxPlayOptions): Promise<void> {
    return this.prepare(paths, options);
  }

  play2D(path: string, options: SfxPlayOptions): void {
    if (this.recording) this.add(path, null, options, false);
  }

  play3D(path: string, position: SfxPosition, options: SpatialSfxPlayOptions): void {
    if (this.recording) this.add(path, position, options, false);
  }

  async playLoop3D(
    path: string,
    position: SfxPosition | null,
    options: LoopSfxPlayOptions,
    signal?: AbortSignal,
  ): Promise<SfxLoop | null> {
    if (signal?.aborted) return null;
    const cue = this.add(path, position, options, true);
    return {
      stop: () => {
        if (cue.end === null) cue.end = this.time;
      },
      setPosition: (next) => {
        if (cue.end !== null || !position) return;
        if (++this.motionSamples > 250_000) throw new Error("The reel exceeds the sound-motion budget");
        cue.positions.push({ time: this.time, position: copyPosition(next) });
      },
    };
  }

  sampleListener(frame: Omit<ExportListenerFrame, "time" | "rate" | "scope">): void {
    if (!this.recording) return;
    if (this.listeners.length >= 14_400) throw new Error("The reel exceeds the audio timeline budget");
    this.listeners.push({
      time: this.time,
      rate: this.rate,
      scope: this.scope,
      position: copyPosition(frame.position),
      forward: copyPosition(frame.forward),
      up: copyPosition(frame.up),
    });
  }

  snapshot(duration: number): ExportAudioPlan {
    this.scopeEnds.set(this.scope, duration);
    return structuredClone({
      cues: this.cues,
      listeners: this.listeners,
      scopeStarts: this.scopeStarts,
      scopeEnds: this.scopeEnds,
      duration,
    });
  }

  checkpoint(): () => void {
    const count = this.cues.length,
      motions = this.motionSamples;
    const states = this.cues.map((cue) => ({ cue, end: cue.end, positions: cue.positions.length }));
    return () => {
      this.cues.length = count;
      this.motionSamples = motions;
      for (const state of states) {
        state.cue.end = state.end;
        state.cue.positions.length = state.positions;
      }
    };
  }

  private add(path: string, position: SfxPosition | null, options: LoopSfxPlayOptions, loop: boolean): ExportSoundCue {
    if (this.cues.length >= 20_000) throw new Error("The reel exceeds the sound-cue budget");
    const cue: ExportSoundCue = {
      path,
      start: this.time,
      end: null,
      scope: this.scope,
      rate: this.rate,
      loop,
      options: structuredClone(options),
      positions: position ? [{ time: this.time, position: copyPosition(position) }] : [],
    };
    this.cues.push(cue);
    return cue;
  }
}
