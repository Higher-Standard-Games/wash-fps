import { Ray } from "@babylonjs/core/Culling/ray";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { DeathCamera, type DeathCameraTarget } from "../DeathCamera";

function makeCamera(scene?: Scene): DeathCameraTarget & { target: Vector3 } {
  return {
    position: new Vector3(0, 0, 0),
    target: new Vector3(0, 0, 0),
    setTarget(target: Vector3): void {
      this.target.copyFrom(target);
    },
    getScene: scene ? () => scene : undefined,
  };
}

describe("DeathCamera", () => {
  it("owns the camera and eases toward a live corpse target", () => {
    const deathCamera = new DeathCamera();
    const camera = makeCamera();
    const target = new Vector3(10, 0, 20);

    deathCamera.start(() => target, Vector3.Zero(), 0);
    expect(deathCamera.update(1, camera)).toBe(true);

    expect(camera.position.x).toBeGreaterThan(9);
    expect(camera.position.y).toBeCloseTo(110, 4);
    expect(camera.position.z).toBeGreaterThan(-132);
    expect(camera.target.x).toBeGreaterThan(9);
    expect(camera.target.y).toBeCloseTo(25, 4);
    expect(camera.target.z).toBeGreaterThan(19);
  });

  it("ignores escaped targets below the death floor", () => {
    const deathCamera = new DeathCamera();
    const camera = makeCamera();
    const deathPos = new Vector3(0, 100, 0);

    deathCamera.start(() => new Vector3(0, -500, 0), deathPos, 0);
    expect(deathCamera.update(10, camera)).toBe(true);

    expect(camera.position.y).toBeGreaterThanOrEqual(118);
    expect(camera.target.y).toBeGreaterThanOrEqual(108);
    expect(camera.position.z).toBeCloseTo(-150, 1);
  });

  it("pulls the camera in front of map geometry between corpse and desired view", () => {
    const deathCamera = new DeathCamera();
    const fakeScene = {
      pickWithRay(ray: Ray): { hit: boolean; pickedPoint: Vector3 } {
        return { hit: true, pickedPoint: ray.origin.add(ray.direction.scale(80)) };
      },
    } as unknown as Scene;
    const camera = makeCamera(fakeScene);

    deathCamera.start(() => Vector3.Zero(), Vector3.Zero(), 0);
    expect(deathCamera.update(10, camera)).toBe(true);

    expect(camera.position.z).toBeGreaterThan(-80);
    expect(camera.position.y).toBeGreaterThanOrEqual(18);
  });

  it("releases camera ownership when stopped", () => {
    const deathCamera = new DeathCamera();
    const camera = makeCamera();

    deathCamera.start(() => Vector3.Zero(), Vector3.Zero(), 0);
    expect(deathCamera.update(0.016, camera)).toBe(true);

    deathCamera.stop();
    expect(deathCamera.update(0.016, camera)).toBe(false);
  });
});
