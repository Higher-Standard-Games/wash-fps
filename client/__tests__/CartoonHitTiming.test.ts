import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CartoonHitEffect } from "../CartoonHitEffect";

/**
 * A POW! sprite lives 0.8 s of game time. It was ticked by FrameEffects and
 * again by its own render observer, so it was gone in 0.4 s.
 */
describe("cartoon hit sprite timing", () => {
  afterEach(() => {
    CartoonHitEffect.getInstance().dispose();
    vi.restoreAllMocks();
  });

  it("is ticked once a frame, so it lasts its full 0.8 s", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const scene = new Scene(new NullEngine());
    const effect = CartoonHitEffect.getInstance();
    effect.init(scene);
    effect.spawn(0, 0, 0, 100);
    const sprite = scene.meshes.find((mesh) => mesh.name.startsWith("cartoonhit_"));
    expect(sprite?.isEnabled()).toBe(true);

    // Ten frames of 70 ms: 0.7 s, as FrameEffects ticks it, while the scene renders.
    for (let frame = 1; frame <= 10; frame++) {
      now.mockReturnValue(frame * 70);
      scene.onBeforeRenderObservable.notifyObservers(scene);
      effect.update(0.07);
    }
    expect(sprite?.isEnabled()).toBe(true);

    effect.update(0.11);
    expect(sprite?.isEnabled()).toBe(false);
  });
});
