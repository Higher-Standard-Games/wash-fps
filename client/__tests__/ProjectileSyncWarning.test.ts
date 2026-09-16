// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SnapshotBuffer } from "../../../../engine/network/client/SnapshotBuffer";
import { Entity } from "../../../../shared/net/Entity";
import { GameState } from "../../../../shared/net/GameState";

/**
 * A server projectile is drawn only once its one-tick projectile_spawn event
 * has named its type. One that arrives without it flies with no model and no
 * trail, so the sync says so.
 *
 * The projectile and view managers are mocked at the module boundary: this is
 * about which projectiles are spawned, not how they render.
 */
const projectiles = { scene: {}, spawnFromServer: vi.fn(), despawnByEntityId: vi.fn() };
vi.mock("../../../../engine/weapon/ProjectileManager", () => ({
  getProjectileManager: () => projectiles,
}));
vi.mock("../../../../engine/weapon/WeaponViewManager", () => ({
  getWeaponViewManager: () => ({}),
}));
vi.mock("../../FPSPlayer", () => ({
  FPSPlayer: { getInstance: () => ({}) },
}));

const { processProjectileEntities } = await import("../GameEvents");

function snapshotWithProjectile(tick: number): GameState {
  const state = new GameState();
  state.tick = tick;
  const entity = new Entity("proj_7");
  entity.addComponent("position", {
    x: 1,
    y: 2,
    z: 3,
    serialize() {},
    deserialize() {},
    clone() {
      return { ...this };
    },
  });
  state.entities.set(entity.id, entity);
  return state;
}

const newSync = () => ({ active: new Set<string>(), defIds: new Map<string, string>(), buffer: new SnapshotBuffer() });

describe("projectile sync", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    projectiles.spawnFromServer.mockClear();
  });

  it("warns about a projectile that arrives without its projectile_spawn event", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    processProjectileEntities(snapshotWithProjectile(40) as never, newSync());

    expect(projectiles.spawnFromServer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[ProjectileSync]", expect.stringContaining("proj_7 is in snapshot 40"));
  });

  it("draws a projectile whose projectile_spawn event arrived, without a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sync = newSync();
    sync.defIds.set("proj_7", "plasma_bolt");

    processProjectileEntities(snapshotWithProjectile(41) as never, sync);

    expect(projectiles.spawnFromServer).toHaveBeenCalledWith(
      "proj_7",
      "plasma_bolt",
      expect.anything(),
      expect.anything(),
      undefined,
    );
    expect(warn).not.toHaveBeenCalledWith("[ProjectileSync]", expect.anything());
  });

  it("passes the selected view's muzzle to projectile presentation", () => {
    const muzzle = { x: 8, y: 9, z: 10 };
    const muzzleForShot = vi.fn(() => muzzle as never);
    const sync = { ...newSync(), muzzleForShot };
    sync.defIds.set("proj_7", "plasma_bolt");
    processProjectileEntities(snapshotWithProjectile(42) as never, sync);
    expect(muzzleForShot).toHaveBeenCalledOnce();
    expect(projectiles.spawnFromServer).toHaveBeenCalledWith(
      "proj_7",
      "plasma_bolt",
      expect.anything(),
      expect.anything(),
      muzzle,
    );
  });
});
