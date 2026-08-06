/**
 * Splashes and ripples (water Phase 3).
 *
 * The system owns transition detection so its callers do not have to. That is
 * the property worth protecting: the renderer reports a level every frame,
 * and only a change may produce a splash. Get it wrong and a player standing
 * in a pool emits a splash sixty times a second.
 */

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splashVolume } from "../../client/FPSLiquidAudio";
import { LiquidInteractionSystem, RING_POOL_SIZE } from "../client/LiquidInteractionSystem";

vi.mock("../../../../engine/AudioManager", () => ({
  AudioManager: {
    getInstance: () => ({
      playSfx2D: vi.fn(),
      playSfx3D: vi.fn(),
      preloadSfx: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

let engine: NullEngine;
let scene: Scene;
let system: LiquidInteractionSystem;

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  system = new LiquidInteractionSystem(scene);
});

afterEach(() => {
  system.dispose();
  scene.dispose();
  engine.dispose();
});

const at = (x = 0, y = 0, z = 0) => ({ x, y, z });
/** Fast enough that `splashVolume` is comfortably above its gate. */
const DIVING = -400;

describe("splashVolume", () => {
  it("is silent for a body drifting across the surface", () => {
    // Treading water crosses the line constantly. Without a gate the surface
    // would be a wall of splashes whenever anyone was near it.
    expect(splashVolume(0)).toBe(0);
    expect(splashVolume(20)).toBe(0);
  });

  it("scales with how hard the body hit", () => {
    expect(splashVolume(600)).toBeGreaterThan(splashVolume(100));
  });

  it("is the same falling or rising", () => {
    // Leaving the water fast is as loud as entering it fast.
    expect(splashVolume(-500)).toBe(splashVolume(500));
  });

  it("never exceeds full volume", () => {
    expect(splashVolume(50000)).toBeLessThanOrEqual(1);
  });
});

describe("transition detection", () => {
  it("splashes once on entering, not every frame after", () => {
    system.notify("p1", 0, "water", at(), DIVING, false);
    system.notify("p1", 2, "water", at(), DIVING, false);
    const afterEntry = system.activeRings;

    // Still swimming, reported every frame the way the renderer does.
    for (let i = 0; i < 30; i++) system.notify("p1", 2, "water", at(), DIVING, false);

    expect(afterEntry).toBe(1);
    expect(system.activeRings).toBe(1);
  });

  it("splashes again on leaving", () => {
    system.notify("p1", 0, "water", at(), DIVING, false);
    system.notify("p1", 3, "water", at(), DIVING, false);
    system.notify("p1", 0, "water", at(), DIVING, false);

    expect(system.activeRings).toBe(2);
  });

  it("ignores depth changes that do not cross the surface", () => {
    // Sinking from wading to submerged is not a crossing; the body was already
    // in the water and never broke the surface again.
    system.notify("p1", 0, "water", at(), DIVING, false);
    system.notify("p1", 1, "water", at(), DIVING, false);
    const afterEntry = system.activeRings;

    system.notify("p1", 2, "water", at(), DIVING, false);
    system.notify("p1", 3, "water", at(), DIVING, false);
    system.notify("p1", 1, "water", at(), DIVING, false);

    expect(system.activeRings).toBe(afterEntry);
  });

  it("tracks each body separately", () => {
    system.notify("p1", 0, "water", at(), DIVING, false);
    system.notify("p2", 0, "water", at(), DIVING, false);

    system.notify("p1", 2, "water", at(), DIVING, false);
    system.notify("p2", 2, "water", at(), DIVING, false);

    expect(system.activeRings).toBe(2);
  });

  it("does not splash for a body that starts in the water", () => {
    // A player who spawns or joins already submerged never crossed anything.
    // Their first report establishes a baseline rather than an event.
    system.notify("p1", 3, "water", at(), DIVING, false);

    expect(system.activeRings).toBe(0);
  });

  it("forgets a player who left, so their id cannot carry a stale level", () => {
    system.notify("p1", 0, "water", at(), DIVING, false);
    system.notify("p1", 2, "water", at(), DIVING, false);

    system.forget("p1");
    // Reusing the id: the first report is a baseline again, not an exit.
    system.notify("p1", 0, "water", at(), DIVING, false);

    expect(system.activeRings).toBe(1);
  });

  it("leaves no ring for a gentle crossing", () => {
    system.notify("p1", 0, "water", at(), 0, false);
    system.notify("p1", 2, "water", at(), 5, false);

    expect(system.activeRings).toBe(0);
  });
});

describe("ring pooling", () => {
  it("never allocates beyond the pool", () => {
    for (let i = 0; i < RING_POOL_SIZE * 3; i++) {
      system.notify(`p${i}`, 0, "water", at(), DIVING, false);
      system.notify(`p${i}`, 2, "water", at(), DIVING, false);
    }

    expect(system.activeRings).toBeLessThanOrEqual(RING_POOL_SIZE);
  });

  it("registers one render observer however many splashes there are", () => {
    const before = scene.onBeforeRenderObservable.observers.length;

    for (let i = 0; i < 20; i++) {
      system.notify(`p${i}`, 0, "water", at(), DIVING, false);
      system.notify(`p${i}`, 2, "water", at(), DIVING, false);
    }

    expect(scene.onBeforeRenderObservable.observers.length).toBe(before + 1);
  });

  it("costs nothing per frame before the first splash", () => {
    const before = scene.onBeforeRenderObservable.observers.length;

    system.notify("p1", 0, "water", at(), DIVING, false);
    system.notify("p1", 0, "water", at(), DIVING, false);

    expect(scene.onBeforeRenderObservable.observers.length).toBe(before);
  });

  it("disposes its meshes and forgets its bodies", () => {
    system.notify("p1", 0, "water", at(), DIVING, false);
    system.notify("p1", 2, "water", at(), DIVING, false);
    const meshCount = scene.meshes.length;
    expect(meshCount).toBeGreaterThan(0);

    system.dispose();

    expect(system.activeRings).toBe(0);
    expect(scene.meshes.length).toBeLessThan(meshCount);
  });

  it("is idempotent on dispose", () => {
    system.notify("p1", 0, "water", at(), DIVING, false);
    system.notify("p1", 2, "water", at(), DIVING, false);
    system.dispose();

    expect(() => system.dispose()).not.toThrow();
  });
});
