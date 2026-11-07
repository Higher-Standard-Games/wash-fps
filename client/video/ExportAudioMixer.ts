import type { PreparedExportSound } from "./ExportAudioBuffers";
import type { ExportAudioPlan } from "./ExportAudioCapture";
import { ExportAudioTimeline } from "./ExportAudioTimeline";
import type { PreparedExportMusic } from "./ExportMusic";
import { musicPlaybackWindow } from "./ExportMusicSelection";
import { abortable, MOVIE_FPS } from "./MovieClock";

interface ScheduledVoice {
  source: AudioBufferSourceNode;
  end: number;
  spatial: boolean;
  key: string;
  slot?: string;
}

/** Native offline graph provides timestamped source/listener automation without speaker output. */
export async function mixExportAudio(
  plan: ExportAudioPlan,
  prepare: (
    path: string,
    options: import("../../../../engine/audio/AudioV2Sfx").LoopSfxPlayOptions,
  ) => Promise<PreparedExportSound>,
  signal: AbortSignal,
  music?: PreparedExportMusic,
): Promise<{ buffer: AudioBuffer; peak: number; gain: number; voices: number }> {
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
  const context = new OfflineAudioContext(2, Math.round(plan.duration * 48000), 48000);
  const nodes: AudioNode[] = [];
  const voices: ScheduledVoice[] = [];
  let active: ScheduledVoice[] = [];
  const stop = (voice: ScheduledVoice, time: number) => {
    voice.end = Math.min(voice.end, time);
    voice.source.stop(voice.end);
  };
  const cancelled = () => {
    for (const voice of voices) {
      try {
        voice.source.stop(0);
      } catch {}
    }
  };
  signal.addEventListener("abort", cancelled, { once: true });
  try {
    if (music) {
      const window = musicPlaybackWindow(music.buffer.duration, music.startSeconds, plan.duration);
      const source = context.createBufferSource();
      source.buffer = music.buffer;
      const bed = context.createGain();
      const volume = 0.22;
      bed.gain.setValueAtTime(0, 0);
      bed.gain.linearRampToValueAtTime(volume, window.fadeIn);
      bed.gain.setValueAtTime(volume, window.duration - window.fadeOut);
      bed.gain.linearRampToValueAtTime(0, window.duration);
      source.connect(bed);
      bed.connect(context.destination);
      source.start(0, window.offset);
      source.stop(window.duration);
      nodes.push(source, bed);
      voices.push({ source, end: window.duration, spatial: false, key: "music" });
    }
    const listener = context.listener;
    if (!listener.positionX || !listener.forwardX) throw new Error("Offline spatial audio automation is unsupported");
    for (let i = 0; i < plan.listeners.length; i++) {
      const frame = plan.listeners[i];
      const smooth = i > 0 && frame.scope === plan.listeners[i - 1].scope;
      for (const [parameter, value] of [
        [listener.positionX, frame.position.x],
        [listener.positionY, frame.position.y],
        [listener.positionZ, frame.position.z],
        [listener.forwardX, frame.forward.x],
        [listener.forwardY, frame.forward.y],
        [listener.forwardZ, frame.forward.z],
        [listener.upX, frame.up.x],
        [listener.upY, frame.up.y],
        [listener.upZ, frame.up.z],
      ] as const) {
        if (smooth) parameter.linearRampToValueAtTime(value, frame.time);
        else parameter.setValueAtTime(value, frame.time);
      }
    }
    const effectiveStart = (cue: (typeof plan.cues)[number]) =>
      Math.max(0, plan.scopeStarts.get(cue.scope) ?? 0, cue.start);
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
      const source = context.createBufferSource();
      source.buffer = sound.buffer;
      source.loop = cue.loop;
      source.loopStart = sound.loopStart;
      source.loopEnd = sound.buffer.duration;
      source.detune.value = pitch;
      source.playbackRate.setValueAtTime(timeline.rateAt(start), start);
      for (let i = Math.max(0, Math.floor(start * MOVIE_FPS)); i < plan.listeners.length; i++) {
        const frame = plan.listeners[i];
        if (frame.time >= end) break;
        if (frame.time > start) source.playbackRate.setValueAtTime(frame.rate, frame.time);
      }
      const gain = context.createGain();
      const volume = Math.max(0, cue.options.volume ?? 1);
      gain.gain.setValueAtTime(volume, start);
      // Shot-local tails end with a short fade; scheduled loop owners determine their own stops.
      if (!cue.loop && scopeEnd < plan.duration && end === scopeEnd) {
        gain.gain.setValueAtTime(volume, Math.max(start, end - 0.01));
        gain.gain.linearRampToValueAtTime(0, end);
      }
      let upstream: AudioNode = source;
      if (cue.positions.length) {
        const panner = context.createPanner();
        panner.panningModel = "equalpower";
        panner.distanceModel = "inverse";
        panner.refDistance = 125;
        panner.maxDistance = 8000;
        panner.rolloffFactor = Math.max(0, cue.options.attenuation ?? 1);
        let initial = cue.positions[0].position;
        for (const sample of cue.positions) {
          if (sample.time <= start) initial = sample.position;
          else break;
        }
        panner.positionX.setValueAtTime(initial.x, start);
        panner.positionY.setValueAtTime(initial.y, start);
        panner.positionZ.setValueAtTime(initial.z, start);
        for (const sample of cue.positions) {
          if (sample.time <= start || sample.time >= end) continue;
          panner.positionX.linearRampToValueAtTime(sample.position.x, sample.time);
          panner.positionY.linearRampToValueAtTime(sample.position.y, sample.time);
          panner.positionZ.linearRampToValueAtTime(sample.position.z, sample.time);
        }
        source.connect(panner);
        upstream = panner;
        nodes.push(panner);
      }
      upstream.connect(gain);
      gain.connect(context.destination);
      nodes.push(source, gain);
      const key = `${cue.options.channel ?? "effects"}:${cue.path}`;
      const voice: ScheduledVoice = { source, end, spatial: cue.positions.length > 0, key, slot: cue.options.slot };
      if (voice.slot) {
        for (const previous of active) if (previous.slot === voice.slot) stop(previous, start);
      }
      if (!voice.spatial && !cue.loop) {
        const sameSound = active.filter(
          (previous) => !previous.spatial && previous.key === key && previous.end > start,
        );
        const limit = Math.max(
          1,
          Number.isFinite(cue.options.maxInstances) ? Math.floor(cue.options.maxInstances!) : 8,
        );
        while (sameSound.length >= limit) stop(sameSound.shift()!, start);
      }
      source.start(start, offset);
      source.stop(end);
      voices.push(voice);
      active.push(voice);
      const spatial = active.filter((previous) => previous.spatial && previous.end > start);
      if (spatial.length > 48) {
        const nearestEnd = spatial.reduce((a, b) => (a.end < b.end ? a : b));
        stop(nearestEnd, start);
      }
      if (index % 100 === 0) await abortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
    }
    const buffer = await abortable(context.startRendering(), signal);
    let peak = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      for (const value of buffer.getChannelData(channel)) {
        if (!Number.isFinite(value)) throw new Error("The offline audio mix contains invalid samples");
        peak = Math.max(peak, Math.abs(value));
      }
    }
    const gain = peak > 0.98 ? 0.98 / peak : 1;
    if (gain < 1)
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        for (let i = 0; i < samples.length; i++) samples[i] *= gain;
      }
    return { buffer, peak, gain, voices: voices.length };
  } finally {
    signal.removeEventListener("abort", cancelled);
    for (const node of nodes) node.disconnect();
  }
}
