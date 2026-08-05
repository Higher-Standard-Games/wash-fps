import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_VIEWHEIGHT } from "../../../../engine/physics/PlayerPhysicsConstants";
import { SpectateEyeCamera, type SpectateEyeSample } from "../SpectateEyeCamera";

/** A stand-in for the Babylon FreeCamera the FPS controller hands us. */
function fakeCamera(): { position: Vector3; rotation: Vector3 } {
  return { position: new Vector3(), rotation: new Vector3() };
}

const standing: SpectateEyeSample = { x: 100, y: 50, z: 200, yaw: 1, pitch: 0.2 };

describe("SpectateEyeCamera", () => {
  let camera: ReturnType<typeof fakeCamera>;

  beforeEach(() => {
    camera = fakeCamera();
  });

  it("does not touch the camera until it is started", () => {
    const eye = new SpectateEyeCamera();

    expect(eye.update(0.016, camera)).toBe(false);
    expect(camera.position.equals(Vector3.Zero())).toBe(true);
  });

  it("puts the camera at the watched player's eyes, not behind them", () => {
    const eye = new SpectateEyeCamera();
    eye.start(() => standing);

    expect(eye.update(0.016, camera)).toBe(true);
    // First frame snaps: the eye is directly above the origin, offset by the
    // view height. A third-person chase would sit metres away on the XZ plane.
    expect(camera.position.x).toBe(standing.x);
    expect(camera.position.z).toBe(standing.z);
    expect(camera.position.y).toBe(standing.y + DEFAULT_VIEWHEIGHT);
  });

  it("looks where they are looking", () => {
    const eye = new SpectateEyeCamera();
    eye.start(() => standing);
    eye.update(0.016, camera);

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

  it("drops to the crouched eye height when they duck", () => {
    const eye = new SpectateEyeCamera();
    eye.start(() => ({ ...standing, eyeHeight: DEFAULT_VIEWHEIGHT - 20 }));
    eye.update(0.016, camera);

    expect(camera.position.y).toBe(standing.y + DEFAULT_VIEWHEIGHT - 20);
  });

  it("eases toward a moving target rather than snapping each frame", () => {
    const eye = new SpectateEyeCamera();
    let sample = { ...standing };
    eye.start(() => sample);
    eye.update(0.016, camera);

    // A stride, not a teleport.
    sample = { ...standing, x: standing.x + 60 };
    eye.update(0.016, camera);

    expect(camera.position.x).toBeGreaterThan(standing.x);
    expect(camera.position.x).toBeLessThan(sample.x);
  });

  it("cuts instead of flying when the target teleports", () => {
    const eye = new SpectateEyeCamera();
    let sample = { ...standing };
    eye.start(() => sample);
    eye.update(0.016, camera);

    sample = { ...standing, x: standing.x + 5000 };
    eye.update(0.016, camera);

    expect(camera.position.x).toBe(sample.x);
  });

  it("takes the short way round when their yaw wraps past pi", () => {
    const eye = new SpectateEyeCamera();
    let sample = { ...standing, yaw: Math.PI - 0.05 };
    eye.start(() => sample);
    eye.update(0.016, camera);

    // Turning right through the wrap point. Lerping the raw difference would
    // spin the view the long way round the compass.
    sample = { ...sample, yaw: -Math.PI + 0.05 };
    eye.update(0.016, camera);

    expect(camera.rotation.y).toBeGreaterThan(Math.PI - 0.05);
  });

  it("holds the last good frame when the target leaves PVS", () => {
    const eye = new SpectateEyeCamera();
    let sample: SpectateEyeSample | null = { ...standing };
    eye.start(() => sample);
    eye.update(0.016, camera);
    const held = camera.position.clone();

    // Releasing the camera for the one frame a snapshot is missing would show
    // a flash of whatever the fallback camera does, then snap back.
    sample = null;
    expect(eye.update(0.016, camera)).toBe(true);
    expect(camera.position.equals(held)).toBe(true);
  });

  it("refuses a sample that would put the camera nowhere", () => {
    const eye = new SpectateEyeCamera();
    eye.start(() => ({ ...standing, x: Number.NaN }));

    // Nothing primed and nothing usable — hand the view back rather than write
    // a NaN into the camera, which poisons every matrix downstream of it.
    expect(eye.update(0.016, camera)).toBe(false);
    expect(Number.isNaN(camera.position.x)).toBe(false);
  });

  it("re-snaps after a stop and start, so a new target does not fly in", () => {
    const eye = new SpectateEyeCamera();
    eye.start(() => standing);
    eye.update(0.016, camera);

    eye.stop();
    expect(eye.isActive).toBe(false);

    const elsewhere = { x: -900, y: 12, z: 40, yaw: -2, pitch: 0 };
    eye.start(() => elsewhere);
    eye.update(0.016, camera);

    expect(camera.position.x).toBe(elsewhere.x);
    expect(camera.position.z).toBe(elsewhere.z);
  });
});
