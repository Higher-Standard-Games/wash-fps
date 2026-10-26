/**
 * A ragdoll lives by the clock it is handed. Live, that is frame time; in a
 * demo it is the playhead, so a paused demo holds every body where it lies
 * and slow motion lets them fall slowly, instead of wall time running them
 * out underneath playback.
 */

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Havok's wasm does not load under Node; these tests drive no physics.
vi.mock("../../../../engine/physics/PhysicsSystem", () => ({
  PhysicsSystem: { getInstance: () => ({ isInitialized: () => true }) },
}));

const { RagdollSystem } = await import("../RagdollSystem");

let engine: NullEngine;
let scene: Scene;
beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
});
afterEach(() => {
  scene.dispose();
  engine.dispose();
});

/**
 * A stand-in active ragdoll: what update() reads and disposeRagdoll() touches.
 * `hips` is where its hips are reported; null reports none, so it never rests.
 */
function body(hips: () => Vector3 | null = () => null) {
  const mesh = { visibility: 1, getChildMeshes: () => [] };
  return {
    model: { mesh, anchor: { getAbsolutePosition: () => ({ x: 1, y: 2, z: 3 }) }, id: "player_2" },
    ragdoll: {
      dispose: vi.fn(),
      getAggregate: () => {
        const position = hips();
        return position ? { body: { transformNode: { getAbsolutePosition: () => position } } } : null;
      },
    },
    age: 0,
    disposed: false,
    restAnchor: null,
    restSeconds: 0,
    fadeStart: null,
    trail: null,
    trailMat: null,
  };
}

describe("ragdoll clock", () => {
  it("ages only by the time it is handed, and bursts at the end of its life", () => {
    const system = RagdollSystem.create(scene);
    const burst = vi.fn();
    system.setGibCallback(burst);
    const one = body();
    (system as unknown as { ragdolls: unknown[] }).ragdolls.push(one);

    // A paused demo hands no time: nothing moves on.
    for (let i = 0; i < 100; i++) system.update(0);
    expect(one.age).toBe(0);
    expect(one.model.mesh.visibility).toBe(1);

    // Into its last second it fades; at five it bursts into gibs where it lies.
    system.update(4.5);
    expect(one.model.mesh.visibility).toBeCloseTo(0.5);
    system.update(0.5);
    expect(one.disposed).toBe(true);
    expect(burst).toHaveBeenCalledWith(1, 2, 3, 0, 0, 0);
    expect(one.ragdoll.dispose).toHaveBeenCalledOnce();
    system.dispose();
  });

  it("fades out and bursts once the body has come to rest, well before its five seconds", () => {
    const system = RagdollSystem.create(scene);
    const burst = vi.fn();
    system.setGibCallback(burst);
    // Rolling in a corner: the hips keep moving, but stay within a few units.
    let frame = 0;
    const one = body(() => new Vector3(100 + (frame % 2) * 4, 20, 50));
    (system as unknown as { ragdolls: unknown[] }).ragdolls.push(one);

    const step = (seconds: number) => {
      for (let t = 0; t < seconds; t += 0.05) {
        frame++;
        system.update(0.05);
      }
    };
    // Still flying for the first half second: never judged at rest.
    step(0.5);
    expect(one.fadeStart).toBeNull();
    // Rests for 0.4 s, then fades over a second and bursts.
    step(0.5);
    expect(one.fadeStart).not.toBeNull();
    step(1.1);
    expect(one.disposed).toBe(true);
    expect(one.age).toBeLessThan(2.5);
    expect(burst).toHaveBeenCalledOnce();
    system.dispose();
  });

  it("keeps simulating while the body is still travelling", () => {
    const system = RagdollSystem.create(scene);
    let x = 0;
    const one = body(() => {
      x += 20;
      return new Vector3(x, 20, 0);
    });
    (system as unknown as { ragdolls: unknown[] }).ragdolls.push(one);
    for (let i = 0; i < 60; i++) system.update(0.05);
    expect(one.fadeStart).toBeNull();
    expect(one.disposed).toBe(false);
    system.dispose();
  });

  it("a demo's own instance is not the live one", () => {
    expect(RagdollSystem.create(scene)).not.toBe(RagdollSystem.getInstance());
  });
});
