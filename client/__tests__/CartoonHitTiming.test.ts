import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PK3Loader } from "../../../../engine/loader/pk3/PK3Loader";
import { CartoonHitEffect } from "../CartoonHitEffect";

vi.mock("../../../../engine/loader/pk3/PK3Index", () => ({
  PK3Index: { getInstance: () => ({ ensureIndex: async () => {}, findFile: () => "washoi_effects.pk3" }) },
}));
vi.mock("../../../../engine/loader/pk3/PK3Loader", () => ({
  PK3Loader: { getInstance: () => loader },
}));
const loader = { ensurePK3: vi.fn(async () => {}), getFile: vi.fn(async () => new ArrayBuffer(4)) };

/**
 * A POW! sprite lives 0.8 s of game time. It was ticked by FrameEffects and
 * again by its own render observer, so it was gone in 0.4 s.
 */
describe("cartoon hit sprite timing", () => {
  afterEach(() => {
    CartoonHitEffect.getInstance().dispose();
    vi.restoreAllMocks();
  });

  it("is ticked once a frame, so it lasts its full 0.8 s", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const scene = new Scene(new NullEngine());
    const effect = CartoonHitEffect.getInstance();
    await effect.init(scene);
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
    scene.dispose();
  });

  it("does not install textures after disposal during a package request", async () => {
    let finish!: () => void;
    vi.spyOn(PK3Loader.getInstance(), "ensurePK3").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const scene = new Scene(new NullEngine());
    const effect = CartoonHitEffect.getInstance();
    const pending = effect.init(scene);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    effect.dispose();
    finish();
    await pending;
    effect.spawn(0, 0, 0, 100);
    expect(scene.meshes).toHaveLength(0);
    expect(scene.textures).toHaveLength(0);
    scene.dispose();
  });
});
