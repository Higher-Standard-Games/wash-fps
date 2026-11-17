/**
 * Material revalidation after a restored context runs one at a time: a restore
 * arriving during one asks for one more pass after it, never a second at once.
 */
import { describe, expect, it, vi } from "vitest";

const runs = vi.hoisted(() => ({ active: 0, most: 0, total: 0, release: [] as Array<() => void> }));
vi.mock("../../../../engine/weapon/EffectPreloader", () => ({
  revalidateMaterials: async () => {
    runs.active++;
    runs.total++;
    runs.most = Math.max(runs.most, runs.active);
    await new Promise<void>((resolve) => runs.release.push(resolve));
    runs.active--;
  },
}));

import { Game } from "../../Game";

type Revalidating = { revalidateAfterContextRestore(scene: unknown): Promise<void> };

describe("revalidation after a restored context", () => {
  it("never runs twice at once, and runs once more for a restore during one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const game = Object.create(Game.prototype) as Revalidating & Record<string, unknown>;
    game._revalidating = false;
    game._revalidateAgain = false;
    const scene = { isDisposed: false };
    const first = game.revalidateAfterContextRestore(scene);
    await vi.waitFor(() => expect(runs.release).toHaveLength(1));
    // Two more restores while the first runs
    await game.revalidateAfterContextRestore(scene);
    await game.revalidateAfterContextRestore(scene);
    runs.release.shift()?.();
    await vi.waitFor(() => expect(runs.release).toHaveLength(1));
    runs.release.shift()?.();
    await first;
    expect(runs.most).toBe(1);
    expect(runs.total).toBe(2);
    vi.restoreAllMocks();
  });
});
