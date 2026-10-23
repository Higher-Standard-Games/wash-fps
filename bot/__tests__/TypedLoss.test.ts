/**
 * The typed loss, checked against the arithmetic it claims to do.
 *
 * TF-12 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { getTF, initTF, isTFAvailable } from "../TFBackend";
import { TURN_HUBER_DELTA, typedLoss } from "../TypedLoss";

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
const bce = (label: number, logit: number): number =>
  -(label * Math.log(sigmoid(logit)) + (1 - label) * Math.log(1 - sigmoid(logit)));
const huber = (label: number, prediction: number): number => {
  const miss = Math.abs(label - prediction);
  return miss <= TURN_HUBER_DELTA ? 0.5 * miss * miss : TURN_HUBER_DELTA * (miss - 0.5 * TURN_HUBER_DELTA);
};

beforeAll(async () => {
  await initTF();
});

describe("typedLoss", () => {
  it("is cross-entropy on the buttons and Huber on the turns, one value per frame", () => {
    if (!isTFAvailable()) return;
    const tf = getTF();
    const loss = typedLoss(tf, ["probability", "turn", "probability"]);

    const labels = [
      [1, 0.4, 0],
      [0, -3, 1],
    ];
    const outputs = [
      [2, 0.1, -1],
      [0.5, 1, 0.3],
    ];
    const got = loss(tf.tensor2d(labels), tf.tensor2d(outputs)).arraySync() as number[];

    const expected = labels.map((row, index) => {
      const out = outputs[index];
      return (bce(row[0], out[0]) + huber(row[1], out[1]) + bce(row[2], out[2])) / 3;
    });
    // One value per frame, which TensorFlow averages
    expect(got).toHaveLength(2);
    got.forEach((value, index) => {
      expect(value).toBeCloseTo(expected[index], 5);
    });
  });

  it("does not let one flick outweigh the frame the way squared error would", () => {
    if (!isTFAvailable()) return;
    const tf = getTF();
    const loss = typedLoss(tf, ["turn"]);
    // A miss of ten turn units costs ten times a miss of one, not a hundred
    const [small, flick] = loss(tf.tensor2d([[0], [0]]), tf.tensor2d([[2], [11]])).arraySync() as number[];
    expect(flick / small).toBeLessThan(15);
  });

  it("trains a model through compile and fit", async () => {
    if (!isTFAvailable()) return;
    const tf = getTF();
    const model = tf.sequential({
      layers: [tf.layers.dense({ inputShape: [3], units: 2, activation: "linear" })],
    });
    model.compile({ optimizer: tf.train.adam(0.01), loss: typedLoss(tf, ["probability", "turn"]) });
    const x = tf.tensor2d([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const y = tf.tensor2d([
      [1, 0.5],
      [0, -0.5],
    ]);
    const result = await model.fit(x, y, { epochs: 2, verbose: 0 });
    expect(Number.isFinite((result.history.loss as number[])[1])).toBe(true);
    model.dispose();
  });
});
