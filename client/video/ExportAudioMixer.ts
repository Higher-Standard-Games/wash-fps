import type { SfxPosition } from "../../../../engine/audio/SfxSink";
import type { PreparedExportSound } from "./ExportAudioBuffers";
import type { ExportAudioPlan, ExportSoundCue } from "./ExportAudioCapture";
import { ExportAudioTimeline } from "./ExportAudioTimeline";
import type { PreparedExportMusic } from "./ExportMusic";
import { musicPlaybackWindow } from "./ExportMusicSelection";
import { abortable, MOVIE_FPS } from "./MovieClock";

type PrepareSound = (
  path: string,
  options: import("../../../../engine/audio/AudioV2Sfx").LoopSfxPlayOptions,
) => Promise<PreparedExportSound>;

/** One sound as the mix plays it, in movie seconds, after every voice limit. */
interface PlannedVoice {
  cue: ExportSoundCue;
  sound: PreparedExportSound;
  start: number;
  end: number;
  /** Buffer position at `start`. */
  offset: number;
  pitch: number;
  volume: number;
  /** A shot-local tail fades out to here. */
  fadeAt: number | null;
  spatial: boolean;
  key: string;
  slot?: string;
}

interface MixPlan {
  timeline: ExportAudioTimeline;
  voices: PlannedVoice[];
}

const SAMPLE_RATE = 48000;
const yieldNow = (signal: AbortSignal) => abortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);

/** Which cues sound, when, and from where in their buffers: the voice limits, decided once for the whole movie. */
async function planVoices(
  plan: ExportAudioPlan,
  prepare: PrepareSound,
  signal: AbortSignal,
  withMusic: boolean,
): Promise<MixPlan> {
  signal.throwIfAborted();
  const timeline = new ExportAudioTimeline(plan.listeners, plan.duration);
  const prepared = await abortable(
    Promise.all(
      plan.cues.map(async (cue) => {
        try {
          return { cue, prepared: await prepare(cue.path, cue.loop ? cue.options : {}) };
        } catch (error) {
          throw new Error(`Required sound ${cue.path}: ${String(error)}`);
        }
      }),
    ),
    signal,
  );
  const musicVolume = withMusic ? 0.35 : 1;
  const voices: PlannedVoice[] = [];
  let active: PlannedVoice[] = [];
  const stop = (voice: PlannedVoice, time: number) => {
    voice.end = Math.min(voice.end, time);
  };
  const effectiveStart = (cue: ExportSoundCue) => Math.max(0, plan.scopeStarts.get(cue.scope) ?? 0, cue.start);
  const sorted = prepared.sort((a, b) => effectiveStart(a.cue) - effectiveStart(b.cue) || a.cue.start - b.cue.start);
  for (let index = 0; index < sorted.length; index++) {
    signal.throwIfAborted();
    const { cue, prepared: sound } = sorted[index];
    const scopeStart = plan.scopeStarts.get(cue.scope) ?? 0;
    const start = Math.max(0, scopeStart, cue.start);
    active = active.filter((voice) => voice.end > start);
    const scopeEnd = cue.loop ? plan.duration : (plan.scopeEnds.get(cue.scope) ?? plan.duration);
    let end = Math.min(plan.duration, scopeEnd, cue.end ?? plan.duration);
    if (start >= end) continue;
    const pitch = Number.isFinite(cue.options.pitch) ? cue.options.pitch! : 0;
    const pitchRate = 2 ** (pitch / 1200);
    let offset = Math.max(0, (start - cue.start) * cue.rate * pitchRate);
    if (cue.loop) {
      if (offset >= sound.buffer.duration)
        offset = sound.loopStart + ((offset - sound.loopStart) % (sound.buffer.duration - sound.loopStart));
    } else {
      if (offset >= sound.buffer.duration) continue;
      end = Math.min(end, timeline.timeAt(timeline.sourceAt(start) + (sound.buffer.duration - offset) / pitchRate));
    }
    if (end <= start) continue;
    const key = `${cue.options.channel ?? "effects"}:${cue.path}`;
    const voice: PlannedVoice = {
      cue,
      sound,
      start,
      end,
      offset,
      pitch,
      volume: Math.max(0, cue.options.volume ?? 1) * musicVolume,
      // Shot-local tails end with a short fade; scheduled loop owners determine their own stops.
      fadeAt: !cue.loop && scopeEnd < plan.duration && end === scopeEnd ? end : null,
      spatial: cue.positions.length > 0,
      key,
      slot: cue.options.slot,
    };
    if (voice.slot) {
      for (const previous of active) if (previous.slot === voice.slot) stop(previous, start);
    }
    if (!voice.spatial && !cue.loop) {
      const sameSound = active.filter((previous) => !previous.spatial && previous.key === key && previous.end > start);
      const limit = Math.max(1, Number.isFinite(cue.options.maxInstances) ? Math.floor(cue.options.maxInstances!) : 8);
      while (sameSound.length >= limit) stop(sameSound.shift()!, start);
    }
    voices.push(voice);
    active.push(voice);
    const spatial = active.filter((previous) => previous.spatial && previous.end > start);
    if (spatial.length > 48) {
      const nearestEnd = spatial.reduce((a, b) => (a.end < b.end ? a : b));
      stop(nearestEnd, start);
    }
    if (index % 100 === 0) await yieldNow(signal);
  }
  return { timeline, voices };
}

