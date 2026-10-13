import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FirstPersonPose } from "../../../../engine/camera/FirstPersonPose";
import { createNeutralDelta } from "../../../../engine/viewport/ViewportDelta";
import { SpectateEyeCamera } from "../SpectateEyeCamera";

const standing: FirstPersonPose = { x: 100, y: 84, z: 200, yaw: 1, pitch: 0.2 };

describe("SpectateEyeCamera", () => {
  let engine: NullEngine;
  let scene: Scene;
  let camera: FreeCamera;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    camera = new FreeCamera("fps", Vector3.Zero(), scene);
  });
  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  it("does not touch the camera until it is started", () => {
    const eye = new SpectateEyeCamera();

    expect(eye.update(0.016, camera)).toBe(false);
    expect(camera.position.equals(Vector3.Zero())).toBe(true);
  });

  it("puts the camera at the watched player's eyes, looking where they look", () => {
    const eye = new SpectateEyeCamera();
    eye.start(() => standing);

    expect(eye.update(0.016, camera)).toBe(true);
    expect([camera.position.x, camera.position.y, camera.position.z]).toEqual([100, 84, 200]);
    expect(camera.rotation.y).toBe(standing.yaw);
    expect(camera.rotation.x).toBe(standing.pitch);
  });

  it("never inherits roll", () => {
    const eye = new SpectateEyeCamera();
    // The FPS controller writes its death tilt into this same camera before we
    // run. Leaving it is a screen stuck permanently sideways.
    camera.rotation.z = 0.7;
    eye.start(() => standing);
    eye.update(0.016, camera);

    expect(camera.rotation.z).toBe(0);
  });

  it("follows each sample exactly: the sample is already interpolated", () => {
    const eye = new SpectateEyeCamera();
    let pose = { ...standing };
    eye.start(() => pose);
    eye.update(0.016, camera);

    pose = { ...standing, x: standing.x + 60, yaw: -3 };
    eye.update(0.016, camera);
    expect(camera.position.x).toBe(pose.x);
    expect(camera.rotation.y).toBe(-3);
  });

  it("lays their screen's effects over the pose", () => {
    const eye = new SpectateEyeCamera();
    const effects = createNeutralDelta();
    effects.positionOffset.set(0, -4, 0);
    effects.rotationOffset.set(0, 0, 2);
    effects.fovMultiplier = 1.2;
    eye.start(() => ({ ...standing, effects }));
    eye.update(0.016, camera);

    expect(camera.position.y).toBeCloseTo(standing.y - 4);
    expect(camera.rotation.z).toBeCloseTo((2 * Math.PI) / 180);
    expect(camera.fov).toBeGreaterThan(1);
  });

  it("holds the last good frame when the target leaves PVS", () => {
    const eye = new SpectateEyeCamera();
    let pose: FirstPersonPose | null = { ...standing };
    eye.start(() => pose);
    eye.update(0.016, camera);
    const held = camera.position.clone();

    // Releasing the camera for the one frame a snapshot is missing would show
    // a flash of whatever the fallback camera does, then snap back.
    pose = null;
    expect(eye.update(0.016, camera)).toBe(true);
    expect(camera.position.equals(held)).toBe(true);
  });

  it("claims the very first frame when seeded, and every frame after", () => {
    const eye = new SpectateEyeCamera();
    // Declining a frame is not neutral: the FPS controller falls back to the
    // forty-degree death tilt when nothing claims the camera, so a spectate
    // that could not produce a frame looked like the screen was stuck sideways.
    eye.start(() => null, standing);

    for (let i = 0; i < 10; i++) expect(eye.update(0.016, camera)).toBe(true);
    expect(camera.position.y).toBe(standing.y);
    expect(camera.rotation.z).toBe(0);
  });

  it("refuses a pose that would put the camera nowhere", () => {
    const eye = new SpectateEyeCamera();
    eye.start(() => ({ ...standing, x: Number.NaN }), { ...standing, y: Number.POSITIVE_INFINITY });

    // Nothing usable — hand the view back rather than write a NaN into the
    // camera, which poisons every matrix downstream of it.
    expect(eye.update(0.016, camera)).toBe(false);
    expect(Number.isNaN(camera.position.x)).toBe(false);
  });

  it("forgets the last target on stop", () => {
    const eye = new SpectateEyeCamera();
    eye.start(() => standing);
    eye.update(0.016, camera);

    eye.stop();
    expect(eye.isActive).toBe(false);

    const elsewhere = { x: -900, y: 12, z: 40, yaw: -2, pitch: 0 };
    eye.start(() => elsewhere);
    eye.update(0.016, camera);
    expect(camera.position.x).toBe(elsewhere.x);
  });
});
