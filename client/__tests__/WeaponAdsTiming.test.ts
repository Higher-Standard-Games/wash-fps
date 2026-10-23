import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { expect, it, vi } from "vitest";
import { WeaponViewManager } from "../../../../engine/weapon/WeaponViewManager";
import { ELECTROBOLT } from "../../shared/entities/definitions/weapons/electrobolt";
import { ROCKET_LAUNCHER } from "../../shared/entities/definitions/weapons/rlauncher";

vi.mock("../../../../engine/weapon/ProjectileManager", () => ({ getProjectileManager: () => ({ init: vi.fn() }) }));
vi.mock("../../../../engine/weapon/HitscanEffects", () => ({
  getHitscanEffects: () => ({
    init: vi.fn(),
    stopBeam: vi.fn(),
    stopLightning: vi.fn(),
    setMuzzleAnchorResolver: vi.fn(),
  }),
}));

it.each([ROCKET_LAUNCHER, ELECTROBOLT])("finishes $id view ADS in the configured time", (weapon) => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("ads-camera", Vector3.Zero(), scene);
  const manager = new WeaponViewManager();
  manager.init(scene, camera);
  const internals = manager as unknown as {
    currentWeapon: unknown;
    currentWeaponDef: unknown;
    followedBobActive: boolean;
    followedAiming: boolean;
    updateWeaponBob(dt: number): void;
  };
  try {
    internals.currentWeapon = {
      root: new TransformNode("ads-gun", scene),
      meshes: [],
      skeletons: [],
      animationGroups: [],
    };
    internals.currentWeaponDef = weapon;
    internals.followedBobActive = true;
    internals.followedAiming = true;
    const halfTime = weapon.ads!.time / 2;
    internals.updateWeaponBob(halfTime);
    expect(manager.getAdsProgress()).toBeCloseTo(0.5);
    internals.updateWeaponBob(halfTime);
    expect(manager.getAdsProgress()).toBeCloseTo(1);
    internals.followedAiming = false;
    internals.updateWeaponBob(weapon.ads!.time);
    expect(manager.getAdsProgress()).toBeCloseTo(0);
  } finally {
    manager.dispose();
    scene.dispose();
    engine.dispose();
  }
});