/** Where a moving sound is at `time`: its path is ramped between samples, as the panner plays it. */
function positionAt(voice: PlannedVoice, time: number): SfxPosition {
  const samples = voice.cue.positions;
  let position = samples[0].position;
  for (const sample of samples) {
    if (sample.time <= voice.start) position = sample.position;
    else break;
  }
  let at = voice.start;
  for (const sample of samples) {
    if (sample.time <= voice.start || sample.time >= voice.end) continue;
    if (sample.time >= time) {
      const t = sample.time > at ? (time - at) / (sample.time - at) : 1;
      return {
        x: position.x + (sample.position.x - position.x) * t,
        y: position.y + (sample.position.y - position.y) * t,
        z: position.z + (sample.position.z - position.z) * t,
      };
    }
    position = sample.position;
    at = sample.time;
  }
  return position;
}

/** Render the movie's sound from `from` to `to` seconds; the whole movie is one window. */
async function renderWindow(
  plan: ExportAudioPlan,
  mix: MixPlan,
  from: number,
  to: number,
  signal: AbortSignal,
  music?: PreparedExportMusic,
): Promise<AudioBuffer> {
  const { timeline, voices } = mix;
  const context = new OfflineAudioContext(2, Math.round((to - from) * SAMPLE_RATE), SAMPLE_RATE);
  const nodes: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];
  const cancelled = () => {
    for (const source of sources) {
      try {
        source.stop(0);
      } catch {}
    }
  };
  signal.addEventListener("abort", cancelled, { once: true });
  try {
    if (music) {
      if (from !== 0 || to !== plan.duration) throw new Error("Music is mixed in one piece");
      const window = musicPlaybackWindow(music.buffer.duration, music.startSeconds, plan.duration);
      const source = context.createBufferSource();
      source.buffer = music.buffer;
      const bed = context.createGain();
      const volume = 0.8;
      bed.gain.setValueAtTime(0, 0);
      bed.gain.linearRampToValueAtTime(volume, window.fadeIn);
      bed.gain.setValueAtTime(volume, window.duration - window.fadeOut);
      bed.gain.linearRampToValueAtTime(0, window.duration);
      source.connect(bed);
      bed.connect(context.destination);
      source.start(0, window.offset);
      source.stop(window.duration);
      nodes.push(source, bed);
      sources.push(source);
    }
    const listener = context.listener;
    if (!listener.positionX || !listener.forwardX) throw new Error("Offline spatial audio automation is unsupported");
    const params = [
      listener.positionX,
      listener.positionY,
      listener.positionZ,
      listener.forwardX,
      listener.forwardY,
      listener.forwardZ,
      listener.upX,
      listener.upY,
      listener.upZ,
    ] as const;
    const values = (frame: (typeof plan.listeners)[number]) => [
      frame.position.x,
      frame.position.y,
      frame.position.z,
      frame.forward.x,
      frame.forward.y,
      frame.forward.z,
      frame.up.x,
      frame.up.y,
      frame.up.z,
    ];
    let first = Math.max(0, Math.floor(from * MOVIE_FPS) - 1);
    while (first < plan.listeners.length && plan.listeners[first].time < from) first++;
    if (from > 0 && first > 0) {
      // The window opens partway along the listener's ramp
      const previous = plan.listeners[first - 1];
      const next = plan.listeners[first];
      const before = values(previous);
      const after = next && next.scope === previous.scope ? values(next) : before;
      const t = next && next.time > previous.time ? (from - previous.time) / (next.time - previous.time) : 0;
      params.forEach((parameter, k) => {
        parameter.setValueAtTime(before[k] + (after[k] - before[k]) * t, 0);
      });
    }
    for (let i = first; i < plan.listeners.length; i++) {
      const frame = plan.listeners[i];
      const smooth = i > 0 && frame.scope === plan.listeners[i - 1].scope;
      const frameValues = values(frame);
      params.forEach((parameter, k) => {
        if (smooth) parameter.linearRampToValueAtTime(frameValues[k], frame.time - from);
        else parameter.setValueAtTime(frameValues[k], frame.time - from);
      });
      if (frame.time > to) break;
    }
    for (let index = 0; index < voices.length; index++) {
      signal.throwIfAborted();
      const voice = voices[index];
      if (voice.end <= from || voice.start >= to) continue;
      const { cue, sound } = voice;
      const begin = Math.max(voice.start, from);
      const pitchRate = 2 ** (voice.pitch / 1200);
      let offset =
        begin === voice.start
          ? voice.offset
          : voice.offset + (timeline.sourceAt(begin) - timeline.sourceAt(voice.start)) * pitchRate;
      if (cue.loop) {
        if (offset >= sound.buffer.duration)
          offset = sound.loopStart + ((offset - sound.loopStart) % (sound.buffer.duration - sound.loopStart));
      } else if (offset >= sound.buffer.duration) continue;
      const source = context.createBufferSource();
      source.buffer = sound.buffer;
      source.loop = cue.loop;
      source.loopStart = sound.loopStart;
      source.loopEnd = sound.buffer.duration;
      source.detune.value = voice.pitch;
      let rate = timeline.rateAt(begin);
      source.playbackRate.setValueAtTime(rate, begin - from);
      for (let i = Math.max(0, Math.floor(begin * MOVIE_FPS)); i < plan.listeners.length; i++) {
        const frame = plan.listeners[i];
        if (frame.time >= voice.end || frame.time > to) break;
        if (frame.time > begin && frame.rate !== rate) {
          rate = frame.rate;
          source.playbackRate.setValueAtTime(rate, frame.time - from);
        }
      }
      const gain = context.createGain();
      if (voice.fadeAt === null) gain.gain.setValueAtTime(voice.volume, begin - from);
      else {
        const fadeFrom = Math.max(voice.start, voice.fadeAt - 0.01);
        if (fadeFrom >= begin) {
          gain.gain.setValueAtTime(voice.volume, begin - from);
          gain.gain.setValueAtTime(voice.volume, fadeFrom - from);
        } else {
          const left = (voice.fadeAt - begin) / (voice.fadeAt - fadeFrom);
          gain.gain.setValueAtTime(voice.volume * left, begin - from);
        }
        gain.gain.linearRampToValueAtTime(0, voice.fadeAt - from);
      }
      let upstream: AudioNode = source;
      if (voice.spatial) {
        const panner = context.createPanner();
        panner.panningModel = "equalpower";
        panner.distanceModel = "inverse";
        panner.refDistance = 125;
        panner.maxDistance = 8000;
        panner.rolloffFactor = Math.max(0, cue.options.attenuation ?? 1);
        const initial = positionAt(voice, begin);
        panner.positionX.setValueAtTime(initial.x, begin - from);
        panner.positionY.setValueAtTime(initial.y, begin - from);
        panner.positionZ.setValueAtTime(initial.z, begin - from);
        for (const sample of cue.positions) {
          if (sample.time <= begin || sample.time >= voice.end) continue;
          panner.positionX.linearRampToValueAtTime(sample.position.x, sample.time - from);
          panner.positionY.linearRampToValueAtTime(sample.position.y, sample.time - from);
          panner.positionZ.linearRampToValueAtTime(sample.position.z, sample.time - from);
          if (sample.time >= to) break;
        }
        source.connect(panner);
        upstream = panner;
        nodes.push(panner);
      }
      upstream.connect(gain);
      gain.connect(context.destination);
      nodes.push(source, gain);
      sources.push(source);
      source.start(begin - from, offset);
      source.stop(voice.end - from);
      if (index % 100 === 0) await yieldNow(signal);
    }
    return await abortable(context.startRendering(), signal);
  } finally {
    signal.removeEventListener("abort", cancelled);
    for (const node of nodes) node.disconnect();
  }
}

