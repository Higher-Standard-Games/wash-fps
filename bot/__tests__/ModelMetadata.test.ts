/**
 * Weights say nothing about the features they expect: a dense layer takes any
 * vector of the right length. Metadata beside them turns a silent mismatch into
 * a refusal. TF-10 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TACTICAL_TARGET_SIZE } from "../CloningTargets";
import { COMBAT_MODEL_INPUT, FRAME_STACK, TACTICAL_MODEL_INPUT } from "../ModelInputs";
import { checkCompatibility, describeCurrentFeatures, type ModelMetadata, resolveModelDir } from "../ModelMetadata";

const metadata = (over: Partial<ModelMetadata> = {}): ModelMetadata => ({
  ...describeCurrentFeatures(),
  trainedAt: "2026-09-23T00:00:00.000Z",
  matches: 3,
  trainFrames: 900,
  validationFrames: 100,
  includedBots: false,
  matchIds: ["m1", "m2", "m3"],
  ...over,
});

describe("checkCompatibility", () => {
  it("accepts weights trained on this build's features", () => {
    expect(checkCompatibility(metadata())).toEqual({ ok: true });
  });

  it("refuses weights whose tactical vector is a different size", () => {
    const result = checkCompatibility(metadata({ tacticalInputSize: TACTICAL_MODEL_INPUT + 3 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(`${TACTICAL_MODEL_INPUT}`);
  });

  it("refuses weights whose combat vector is a different size", () => {
    const result = checkCompatibility(metadata({ combatInputSize: COMBAT_MODEL_INPUT - 1 }));
    expect(result.ok).toBe(false);
  });

  it("refuses weights that predict a different number of outputs", () => {
    // The width fixes what each index means: weights trained when the tactical
    // head opened with three mode confidences would have index 0 answering a
    // question this build no longer asks.
    const result = checkCompatibility(metadata({ tacticalOutputSize: TACTICAL_TARGET_SIZE + 3 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("outputs");
  });

  it("accepts metadata written before output widths were recorded", () => {
    const older = metadata();
    delete older.tacticalOutputSize;
    delete older.combatOutputSize;
    expect(checkCompatibility(older)).toEqual({ ok: true });
  });

  it("refuses weights trained before inputs were stacked", () => {
    // One frame's worth of features: exactly what every model had before
    const result = checkCompatibility(metadata({ tacticalInputSize: TACTICAL_MODEL_INPUT / FRAME_STACK }));
    expect(result.ok).toBe(false);
  });

  it("refuses the same width split into a different number of frames", () => {
    const result = checkCompatibility(metadata({ frameStack: FRAME_STACK + 1 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("frames");
  });

  it("refuses weights from when every output went through a sigmoid", () => {
    const older = metadata();
    delete older.outputEncoding;
    const result = checkCompatibility(older);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("sigmoid");
  });

  it("allows weights with no metadata, but says the shape is unknown", () => {
    const result = checkCompatibility(null);
    expect(result.ok).toBe(true);
    expect(result.reason).toContain("unknown");
  });
});

describe("resolveModelDir", () => {
  const dirs: string[] = [];
  const makeDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shag-models-"));
    dirs.push(dir);
    return dir;
  };
  const placeModel = (dir: string): void => {
    fs.mkdirSync(path.join(dir, "tactical"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tactical", "model.json"), "{}");
  };

  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses the base directory when that is where the weights are, as demo training leaves them", () => {
    // A bot used to look only in <dir>/medium here and play the state machine
    const base = makeDir();
    placeModel(base);
    expect(resolveModelDir(base, "medium")).toBe(base);
  });

  it("prefers the difficulty's own weights when self-play left a set for it", () => {
    const base = makeDir();
    placeModel(base);
    placeModel(path.join(base, "hard"));
    expect(resolveModelDir(base, "hard")).toBe(path.join(base, "hard"));
    expect(resolveModelDir(base, "easy")).toBe(base);
  });
});
