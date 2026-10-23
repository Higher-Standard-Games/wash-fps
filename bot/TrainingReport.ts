/**
 * Saying what a training run achieved, per output, against a floor.
 *
 * A single mean-squared loss over a head is nearly uninformative here. The
 * outputs are different questions — three buttons, a yes/no switch, a slot — and
 * most of them are zero most of the time, so a network that answers "no" to
 * everything scores well and has learned nothing. The floor makes that visible:
 * for each output it is the error of the best answer that ignores the input
 * entirely. An output whose error is not below its floor was not learned.
 *
 * Error is squared, because squared error is what both heads are trained on, and
 * what it teaches a sigmoid output to be is a probability: for a button pressed
 * one frame in thirty, the honest answer is "about a thirtieth", not "never".
 * The best fixed answer under squared error is the column's mean, so the floor
 * is its variance. A lazy "never" still loses to it — its error is the pressed
 * share p, the floor p(1 − p) — while a network that has learned *when* the
 * button is pressed beats it. An earlier version scored absolute error against
 * the median, which rewards hard yes-or-no answers and would have called a
 * well-calibrated network useless.
 *
 * TF-6 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import type { LayersModel, Tensor } from "@tensorflow/tfjs-node";
import { type OutputKind, toLabelSpace } from "./CloningTargets";
import type { TFModule } from "./TFBackend";

export interface OutputScore {
  name: string;
  /** Mean squared error of the network on held-out frames. */
  error: number;
  /** Mean squared error of the best fixed answer — the column's mean — which is its variance. */
  floor: number;
  /** What share of frames this output was on for, as a sanity check. */
  positiveRate: number;
}

/**
 * Score every output column of a head.
 *
 * `predictions` and `targets` are frames × outputs, in the same order. Rows that
 * do not line up are a caller error rather than something to paper over, so a
 * mismatch throws: a report that silently scores the wrong pairs is worse than
 * no report.
 */
export function scoreOutputs(
  names: readonly string[],
  predictions: readonly number[][],
  targets: readonly number[][],
): OutputScore[] {
  if (predictions.length !== targets.length) {
    throw new Error(`scoreOutputs: ${predictions.length} predictions for ${targets.length} targets`);
  }
  if (targets.length === 0) return [];

  const width = names.length;
  const frames = targets.length;
  const scores: OutputScore[] = [];

  for (let column = 0; column < width; column++) {
    let sum = 0;
    let error = 0;
    let positives = 0;
    for (let row = 0; row < frames; row++) {
      const target = targets[row][column] ?? 0;
      sum += target;
      const miss = (predictions[row][column] ?? 0) - target;
      error += miss * miss;
      if (target > 0.5) positives++;
    }

    const mean = sum / frames;
    let floor = 0;
    for (let row = 0; row < frames; row++) {
      const miss = mean - (targets[row][column] ?? 0);
      floor += miss * miss;
    }

    scores.push({
      name: names[column],
      error: error / frames,
      floor: floor / frames,
      positiveRate: positives / frames,
    });
  }

  return scores;
}

/**
 * The least skill that counts as learned.
 *
 * A held-out match is a sample, and an output a hair under its floor — a tenth of
 * a percent of the error removed — is within the noise of a fixed answer; acting
 * on it would be acting on luck. The first typed-head run scored aim at exactly
 * that, and a bot would have trusted it. Five percent credits a real, modest
 * improvement, and the report and the bot use the same line, so what the report
 * calls learned is what a bot acts on.
 */
export const LEARNED_SKILL = 0.05;

/**
 * How much of the floor an output's error removed: 1 − error / floor.
 *
 * Above zero is learned — at 0.4 the network removed four tenths of the error a
 * fixed answer would have made — and zero or below means a fixed answer would
 * have done as well. An output that never varied has no floor to beat and scores
 * zero. This is what a bot reads to decide how far to trust each output.
 */
export function skillOf(score: OutputScore): number {
  return score.floor > 0 ? 1 - score.error / score.floor : 0;
}

/** Skill by output name, for the metadata beside the weights. */
export function skillByName(scores: readonly OutputScore[]): Record<string, number> {
  return Object.fromEntries(scores.map((score) => [score.name, Number(skillOf(score).toFixed(4))]));
}

/**
 * Score a model on pairs it did not train on.
 *
 * Raw outputs are logits and turn units; they are put into the space the labels
 * live in — probabilities through a sigmoid — before they are compared, or a
 * logit of 3 would be scored as a miss against a label of 1. `tf` is passed in so
 * this module loads without TensorFlow.
 */
export function scoreModel(
  tf: TFModule,
  model: LayersModel | null,
  pairs: readonly { input: number[]; target: number[] }[],
  names: readonly string[],
  kinds: readonly OutputKind[],
): OutputScore[] {
  if (!model || pairs.length === 0) return [];
  const raw = tf.tidy(() =>
    (model.predict(tf.tensor2d(pairs.map((pair) => pair.input))) as Tensor).arraySync(),
  ) as number[][];
  return scoreOutputs(
    names,
    raw.map((row) => toLabelSpace(row, kinds)),
    pairs.map((pair) => pair.target),
  );
}

/** One line per output: what it scored, and whether that beat ignoring the input. */
export function formatScores(label: string, scores: readonly OutputScore[]): string[] {
  if (scores.length === 0) return [`[Trainer] ${label}: nothing held out to score against`];
  return [
    `[Trainer] ${label} per output (error / floor, lower is better; floor = best fixed answer):`,
    ...scores.map((score) => {
      const skill = skillOf(score);
      const verdict =
        skill >= LEARNED_SKILL
          ? "learned"
          : skill > 0
            ? "within the noise of a fixed answer"
            : "no better than a fixed answer";
      return (
        `[Trainer]   ${score.name.padEnd(10)} ${score.error.toFixed(4)} / ${score.floor.toFixed(4)}` +
        `  on in ${(score.positiveRate * 100).toFixed(1)}% of frames — ${verdict}`
      );
    }),
  ];
}
