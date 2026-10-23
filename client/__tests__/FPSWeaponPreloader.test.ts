import { beforeEach, describe, expect, it, vi } from "vitest";

const view = vi.hoisted(() => ({ init: vi.fn(), preloadWeapons: vi.fn(async () => {}) }));
const projectiles = vi.hoisted(() => ({ prepare: vi.fn(async () => {}) }));
vi.mock("../../../../engine/weapon/WeaponViewManager", () => ({ getWeaponViewManager: () => view }));
vi.mock("../../../../engine/weapon/ProjectileManager", () => ({ getProjectileManager: () => projectiles }));

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