function peakOf(buffer: AudioBuffer): number {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    for (const value of buffer.getChannelData(channel)) {
      if (!Number.isFinite(value)) throw new Error("The offline audio mix contains invalid samples");
      peak = Math.max(peak, Math.abs(value));
    }
  }
  return peak;
}

function scale(buffer: AudioBuffer, gain: number): void {
  if (gain >= 1) return;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  }
}

const headroom = (peak: number) => (peak > 0.98 ? 0.98 / peak : 1);

/** Native offline graph provides timestamped source/listener automation without speaker output. */
export async function mixExportAudio(
  plan: ExportAudioPlan,
  prepare: PrepareSound,
  signal: AbortSignal,
  music?: PreparedExportMusic,
): Promise<{ buffer: AudioBuffer; peak: number; gain: number; voices: number }> {
  const mix = await planVoices(plan, prepare, signal, !!music);
  const buffer = await renderWindow(plan, mix, 0, plan.duration, signal, music);
  const peak = peakOf(buffer);
  const gain = headroom(peak);
  scale(buffer, gain);
  return { buffer, peak, gain, voices: mix.voices.length + (music ? 1 : 0) };
}

/**
 * A long movie's mix, handed to `add` in windows of `windowSeconds`, so only
 * one window is ever in memory. It is rendered twice: once to find the whole
 * mix's peak, once to hand over at the level that peak allows.
 */
