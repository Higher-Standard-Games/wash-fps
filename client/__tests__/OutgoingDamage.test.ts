// @vitest-environment jsdom

import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { Crosshair } from "../Crosshair";
import { DamageNumbers } from "../DamageNumbers";

/**
 * Landing a hit feeds back four ways: a confirmation sound, a crosshair flash, a
 * floating damage number and the cartoon hit effect. This is the path every hit takes,
 * so it is driven here through the real `handleOutgoingDamage`, with only the sound and
 * the engine's camera and weapon managers replaced.
 */
const scene = { name: "game-scene" };
const confirm = vi.fn();

vi.mock("../FPSCombatAudio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../FPSCombatAudio")>()),
  playDamageConfirmationSound: (event: unknown) => confirm(event),
}));
vi.mock("../../../../engine/camera", () => ({
  CameraSystem: { getInstance: () => ({ getCamera: () => ({ getScene: () => scene }), getController: () => null }) },
}));
vi.mock("../../../../engine/weapon/ProjectileManager", () => ({ getProjectileManager: () => ({}) }));
vi.mock("../../../../engine/weapon/WeaponViewManager", () => ({ getWeaponViewManager: () => ({}) }));
vi.mock("../../../../engine/AudioManager", () => ({
  AudioManager: { getInstance: () => ({ loadPlaylist: () => {} }) },
}));
vi.mock("../../FPSPlayer", () => ({ FPSPlayer: { getInstance: () => ({}) } }));

const { handleOutgoingDamage } = await import("../GameEvents");

const hit = (over: Record<string, unknown> = {}) =>
  ({
    type: "damage",
    entityId: "e2",
    attackerId: "e1",
    damage: 40,
    weaponId: "rlauncher",
    x: 1,
    y: 2,
    z: 3,
    ...over,
  }) as never;

describe("outgoing damage feedback", () => {
  const cartoon = { spawn: vi.fn() };
  const ctx = () => ({ _cartoonHit: cartoon }) as never;
  let flash: MockInstance;
  let init: MockInstance;
  let spawn: MockInstance;

  // DamageNumbers and Crosshair are process-wide singletons, so every test gets fresh
  // spies, and the real mesh-building `spawn` never runs against the fake scene.
  beforeEach(() => {
    vi.restoreAllMocks();
    confirm.mockClear();
    cartoon.spawn.mockClear();
    flash = vi.spyOn(Crosshair.getInstance(), "notifyHit");
    init = vi.spyOn(DamageNumbers.getInstance(), "init").mockImplementation(() => {});
    spawn = vi.spyOn(DamageNumbers.getInstance(), "spawn").mockImplementation(() => {});
  });

  it("gives no hit feedback for damage you did to yourself, a fall or your own splash", () => {
    handleOutgoingDamage(ctx(), hit({ entityId: "e1", weaponId: "fall" }));
    handleOutgoingDamage(ctx(), hit({ entityId: "e1" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(flash).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("confirms the hit with a sound and flashes the crosshair, immediately", () => {
    handleOutgoingDamage(ctx(), hit());

    // No awaiting: feedback is not deferred behind a dynamic import.
    expect(confirm).toHaveBeenCalledOnce();
    expect(flash).toHaveBeenCalledOnce();
  });

  it("spawns a floating number where the victim was hit", () => {
    handleOutgoingDamage(ctx(), hit({ x: 10, y: 20, z: 30, damage: 55 }));

    expect(init).toHaveBeenCalledWith(scene);
    expect(spawn).toHaveBeenCalledWith(10, 20, 30, 55, undefined);
  });

  it("tells the crosshair and the number where the hit landed", () => {
    handleOutgoingDamage(ctx(), hit({ hitLocation: "head", x: 1, y: 2, z: 3, damage: 11 }));

    expect(flash).toHaveBeenCalledWith("head");
    expect(spawn).toHaveBeenCalledWith(1, 2, 3, 11, "head");
  });

  it("treats an event without a location as a body hit", () => {
    handleOutgoingDamage(ctx(), hit()); // a server or demo that predates the field

    expect(flash).toHaveBeenCalledWith(undefined);
    expect(spawn).toHaveBeenCalledWith(1, 2, 3, 40, undefined);
  });

  it("shows no number for a hit that did no damage, but still confirms it", () => {
    handleOutgoingDamage(ctx(), hit({ damage: 0 }));

    expect(spawn).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledOnce();
    expect(flash).toHaveBeenCalledOnce();
  });

  it("plays the cartoon hit effect when one is set up", () => {
    handleOutgoingDamage(ctx(), hit({ x: 4, y: 5, z: 6, damage: 25 }));
    expect(cartoon.spawn).toHaveBeenCalledWith(4, 5, 6, 25);
  });

  it("works without a cartoon hit effect", () => {
    expect(() => handleOutgoingDamage({ _cartoonHit: null } as never, hit())).not.toThrow();
  });
});
