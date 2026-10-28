import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WeaponViewManager } from "../../../../engine/weapon/WeaponViewManager";
import type { WeaponDef } from "../../../../shared/entities/WeaponDef";
import { LASERGUN } from "../../shared/entities/definitions/weapons/lasergun";
import { PLASMAGUN } from "../../shared/entities/definitions/weapons/plasmagun";
import { VOLTAIC } from "../../shared/entities/definitions/weapons/voltaic";

const hitscan = vi.hoisted(() => ({
  init: vi.fn(),
  beginLightning: vi.fn(),
  updateLightningBeam: vi.fn(),
  updateBeam: vi.fn(),
  stopBeam: vi.fn(),
  stopLightning: vi.fn(),
  setMuzzleAnchorResolver: vi.fn(),
  fireMuzzleFlash: vi.fn(),
}));

vi.mock("../../../../engine/weapon/HitscanEffects", () => ({
  getHitscanEffects: () => hitscan,
}));

vi.mock("../../../../engine/weapon/ProjectileManager", () => ({
  getProjectileManager: () => ({ init: vi.fn() }),
}));

interface BeamRoutingInternals {
  beamActive: boolean;
  currentWeaponDef: WeaponDef | null;
  getMuzzleWorldPosition: () => Vector3 | null;
  updateMuzzleFlash: (deltaTime: number) => void;
  updateBeam: () => void;
  muzzleSocket: TransformNode | null;
  weaponCamera: FreeCamera;
  weaponRoot: TransformNode;
}

