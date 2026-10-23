/**
 * Running a trained network without calling into TensorFlow on every decision.
 *
 * Measured, a decision with both heads cost about half a millisecond, and almost
 * none of that was arithmetic: the networks are a few thousand multiply-adds. It
 * was the round trip — build a tensor, call predict, read the answer back
 * synchronously — paid twice a decision by every bot in the process. Batching the
 * fleet into one call would have amortised it, but a bot would then have to wait
 * for the other bots' snapshots before finishing its own decision, and the
 * network's refinement would land after `BotClient` had already applied
 * friendly-fire suppression to that decision: a combat head saying "fire" would
 * skip the check that stops a bot shooting its own team.
 *
 * So the weights are read out once and the forward pass is done here, in the
 * same call as everything else. TensorFlow still trains, saves and loads; it is
 * just not asked to multiply sixteen numbers by seventy-five.
 *
 * Only what the heads actually are is supported — a sequential stack of dense
 * layers with relu, sigmoid or linear activation. Anything else returns null
 * from `extractDenseStack`, and the caller keeps using TensorFlow, so a future
 * change of architecture is slower rather than wrong.
 *
 * TF-13 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import type { LayersModel } from "@tensorflow/tfjs-node";

export type Activation = "relu" | "sigmoid" | "linear";

export interface DenseLayer {
  inSize: number;
  outSize: number;
  /** Row-major [in][out], as TensorFlow stores a dense kernel. */
  kernel: Float64Array;
  bias: Float64Array;
  activation: Activation;
}

const SUPPORTED: ReadonlySet<string> = new Set(["relu", "sigmoid", "linear"]);

/**
 * Copy a model's weights into plain arrays, or null if it is not a stack of
 * dense layers this file knows how to run.
 */
export function extractDenseStack(model: LayersModel | null): DenseLayer[] | null {
  if (model?.getClassName?.() !== "Sequential" || !Array.isArray(model.layers)) return null;
  const layers: DenseLayer[] = [];
  for (const layer of model.layers) {
    if (layer.getClassName?.() !== "Dense") return null;
    const config = layer.getConfig?.() ?? {};
    const activation = String(config.activation ?? "linear");
    if (!SUPPORTED.has(activation)) return null;

    const weights = layer.getWeights();
    const [kernel, bias] = weights;
    if (kernel?.shape.length !== 2) return null;
    const [inSize, outSize] = kernel.shape as [number, number];
    const kernelValues = Float64Array.from(kernel.dataSync() as Float32Array);
    const biasValues =
      config.useBias === false || !bias ? new Float64Array(outSize) : Float64Array.from(bias.dataSync());
    if (biasValues.length !== outSize) return null;

    layers.push({ inSize, outSize, kernel: kernelValues, bias: biasValues, activation: activation as Activation });
  }
  // Each layer must feed the next, or the model is not what it claims to be
  for (let index = 1; index < layers.length; index++) {
    if (layers[index].inSize !== layers[index - 1].outSize) return null;
  }
  return layers.length > 0 ? layers : null;
}

/** The width a stack expects, or 0 if it is empty. */
export function inputWidth(layers: readonly DenseLayer[]): number {
  return layers[0]?.inSize ?? 0;
}

/** One forward pass: what `model.predict` would return for a single input row. */
export function forward(layers: readonly DenseLayer[], input: readonly number[]): Float32Array {
  let values: ArrayLike<number> = input;
  for (const layer of layers) {
    const out = new Float64Array(layer.outSize);
    out.set(layer.bias);
    for (let i = 0; i < layer.inSize; i++) {
      const x = values[i];
      if (x === 0) continue;
      const row = i * layer.outSize;
      for (let j = 0; j < layer.outSize; j++) out[j] += x * layer.kernel[row + j];
    }
    for (let j = 0; j < layer.outSize; j++) out[j] = activate(layer.activation, out[j]);
    values = out;
  }
  return Float32Array.from(values);
}

function activate(activation: Activation, x: number): number {
  switch (activation) {
    case "relu":
      return x > 0 ? x : 0;
    case "sigmoid":
      return 1 / (1 + Math.exp(-x));
    default:
      return x;
  }
}
