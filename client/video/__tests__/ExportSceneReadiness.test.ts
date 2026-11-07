import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it, vi } from "vitest";
import { ExportSceneReadiness } from "../ExportSceneReadiness";

describe("offline shader readiness", () => {
  it("redraws new or pending effects without advancing the movie and releases observers", async () => {
    const engine = new NullEngine(),
      scene = new Scene(engine);
    const material = new StandardMaterial("movie", scene),
      clock = { deltaMs: 1000 / 60 };
    vi.spyOn(material, "isReady").mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
    const original = material.allowShaderHotSwapping;
    const owner = new ExportSceneReadiness(scene, clock);
    try {
      const deltas: number[] = [];
      vi.spyOn(scene, "render").mockImplementation(() => {
        deltas.push(clock.deltaMs);
        material.isReady();
      });
      expect(material.allowShaderHotSwapping).toBe(false);
      const late = new StandardMaterial("late", scene);
      const lateReady = late.isReady;
      await owner.render(new AbortController().signal);
      expect(late.allowShaderHotSwapping).toBe(false);
      expect(deltas).toEqual([1000 / 60, 0, 0]);
      expect(clock.deltaMs).toBe(1000 / 60);
      late.dispose();
      expect(late.isReady).toBe(lateReady);
      owner.dispose();
      expect(material.allowShaderHotSwapping).toBe(original);
      expect(scene.onNewMaterialAddedObservable.hasObservers()).toBe(false);
    } finally {
      owner.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("cancels an unready shader wait and restores the frame delta", async () => {
    const engine = new NullEngine(),
      scene = new Scene(engine),
      clock = { deltaMs: 16 };
    const owner = new ExportSceneReadiness(scene, clock),
      controller = new AbortController();
    vi.spyOn(scene, "render").mockImplementation(() => {
      controller.abort(new Error("cancel compile"));
    });
    try {
      await expect(owner.render(controller.signal)).rejects.toThrow("cancel compile");
      expect(clock.deltaMs).toBe(16);
    } finally {
      owner.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