describe("WeaponViewManager continuous beam routing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses one procedural Voltaic renderer path", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    const manager = new WeaponViewManager();

    try {
      manager.init(scene, camera);
      const internals = manager as unknown as BeamRoutingInternals;
      internals.currentWeaponDef = VOLTAIC;
      internals.beamActive = true;
      internals.getMuzzleWorldPosition = () => new Vector3(2, -1, 4);

      internals.updateBeam();

      expect(hitscan.updateLightningBeam).toHaveBeenCalledOnce();
      expect(hitscan.updateBeam).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("starts the beam at this frame's muzzle when the camera moves after the weapon view updates", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    const manager = new WeaponViewManager();

    try {
      // A prepared view keeps its update observer from before the map's
      // first-person controller attached, so the camera moves after it
      manager.init(scene, camera);
      const muzzle = new Vector3(0, 0, 0);
      scene.onBeforeRenderObservable.add(() => {
        muzzle.x += 6;
      });
      const internals = manager as unknown as BeamRoutingInternals;
      internals.currentWeaponDef = VOLTAIC;
      internals.beamActive = true;
      internals.getMuzzleWorldPosition = () => muzzle.clone();

      scene.render();

      expect(hitscan.updateLightningBeam).toHaveBeenCalledOnce();
      expect(hitscan.updateLightningBeam.mock.calls[0][0].origin.x).toBe(6);
    } finally {
      manager.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("exports Lasergun as the exact canonical Voltaic definition", () => {
    expect(LASERGUN).toBe(VOLTAIC);
    expect(VOLTAIC.modelPath).toBe("/data/models/weapons/voltaic/voltaic.glb");
    expect(VOLTAIC.viewModel.modelPath).toBe(VOLTAIC.modelPath);
    expect(VOLTAIC.viewModel.viewModelFormat).toBe("glb");
    expect(VOLTAIC.viewModel.adsOffset).toEqual({ x: 0, y: -21, z: -5 });
    // Voltaic runs its own quick beam reload (0.5s) — no longer tied to the
    // Plasmagun value, so a full 120-cell clip isn't interrupted every ~3s.
    expect(VOLTAIC.reloadTime).toBe(0.5);
    expect(VOLTAIC.reloadTime).toBeLessThan(PLASMAGUN.reloadTime);
  });

  it("projects the authored muzzle socket to the same pixel in the world camera", () => {
    const engine = new NullEngine({
      renderWidth: 1280,
      renderHeight: 720,
      textureSize: 512,
      deterministicLockstep: false,
      lockstepMaxSteps: 4,
    });
    const scene = new Scene(engine);
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    camera.fov = (105 * Math.PI) / 180;
    const manager = new WeaponViewManager();

    try {
      manager.init(scene, camera);
      const internals = manager as unknown as BeamRoutingInternals;
      internals.weaponRoot.position.set(0, -4, 10);
      const socket = new TransformNode("tag_flash", scene);
      socket.parent = internals.weaponRoot;
      socket.position.set(7, 2, 25);
      internals.muzzleSocket = socket;
      socket.computeWorldMatrix(true);

      camera.getViewMatrix(true);
      camera.getProjectionMatrix(true);
      internals.weaponCamera.getViewMatrix(true);
      internals.weaponCamera.getProjectionMatrix(true);
      const viewport = internals.weaponCamera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
      const identity = Matrix.Identity();
      const socketPixel = Vector3.Project(
        socket.getAbsolutePosition(),
        identity,
        internals.weaponCamera.getTransformationMatrix(),
        viewport,
      );
      const muzzle = manager.getMuzzleWorldPosition();
      expect(muzzle).not.toBeNull();
      const muzzlePixel = Vector3.Project(muzzle!, identity, camera.getTransformationMatrix(), viewport);

      expect(muzzlePixel.x).toBeCloseTo(socketPixel.x, 3);
      expect(muzzlePixel.y).toBeCloseTo(socketPixel.y, 3);
    } finally {
      manager.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it.each([-0.4, 0.4])("keeps the socket projection current after a same-frame yaw change of %s", (yaw) => {
    const engine = new NullEngine({
      renderWidth: 1280,
      renderHeight: 720,
      textureSize: 512,
      deterministicLockstep: false,
      lockstepMaxSteps: 4,
    });
    const scene = new Scene(engine);
    const camera = new FreeCamera("world", new Vector3(300, 80, -200), scene);
    camera.fov = 1.8;
    const manager = new WeaponViewManager();
    try {
      manager.init(scene, camera);
      const internals = manager as unknown as BeamRoutingInternals;
      const socket = new TransformNode("tag_flash", scene);
      socket.parent = internals.weaponRoot;
      socket.position.set(3, -2, 25);
      internals.muzzleSocket = socket;
      camera.getViewMatrix(true);
      camera.getProjectionMatrix(true);
      internals.weaponCamera.getViewMatrix(true);
      internals.weaponCamera.getProjectionMatrix(true);
      // Input and weapon sway change AFTER the preceding render, before effects
      // sample their muzzle. The helper must not use last frame's matrices.
      camera.rotation.set(0.25, yaw, 0.08);
      camera.position.addInPlaceFromFloats(4, 1, 2);
      internals.weaponRoot.position.set(2, -5, 8);
      internals.weaponCamera.fov = 0.9;
      const muzzle = manager.getMuzzleWorldPosition();
      camera.getViewMatrix(true);
      camera.getProjectionMatrix(true);
      internals.weaponCamera.getViewMatrix(true);
      internals.weaponCamera.getProjectionMatrix(true);
      socket.computeWorldMatrix(true);
      const viewport = camera.viewport.toGlobal(1280, 720);
      const expected = Vector3.Project(
        socket.getAbsolutePosition(),
        Matrix.Identity(),
        internals.weaponCamera.getTransformationMatrix(),
        viewport,
      );
      const actual = Vector3.Project(muzzle!, Matrix.Identity(), camera.getTransformationMatrix(), viewport);
      // Float32 world matrices at map coordinates lose tiny fractions of a pixel.
      expect(Math.abs(actual.x - expected.x)).toBeLessThan(0.05);
      expect(Math.abs(actual.y - expected.y)).toBeLessThan(0.05);
    } finally {
      manager.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("places the parented weapon camera at the world camera's eye", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("world", new Vector3(300, 80, -200), scene);
    camera.rotation.set(0.3, 0.8, 0);
    const manager = new WeaponViewManager();
    try {
      manager.init(scene, camera);
      const internals = manager as unknown as BeamRoutingInternals;
      camera.getViewMatrix(true);
      internals.weaponCamera.getViewMatrix(true);
      expect(Vector3.Distance(internals.weaponCamera.globalPosition, camera.globalPosition)).toBeLessThan(0.001);
    } finally {
      manager.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
