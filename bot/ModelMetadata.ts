/**
 * What a set of trained weights was trained on, written beside them.
 *
 * Weights alone say nothing about the features they expect. Change
 * `BotInputNormalizer` and an old model keeps loading happily while reading
 * garbage, because a dense layer accepts any vector of the right length and a
 * length is all it checks. This records the shapes and the provenance so the
 * mismatch is caught at load instead of showing up as a bot that plays badly
 * for reasons nobody can trace.
 *
 * TF-10 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  COMBAT_TARGET_SIZE as COMBAT_OUTPUT_SIZE,
  TACTICAL_TARGET_SIZE as TACTICAL_OUTPUT_SIZE,
} from "./CloningTargets";
import { COMBAT_MODEL_INPUT, FRAME_STACK, TACTICAL_MODEL_INPUT } from "./ModelInputs";

/**
 * How this build reads a head's outputs: logits for yes-or-no answers, turn
 * units for aim. Recorded beside the weights, and required of them.
 */
export const OUTPUT_ENCODING = "logits-and-turns-1";

export const METADATA_FILE = "metadata.json";

export interface ModelMetadata {
  /**
   * Input widths the weights were trained against — the whole stacked vector,
   * frames times features, since that is what the first layer was built for.
   */
  tacticalInputSize: number;
  combatInputSize: number;
  /** Frames per stacked input. Absent in metadata written before inputs were stacked. */
  frameStack?: number;
  /**
   * How the outputs are to be read. Absent before outputs were typed, when every
   * output went through a sigmoid; such weights are refused, because their
   * outputs are probabilities where this build expects logits and turns.
   */
  outputEncoding?: string;
  /**
   * Held-out skill per output, 1 − error / floor, from matches the weights never
   * trained on. A bot acts on an output only as far as this says it was learned;
   * with none recorded, the network advises nothing.
   */
  outputSkill?: Record<string, number>;
  /**
   * Ticks between the frames of a stack in the recordings trained on. A bot
   * compares it with the spacing of the snapshots it actually receives.
   */
  frameIntervalTicks?: number;
  /**
   * Output widths, which fix what each index means. Absent in metadata written
   * before the heads were reshaped.
   */
  tacticalOutputSize?: number;
  combatOutputSize?: number;
  /** When, and by which engine version. */
  trainedAt: string;
  engineVersion?: string;
  /** What it learned from. */
  matches: number;
  trainFrames: number;
  validationFrames: number;
  /** Whether bot players were included rather than people only. */
  includedBots: boolean;
  /**
   * Maps trained on without their geometry, so without line of sight or item
   * distances. Absent or empty when every map loaded.
   */
  blindMaps?: string[];
  /** Match ids, so a later run can skip what it already counted. */
  matchIds: string[];
}

export function describeCurrentFeatures(): Pick<
  ModelMetadata,
  "tacticalInputSize" | "combatInputSize" | "frameStack" | "tacticalOutputSize" | "combatOutputSize" | "outputEncoding"
> {
  return {
    outputEncoding: OUTPUT_ENCODING,
    tacticalInputSize: TACTICAL_MODEL_INPUT,
    combatInputSize: COMBAT_MODEL_INPUT,
    frameStack: FRAME_STACK,
    tacticalOutputSize: TACTICAL_OUTPUT_SIZE,
    combatOutputSize: COMBAT_OUTPUT_SIZE,
  };
}

/** Whether a directory holds either head's weights. */
export function hasModels(modelDir: string): boolean {
  const dir = path.resolve(modelDir);
  return (
    fs.existsSync(path.join(dir, "tactical", "model.json")) || fs.existsSync(path.join(dir, "combat", "model.json"))
  );
}

/**
 * Where a bot of a given difficulty should load its weights from.
 *
 * Self-play leaves one set per difficulty tier under the base directory, and
 * demo training leaves a single set in the base directory itself. A bot takes its
 * tier's weights when there are any and the base set otherwise. This used to be
 * a fallback that ran only when loading the tier's weights *failed* — but loading
 * never fails, it logs "using state machine" and carries on, so a bot pointed at
 * demo-trained weights looked in `<dir>/medium`, found nothing, and never looked
 * anywhere else.
 */
export function resolveModelDir(baseModelDir: string, difficulty: string): string {
  const tierDir = path.join(baseModelDir, difficulty);
  return hasModels(tierDir) ? tierDir : baseModelDir;
}

export function writeMetadata(modelDir: string, metadata: ModelMetadata): void {
  fs.mkdirSync(path.resolve(modelDir), { recursive: true });
  fs.writeFileSync(path.join(path.resolve(modelDir), METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
}

export function readMetadata(modelDir: string): ModelMetadata | null {
  try {
    const raw = fs.readFileSync(path.join(path.resolve(modelDir), METADATA_FILE), "utf-8");
    return JSON.parse(raw) as ModelMetadata;
  } catch {
    return null;
  }
}

/**
 * Whether weights described by this metadata can be fed today's features.
 *
 * Metadata that is missing is not an error — models trained before this existed
 * have none — but it is worth saying, because it is the case where a mismatch
 * would pass unnoticed.
 */
export function checkCompatibility(metadata: ModelMetadata | null): { ok: boolean; reason?: string } {
  const current = describeCurrentFeatures();
  if (!metadata) {
    return { ok: true, reason: "no metadata beside these weights — the feature vector they expect is unknown" };
  }
  if (metadata.tacticalInputSize !== current.tacticalInputSize) {
    return {
      ok: false,
      reason: `trained on ${metadata.tacticalInputSize} tactical inputs, this build feeds ${current.tacticalInputSize}`,
    };
  }
  if (metadata.combatInputSize !== current.combatInputSize) {
    return {
      ok: false,
      reason: `trained on ${metadata.combatInputSize} combat inputs, this build feeds ${current.combatInputSize}`,
    };
  }
  // The same width can come from a different split between frames and features;
  // the depth says which, and a model read with the wrong one sees time smeared
  // across features that were never next to each other.
  if (metadata.outputEncoding !== current.outputEncoding) {
    return {
      ok: false,
      reason: metadata.outputEncoding
        ? `outputs encoded as "${metadata.outputEncoding}", this build reads "${current.outputEncoding}"`
        : "trained when every output went through a sigmoid; this build reads logits and turns",
    };
  }
  if (typeof metadata.frameStack === "number" && metadata.frameStack !== current.frameStack) {
    return {
      ok: false,
      reason: `trained on stacks of ${metadata.frameStack} frames, this build stacks ${current.frameStack}`,
    };
  }
  // An output width is what fixes the meaning of each index. Weights that
  // predict eight numbers read through a five-output map are not wrong by a
  // little: index 0 is a different question entirely.
  if (typeof metadata.tacticalOutputSize === "number" && metadata.tacticalOutputSize !== current.tacticalOutputSize) {
    return {
      ok: false,
      reason: `trained with ${metadata.tacticalOutputSize} tactical outputs, this build reads ${current.tacticalOutputSize}`,
    };
  }
  if (typeof metadata.combatOutputSize === "number" && metadata.combatOutputSize !== current.combatOutputSize) {
    return {
      ok: false,
      reason: `trained with ${metadata.combatOutputSize} combat outputs, this build reads ${current.combatOutputSize}`,
    };
  }
  return { ok: true };
}
