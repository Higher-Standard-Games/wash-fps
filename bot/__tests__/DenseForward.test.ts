/**
 * The plain forward pass has to be the network, not an approximation of it.
 *
 * TF-13 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { resolveDifficulty } from "../BotConfig";
import { extractDenseStack, forward } from "../DenseForward";
import { HybridBrain } from "../HybridBrain";
import { COMBAT_MODEL_INPUT, TACTICAL_MODEL_INPUT } from "../ModelInputs";
import { getTF, initTF, isTFAvailable } from "../TFBackend";

/** Deterministic inputs in [0,1], like the real features. */
function inputs(width: number, rows: number): number[][] {
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  return Array.from({ length: rows }, () => Array.from({ length: width }, () => next()));
}

// biome-ignore lint/suspicious/noExplicitAny: a tf.LayersModel
function predictRows(model: any, rows: number[][]): number[][] {
  const tf = getTF();
  return tf.tidy(() => model.predict(tf.tensor2d(rows)).arraySync() as number[][]);
}

beforeAll(async () => {
  await initTF();
});

describe("forward", () => {
  it("answers exactly what predict answers, for both heads", async () => {
    if (!isTFAvailable()) return;
    const brain = new HybridBrain(resolveDifficulty("medium"));
    await brain.createFreshModels();

    for (const [model, width] of [
      [brain.tacticalModel, TACTICAL_MODEL_INPUT],
      [brain.combatModel, COMBAT_MODEL_INPUT],
    ] as const) {
      const layers = extractDenseStack(model);
      expect(layers).not.toBeNull();
      const rows = inputs(width, 32);
      const expected = predictRows(model, rows);
      rows.forEach((row, index) => {
        const got = Array.from(forward(layers ?? [], row));
        got.forEach((value, column) => {
          expect(value).toBeCloseTo(expected[index][column], 5);
        });
      });
    }
    brain.dispose();
  });

  it("keeps answering what predict answers after the weights are trained", async () => {
    if (!isTFAvailable()) return;
    const tf = getTF();
    const brain = new HybridBrain(resolveDifficulty("medium"));
    await brain.createFreshModels();
    // biome-ignore lint/suspicious/noExplicitAny: reaching the private inference path is the point
    const runTactical = (row: number[]): Float32Array => (brain as any)._runTactical(row);

    const probe = inputs(TACTICAL_MODEL_INPUT, 1)[0];
    const before = Array.from(runTactical(probe));

    // Training through the public getter, the way both trainers do it
    const x = tf.tensor2d(inputs(TACTICAL_MODEL_INPUT, 64));
    const y = tf.ones([64, 5]);
    await brain.tacticalModel?.fit(x, y, { epochs: 20, verbose: 0 });
    x.dispose();
    y.dispose();

    const after = Array.from(runTactical(probe));
    const expected = predictRows(brain.tacticalModel, [probe])[0];
    // The decision path moved with the weights instead of answering from a stale copy
    expect(after).not.toEqual(before);
    after.forEach((value, column) => {
      expect(value).toBeCloseTo(expected[column], 5);
    });
    brain.dispose();
  });

  it("declines a network it does not know how to run", async () => {
    if (!isTFAvailable()) return;
    const tf = getTF();
    const unusual = tf.sequential({
      layers: [tf.layers.dense({ inputShape: [4], units: 3, activation: "tanh" })],
    });
    // Slower through TensorFlow is fine; a wrong answer from here is not
    expect(extractDenseStack(unusual)).toBeNull();
    unusual.dispose();
  });
});