export async function streamExportAudio(
  plan: ExportAudioPlan,
  prepare: PrepareSound,
  signal: AbortSignal,
  add: (buffer: AudioBuffer) => Promise<void>,
  progress?: (done: number, total: number) => void,
  windowSeconds = 30,
): Promise<{ peak: number; gain: number; voices: number }> {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) throw new Error("Invalid audio window");
  const mix = await planVoices(plan, prepare, signal, false);
  const windows: Array<[number, number]> = [];
  for (let from = 0; from < plan.duration; from += windowSeconds)
    windows.push([from, Math.min(plan.duration, from + windowSeconds)]);
  // Window edges fall on whole samples, so the windows join without a gap
  const edges = windows.map(([from, to]) => [Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE)]);
  let peak = 0;
  for (let i = 0; i < windows.length; i++) {
    const [from, to] = edges[i];
    peak = Math.max(peak, peakOf(await renderWindow(plan, mix, from / SAMPLE_RATE, to / SAMPLE_RATE, signal)));
    progress?.(i + 1, windows.length * 2);
  }
  const gain = headroom(peak);
  for (let i = 0; i < windows.length; i++) {
    const [from, to] = edges[i];
    const buffer = await renderWindow(plan, mix, from / SAMPLE_RATE, to / SAMPLE_RATE, signal);
    scale(buffer, gain);
    await add(buffer);
    progress?.(windows.length + i + 1, windows.length * 2);
  }
  return { peak, gain, voices: mix.voices.length };
}
