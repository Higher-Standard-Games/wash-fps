/**
 * What the underwater view has to give back.
 *
 * It borrows two pieces of global state to do its job: the scene's fog, and
 * the camera's field of view. Cameras outlive maps — the next map is handed
 * the same camera object — so anything not restored is not a glitch that ends
 * with the map, it is a permanent change to the session.
 *
 * The FOV was the one that got away. `dispose()` restored fog and returned,
 * so unloading a map while submerged left the warp applied for good, and every
 * map after it rendered at a field of view nobody chose.
 */

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { UnderwaterView } from "../client/UnderwaterView";

let engine: NullEngine;
let scene: Scene;
let view: UnderwaterView;
let camera: FreeCamera;

/** Submerged everywhere: every probe reports water. */
const submerged = { pointContents: () => 2 /* Contents.WATER */ };
/** Dry everywhere. */
const dry = { pointContents: () => 0 };

const AUTHORED_FOV = 1.2;

beforeEach(() => {
  // Without this the comfort setting reads 0, the warp is identically zero,
  // and a test asserting the FOV was restored would pass by never moving it.
  Cvar.register("r_underwater_distortion", 1);
  Cvar.set("r_underwater_distortion", 1);

  engine = new NullEngine();
  scene = new Scene(engine);
  camera = new FreeCamera("eye", new Vector3(0, 0, 0), scene);
  camera.fov = AUTHORED_FOV;
  view = new UnderwaterView(scene);
});

afterEach(() => {
  view.dispose();
  scene.dispose();
  engine.dispose();
});

/** Drive enough steps for submersion to approach 1. */
function submerge(): void {
  view.setCollisionWorld(submerged);
  for (let i = 0; i < 60; i++) view.update(camera, 1 / 60);
}

describe("field of view", () => {
  it("warps it while submerged", () => {
    submerge();

    expect(camera.fov).not.toBe(AUTHORED_FOV);
  });

  it("puts it back on dispose", () => {
    // The bug: a map unloaded while the player was underwater.
    submerge();
    expect(camera.fov).not.toBe(AUTHORED_FOV);

    view.dispose();

    expect(camera.fov).toBe(AUTHORED_FOV);
  });

  it("follows a zoom made underwater instead of freezing the dive's FOV", () => {
    submerge();
    // The FPS controller writes the zoomed FOV before each render.
    const ZOOMED = 0.6;
    for (let i = 0; i < 30; i++) {
      camera.fov = ZOOMED;
      view.update(camera, 1 / 60);
    }
    // Captured once at the dive, the base put the old FOV back every frame (E7).
    expect(Math.abs(camera.fov - ZOOMED)).toBeLessThan(0.2);

    // With no controller writing (free-fly), the warp still oscillates around one base.
    const samples: number[] = [];
    for (let i = 0; i < 240; i++) {
      view.update(camera, 1 / 60);
      samples.push(camera.fov);
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(Math.abs(mean - ZOOMED)).toBeLessThan(0.05);
  });

  it("puts it back on surfacing, as before", () => {
    submerge();
    view.setCollisionWorld(dry);
    for (let i = 0; i < 120; i++) view.update(camera, 1 / 60);

    expect(camera.fov).toBe(AUTHORED_FOV);
  });

  it("restores every camera it warped, not just the last", () => {
    // Dying underwater swaps in the death camera mid-submersion; both were
    // warped and both have to be handed back.
    const second = new FreeCamera("death", new Vector3(0, 0, 0), scene);
    second.fov = 0.9;

    view.setCollisionWorld(submerged);
    for (let i = 0; i < 30; i++) view.update(camera, 1 / 60);
    for (let i = 0; i < 30; i++) view.update(second, 1 / 60);

    view.dispose();

    expect(camera.fov).toBe(AUTHORED_FOV);
    expect(second.fov).toBe(0.9);
  });

  it("leaves a camera it never warped alone", () => {
    const untouched = new FreeCamera("spare", new Vector3(0, 0, 0), scene);
    untouched.fov = 0.75;

    submerge();
    view.dispose();

    expect(untouched.fov).toBe(0.75);
  });

  it("is idempotent", () => {
    submerge();
    view.dispose();

    expect(() => view.dispose()).not.toThrow();
    expect(camera.fov).toBe(AUTHORED_FOV);
  });

  it("does not drift across repeated dives", () => {
    // Each dive re-reads the authored FOV, so a session of diving in and out
    // must not accumulate an offset.
    for (let i = 0; i < 3; i++) {
      submerge();
      view.setCollisionWorld(dry);
      for (let j = 0; j < 120; j++) view.update(camera, 1 / 60);
    }

    expect(camera.fov).toBe(AUTHORED_FOV);
  });
});

describe("scene fog", () => {
  it("puts it back on dispose", () => {
    const mode = scene.fogMode;
    const density = scene.fogDensity;

    submerge();
    view.dispose();

    expect(scene.fogMode).toBe(mode);
    expect(scene.fogDensity).toBe(density);
  });
});
