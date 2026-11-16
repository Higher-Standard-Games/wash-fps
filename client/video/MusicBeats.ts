/**
 * The beats of a song, for putting a highlight reel's cuts on them.
 *
 * An onset curve from the rise in loudness of the whole signal and of its
 * high end, its strongest repeat between 70 and 180 beats a minute as the
 * tempo, then the phase the beat grid lines up best at. Each beat of the grid
 * snaps to the strongest onset close by, so a beat that drifts a little is
 * still hit. A song without a steady beat gives none.
 */

/** The decoded audio this reads: an AudioBuffer has all of it. */
export interface BeatSource {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** About 10 ms of audio per onset step. */
const HOP_SECONDS = 0.01;
const MIN_BPM = 70;
const MAX_BPM = 180;
/** Tempos near this are preferred when two repeat about as well (a half or double time). */
const PREFERRED_BPM = 120;
/** A grid beat snaps to the strongest onset within this. */
const SNAP_SECONDS = 0.04;
/** The tempo's repeat must stand this far above the average one, or the song has no steady beat. */
const MIN_CONFIDENCE = 1.25;

/**
 * Beat times in seconds of the song, from `fromSeconds` for `seconds`.
 * Empty when the song has no steady beat there.
 */
export function detectBeats(source: BeatSource, fromSeconds: number, seconds: number): number[] {
  const rate = source.sampleRate;
  const hop = Math.max(1, Math.round(rate * HOP_SECONDS));
  const first = Math.max(0, Math.floor(fromSeconds * rate));
  const last = Math.min(source.length, Math.ceil((fromSeconds + seconds) * rate));
  const steps = Math.floor((last - first) / hop);
  if (steps < 400) return [];
  const onset = onsetCurve(source, first, hop, steps);

  const tempo = strongestRepeat(onset, 60 / MAX_BPM / HOP_SECONDS, 60 / MIN_BPM / HOP_SECONDS);
  if (!tempo || tempo.confidence < MIN_CONFIDENCE) return [];
  const period = tempo.lag;

  // The phase the grid lines up best at
  let bestPhase = 0;
  let bestScore = -1;
  for (let phase = 0; phase < period; phase += 0.5) {
    let score = 0;
    for (let at = phase; at < onset.length; at += period) score += onset[Math.round(at)] ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }

  const snap = Math.round(SNAP_SECONDS / HOP_SECONDS);
  const beats: number[] = [];
  for (let at = bestPhase; at < onset.length; at += period) {
    const centre = Math.round(at);
    let best = centre;
    for (let i = Math.max(0, centre - snap); i <= Math.min(onset.length - 1, centre + snap); i++) {
      if (onset[i] > onset[best]) best = i;
    }
    beats.push((first + best * hop) / rate);
  }
  return beats;
}

/** How much louder each step is than the one before, overall and in the high end; never below 0. */
function onsetCurve(source: BeatSource, first: number, hop: number, steps: number): Float32Array {
  const channels = Array.from({ length: source.numberOfChannels }, (_, c) => source.getChannelData(c));
  const full = new Float32Array(steps);
  const high = new Float32Array(steps);
  let previous = 0;
  for (let step = 0; step < steps; step++) {
    let sumFull = 0;
    let sumHigh = 0;
    const from = first + step * hop;
    for (let i = from; i < from + hop; i++) {
      let sample = 0;
      for (const data of channels) sample += data[i];
      sample /= channels.length;
      // A first difference is a crude high-pass: hats and snares
      const edge = sample - previous;
      previous = sample;
      sumFull += sample * sample;
      sumHigh += edge * edge;
    }
    full[step] = Math.log(1e-9 + sumFull / hop);
    high[step] = Math.log(1e-9 + sumHigh / hop);
  }
  const onset = new Float32Array(steps);
  for (let step = 1; step < steps; step++) {
    onset[step] = Math.max(0, full[step] - full[step - 1]) + Math.max(0, high[step] - high[step - 1]);
  }
  // Take away the local average, so a loud stretch doesn't count as a beat
  const window = 50;
  let running = 0;
  const smoothed = new Float32Array(steps);
  for (let step = 0; step < steps; step++) {
    running += onset[step];
    if (step >= window) running -= onset[step - window];
    smoothed[step] = Math.max(0, onset[step] - running / Math.min(step + 1, window));
  }
  return smoothed;
}

/** The lag (in steps, to a fraction) the curve repeats at most strongly, weighted toward PREFERRED_BPM. */
function strongestRepeat(
  curve: Float32Array,
  minLag: number,
  maxLag: number,
): { lag: number; confidence: number } | null {
  const lo = Math.max(2, Math.floor(minLag));
  const hi = Math.min(curve.length - 1, Math.ceil(maxLag));
  if (hi <= lo + 2) return null;
  const scores = new Float32Array(hi + 2);
  let total = 0;
  for (let lag = lo - 1; lag <= hi + 1; lag++) {
    let sum = 0;
    for (let i = lag; i < curve.length; i++) sum += curve[i] * curve[i - lag];
    scores[lag] = sum / (curve.length - lag);
  }
  let best = -1;
  let bestWeighted = -1;
  for (let lag = lo; lag <= hi; lag++) {
    total += scores[lag];
    const bpm = 60 / (lag * HOP_SECONDS);
    const octaves = Math.log2(bpm / PREFERRED_BPM);
    const weighted = scores[lag] * Math.exp(-0.5 * (octaves / 0.9) ** 2);
    if (weighted > bestWeighted) {
      bestWeighted = weighted;
      best = lag;
    }
  }
  const mean = total / (hi - lo + 1);
  if (best < 0 || mean <= 0) return null;
  // Between steps: the top of a parabola through the peak and its neighbours
  const a = scores[best - 1];
  const b = scores[best];
  const c = scores[best + 1];
  const bend = a - 2 * b + c;
  const shift = bend < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / bend)) : 0;
  return { lag: best + shift, confidence: b / mean };
}
