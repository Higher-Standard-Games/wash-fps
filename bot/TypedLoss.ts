/**
 * One loss for a head whose outputs are different kinds of answer.
 *
 * A head used to end in a sigmoid on every output and be trained on squared
 * error, which treated "was jump pressed" and "how far did the view turn" as the
 * same kind of number. They are not. A button is a probability: its output is a
 * logit, and binary cross-entropy is the loss that goes with a sigmoid — squared
 * error through a sigmoid all but stops learning once an output is confidently
 * wrong, which for a button pressed one frame in thirty is most of the time. A
 * turn is a signed distance: its output is linear, and Huber loss keeps the odd
 * flick from outweighing a thousand frames of steady tracking.
 *
 * The loss returns one value per sample, as TensorFlow.js expects of a loss it
 * averages itself.
 *
 * TF-12 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import type { Tensor } from "@tensorflow/tfjs-node";
import type { OutputKind } from "./CloningTargets";
import type { TFModule } from "./TFBackend";

/** A turn this far from the label, in turn units, is where Huber stops being quadratic. */
export const TURN_HUBER_DELTA = 1;

/**
 * Build the loss for a head with these output kinds, for `model.compile`.
 *
 * `tf` is passed in rather than imported so this module loads without
 * TensorFlow, like the rest of the training-side code that bots also use.
 */
export function typedLoss(tf: TFModule, kinds: readonly OutputKind[]): (yTrue: Tensor, yPred: Tensor) => Tensor {
  const probabilities = kinds.flatMap((kind, index) => (kind === "probability" ? [index] : []));
  const turns = kinds.flatMap((kind, index) => (kind === "turn" ? [index] : []));

  return (yTrue: Tensor, yPred: Tensor) =>
    tf.tidy(() => {
      const parts: Tensor[] = [];
      if (probabilities.length > 0) {
        parts.push(
          tf.losses.sigmoidCrossEntropy(
            tf.gather(yTrue, probabilities, 1),
            tf.gather(yPred, probabilities, 1),
            undefined,
            0,
            tf.Reduction.NONE,
          ),
        );
      }
      if (turns.length > 0) {
        parts.push(
          tf.losses.huberLoss(
            tf.gather(yTrue, turns, 1),
            tf.gather(yPred, turns, 1),
            undefined,
            TURN_HUBER_DELTA,
            tf.Reduction.NONE,
          ),
        );
      }
      // Every output counts equally, whatever its kind: the mean across columns
      return tf.mean(parts.length === 1 ? parts[0] : tf.concat(parts, 1), 1);
    });
}
