// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SnapshotBuffer } from "../../../../engine/network/client/SnapshotBuffer";
import { Entity } from "../../../../shared/net/Entity";
import { GameState } from "../../../../shared/net/GameState";
import { DEFAULT_PHYSICS_TICK_RATE } from "../../../../shared/server/simulation/physics/constants";

/**
 * A server projectile is drawn only once its one-tick projectile_spawn event
 * has named its type. One that arrives without it flies with no model and no
 * trail, so the sync says so.
 *
 * The projectile and view managers are mocked at the module boundary: this is
 * about which projectiles are spawned, not how they render.
 */
const projectiles = { scene: {}, spawnFromServer: vi.fn(), despawnByEntityId: vi.fn(), clear: vi.fn() };
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
const { ServerProjectiles } = await import("../ServerProjectiles");

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

const newSync = () => ({
  active: new Set<string>(),
  defIds: new Map<string, string>(),
  seenTicks: new Map<string, number>(),
  buffer: new SnapshotBuffer(),
});

/** Rockets live 10 s; a type is kept a second longer than that. */
const FORGET = 11 * DEFAULT_PHYSICS_TICK_RATE;

function emptySnapshot(tick: number): GameState {
  const state = new GameState();
  state.tick = tick;
  return state;
}

describe("projectile sync", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    projectiles.spawnFromServer.mockClear();
    projectiles.despawnByEntityId.mockClear();
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

  it("draws a projectile again when it comes back into view, mid-flight rather than at the gun", () => {
    const muzzleForShot = vi.fn(() => ({ x: 8, y: 9, z: 10 }) as never);
    const sync = { ...newSync(), muzzleForShot };
    sync.defIds.set("proj_7", "rocket");
    processProjectileEntities(snapshotWithProjectile(100) as never, sync);

    // Behind a wall: the server's PVS leaves it out, which looks like an explosion.
    processProjectileEntities(emptySnapshot(101) as never, sync);
    expect(projectiles.despawnByEntityId).toHaveBeenCalledWith("proj_7");

    processProjectileEntities(snapshotWithProjectile(200) as never, sync);
    expect(projectiles.spawnFromServer).toHaveBeenCalledTimes(2);
    expect(projectiles.spawnFromServer).toHaveBeenLastCalledWith(
      "proj_7",
      "rocket",
      expect.anything(),
      expect.anything(),
      null,
    );
    expect(muzzleForShot).toHaveBeenCalledOnce();
  });

  it("forgets a projectile's type once it has been gone longer than any projectile lives", () => {
    const sync = newSync();
    sync.defIds.set("proj_7", "rocket");
    processProjectileEntities(snapshotWithProjectile(100) as never, sync);
    processProjectileEntities(emptySnapshot(100 + FORGET) as never, sync);
    expect(sync.defIds.has("proj_7")).toBe(true);
    processProjectileEntities(emptySnapshot(101 + FORGET) as never, sync);
    expect(sync.defIds.size).toBe(0);
    expect(sync.seenTicks.size).toBe(0);
  });

  it("ages a type whose projectile was never in view from when it was announced", () => {
    const sync = newSync();
    processProjectileEntities(emptySnapshot(500) as never, sync);
    sync.defIds.set("proj_9", "plasma_bolt");
    processProjectileEntities(emptySnapshot(501) as never, sync);
    processProjectileEntities(emptySnapshot(501 + FORGET) as never, sync);
    expect(sync.defIds.has("proj_9")).toBe(true);
    processProjectileEntities(emptySnapshot(502 + FORGET) as never, sync);
    expect(sync.defIds.has("proj_9")).toBe(false);
  });

  it("draws projectiles still in flight again after a tab return cleared the visuals", () => {
    const projectilesState = new ServerProjectiles();
    const sync = {
      active: projectilesState.active,
      defIds: projectilesState.defIds,
      seenTicks: projectilesState.seenTicks,
      buffer: projectilesState.buffer,
    };
    sync.defIds.set("proj_7", "rocket");
    processProjectileEntities(snapshotWithProjectile(100) as never, sync);

    projectilesState.dropVisuals();
    expect(projectiles.clear).toHaveBeenCalled();
    processProjectileEntities(snapshotWithProjectile(101) as never, sync);
    expect(projectiles.spawnFromServer).toHaveBeenCalledTimes(2);
  });
});
