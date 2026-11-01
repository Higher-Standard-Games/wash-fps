import { beforeEach, describe, expect, it, vi } from "vitest";

const view = vi.hoisted(() => ({
  init: vi.fn(),
  preloadWeapons: vi.fn(async (_ids: string[], _onProgress?: (id: string) => void) => {}),
  prepareEffectShaders: vi.fn(async () => {}),
}));
const projectiles = vi.hoisted(() => ({ prepare: vi.fn(async () => {}) }));
const hitscan = vi.hoisted(() => ({ preparePelletShader: vi.fn(async () => {}) }));
const numbers = vi.hoisted(() => ({ prepareShaders: vi.fn(async () => {}), dispose: vi.fn() }));
const teleport = vi.hoisted(() => ({ prepare: vi.fn(async () => {}) }));
vi.mock("../../../../engine/weapon/WeaponViewManager", () => ({ getWeaponViewManager: () => view }));
vi.mock("../../../../engine/weapon/ProjectileManager", () => ({ getProjectileManager: () => projectiles }));
vi.mock("../../../../engine/weapon/HitscanEffects", () => ({ getHitscanEffects: () => hitscan }));
vi.mock("../DamageNumbers", () => ({ DamageNumbers: { create: () => numbers } }));
vi.mock("../TeleportEffect", () => ({ TeleportEffect: { getInstance: () => teleport } }));
vi.mock("../../../../engine/loader/map/GpuPreparation", () => ({
  sceneGpuReady: vi.fn(),
  waitForGpuCondition: vi.fn(async () => {}),
}));

import { getEntityRegistry } from "../../../../shared/entities";
import { initializeEntityDefs } from "../../shared/entities";
import { preloadFPSWeapons } from "../FPSWeaponPreloader";

describe("map-load weapon preload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prepares every projectile a weapon fires, once each", async () => {
    const scene = {} as never;
    await preloadFPSWeapons(scene, {} as never);
    expect(projectiles.prepare).toHaveBeenCalledOnce();
    const [preparedScene, ids] = projectiles.prepare.mock.calls[0] as unknown as [unknown, string[]];
    expect(preparedScene).toBe(scene);
    expect([...ids].sort()).toEqual(["blade_blast", "grenade", "plasma_bolt", "rocket"]);
  });

  it("compiles what a fight draws first: slash trail, pellets, damage numbers, teleport ghost", async () => {
    const scene = {} as never;
    await preloadFPSWeapons(scene, {} as never);
    expect(view.prepareEffectShaders).toHaveBeenCalledOnce();
    expect(hitscan.preparePelletShader).toHaveBeenCalledOnce();
    expect(numbers.prepareShaders).toHaveBeenCalledOnce();
    // A throwaway damage-number system: its pool belongs to no match
    expect(numbers.dispose).toHaveBeenCalledOnce();
    expect(teleport.prepare).toHaveBeenCalledWith(scene, undefined);
  });

  it("reports its progress from none to all of its steps, in order", async () => {
    view.preloadWeapons.mockImplementationOnce(async (ids: string[], onProgress?: (id: string) => void) => {
      for (const id of ids) onProgress?.(id);
    });
    const seen: Array<[number, number]> = [];
    await preloadFPSWeapons({} as never, {} as never, (done, total) => seen.push([done, total]));
    const total = seen[0][1];
    expect(seen.map(([done]) => done)).toEqual(Array.from({ length: total + 1 }, (_, i) => i));
    expect(seen.every(([, t]) => t === total)).toBe(true);
  });

  it("goes on loading when an effect warm-up fails: it only costs that effect a compile in play", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    numbers.prepareShaders.mockRejectedValueOnce(new Error("GPU preparation timed out: dmg_mat_0 on dmg_plane_0"));
    await expect(preloadFPSWeapons({} as never, {} as never)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("damage numbers"), expect.any(Error));
    expect(teleport.prepare).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("still stops when the load is cancelled during an effect warm-up", async () => {
    const controller = new AbortController();
    hitscan.preparePelletShader.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"));
      throw new Error("cancelled");
    });
    await expect(preloadFPSWeapons({} as never, {} as never, undefined, controller.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(teleport.prepare).not.toHaveBeenCalled();
  });
});

describe("entity definitions", () => {
  it("register once, however many paths ask, and again into a cleared registry", () => {
    const registry = getEntityRegistry();
    initializeEntityDefs();
    const count = registry.getCount();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    initializeEntityDefs();
    expect(warn).not.toHaveBeenCalled();
    expect(registry.getCount()).toBe(count);

    registry.clear();
    initializeEntityDefs();
    expect(registry.getCount()).toBe(count);
    warn.mockRestore();
  });
});
