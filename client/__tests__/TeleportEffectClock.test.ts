import { describe, expect, it, vi } from "vitest";
import { TeleportEffect } from "../TeleportEffect";

/**
 * A teleport's ghosts get their whole life, however long since the last one.
 *
 * The frame clock only ran while effects were alive, so the first frame of a
 * teleport counted the idle time since the previous one (capped at 100 ms) and
 * the afterimage came up a tenth of a second into its fade (E6).
 */
describe("teleport effect clock", () => {
  it("does not charge a new effect for the idle time before it", () => {
    const now = vi.spyOn(performance, "now");
    try {
      const fx = TeleportEffect.getInstance() as unknown as {
        lastTime: number;
        effects: Array<{ elapsedMs: number }>;
        update(): void;
      };
      now.mockReturnValue(1000);
      fx.lastTime = 1000;
      fx.effects = [];

      // Idle frames, seconds apart.
      for (let t = 1016; t <= 5000; t += 16) {
        now.mockReturnValue(t);
        fx.update();
      }

      const effect = {
        root: {},
        material: { alpha: 1 },
        elapsedMs: 0,
        lifetimeMs: 1000,
        alphaSteps: [1, 0.5],
      };
      fx.effects = [effect];
      now.mockReturnValue(5016);
      fx.update();

      expect(effect.elapsedMs).toBeLessThanOrEqual(20);
      fx.effects = [];
    } finally {
      now.mockRestore();
    }
  });
});
