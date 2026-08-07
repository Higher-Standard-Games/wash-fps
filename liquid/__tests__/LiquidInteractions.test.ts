/**
 * Splashes and ripples (water Phase 3).
 *
 * The system owns transition detection so its callers do not have to. That is
 * the property worth protecting: the renderer reports a level every frame,
 * and only a change may produce a splash. Get it wrong and a player standing
 * in a pool emits a splash sixty times a second.
 */

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splashVolume } from "../../client/FPSLiquidAudio";
import { LiquidInteractionSystem, RING_END_RADIUS, RING_POOL_SIZE } from "../client/LiquidInteractionSystem";

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

describe("rings belong to the surface, not to the swimmer", () => {
  /** A pool filling y <= 56 inside a 200-unit square, dry everywhere else. */
  const pool = {
    pointContents: (p: { x: number; y: number; z: number }) =>
      p.y <= 56 && Math.abs(p.x) <= 200 && Math.abs(p.z) <= 200 ? 2 /* Contents.WATER */ : 0,
  };

  it("draws at the waterline, not at the body", () => {
    // Climbing out puts the body on the bank, several units above the water.
    // A ring drawn there floats over dry land, which is what it did.
    system.setCollisionWorld(pool);
    system.notify("p1", 2, "water", at(0, 40, 0), DIVING, true);
    system.notify("p1", 0, "water", at(0, 80, 0), DIVING, true);

    expect(system.activeRings).toBe(1);
    expect(system.lastRingY).not.toBeNull();
    // Within a probe step of the real surface, never up at the body.
    expect(system.lastRingY ?? 0).toBeLessThan(60);
    expect(system.lastRingY ?? 0).toBeGreaterThan(50);
  });

  it("draws nothing when there is no surface anywhere near", () => {
    // A crossing reported for a body nowhere near liquid — a teleport, or a
    // respawn that slipped past forget(). Better no ring than one at an
    // invented height.
    system.setCollisionWorld(pool);
    system.notify("p1", 2, "water", at(5000, 5000, 5000), DIVING, true);
    system.notify("p1", 0, "water", at(5000, 5000, 5000), DIVING, true);

    expect(system.activeRings).toBe(0);
  });

  it("stops the ring at the edge of the pool", () => {
    // Splash near a bank: the ring may not spread out over the dry floor.
    system.setCollisionWorld(pool);
    system.notify("p1", 0, "water", at(190, 50, 0), DIVING, true);
    system.notify("p1", 2, "water", at(190, 50, 0), DIVING, true);

    expect(system.activeRings).toBe(1);
    // 10 units from the edge, so the ring cannot reach its full 62.
    expect(system.lastRingMaxRadius).toBeLessThan(RING_END_RADIUS);
  });

  it("uses the full radius in open water", () => {
    system.setCollisionWorld(pool);
    system.notify("p1", 0, "water", at(0, 50, 0), DIVING, true);
    system.notify("p1", 2, "water", at(0, 50, 0), DIVING, true);

    expect(system.lastRingMaxRadius).toBe(RING_END_RADIUS);
  });
});

describe("projectiles entering liquid", () => {
  /** A pool filling y <= 56 inside a 200-unit square, dry everywhere else. */
  const pool = {
    pointContents: (p: { x: number; y: number; z: number }) =>
      p.y <= 56 && Math.abs(p.x) <= 200 && Math.abs(p.z) <= 200 ? 2 /* Contents.WATER */ : 0,
  };

  it("splashes when a rocket crosses the surface", () => {
    // Water is NONSOLID, so nothing impacts it and the ordinary hit event
    // never fires — a shot into a pool landed in silence.
    system.setCollisionWorld(pool);
    system.notifyProjectile("proj_1", at(0, 80, 0), 1400);
    system.notifyProjectile("proj_1", at(0, 40, 0), 1400);

    expect(system.activeRings).toBe(1);
  });

  it("splashes once, not every frame it stays under", () => {
    system.setCollisionWorld(pool);
    system.notifyProjectile("proj_1", at(0, 80, 0), 1400);
    system.notifyProjectile("proj_1", at(0, 40, 0), 1400);

    for (let i = 0; i < 20; i++) system.notifyProjectile("proj_1", at(0, 20, 0), 1400);

    expect(system.activeRings).toBe(1);
  });

  it("does not splash for one spawned already in the water", () => {
    // Its first sighting is a baseline, exactly as a body's is.
    system.setCollisionWorld(pool);
    system.notifyProjectile("proj_1", at(0, 40, 0), 1400);

    expect(system.activeRings).toBe(0);
  });

  it("does not splash for one that never touches liquid", () => {
    system.setCollisionWorld(pool);
    system.notifyProjectile("proj_1", at(0, 400, 0), 1400);
    system.notifyProjectile("proj_1", at(0, 380, 0), 1400);

    expect(system.activeRings).toBe(0);
  });

  it("does not splash on the way back out", () => {
    // A projectile leaving the water is not an impact — it is already spent,
    // and a second ring would read as a second shot.
    system.setCollisionWorld(pool);
    system.notifyProjectile("proj_1", at(0, 80, 0), 1400);
    system.notifyProjectile("proj_1", at(0, 40, 0), 1400);
    system.notifyProjectile("proj_1", at(0, 80, 0), 1400);

    expect(system.activeRings).toBe(1);
  });

  it("forgets a despawned projectile, so a recycled id starts clean", () => {
    system.setCollisionWorld(pool);
    system.notifyProjectile("proj_1", at(0, 80, 0), 1400);
    system.notifyProjectile("proj_1", at(0, 40, 0), 1400);
    system.forgetProjectile("proj_1");

    // Same id reused by a new rocket, already submerged: a baseline, not a hit.
    system.notifyProjectile("proj_1", at(0, 40, 0), 1400);

    expect(system.activeRings).toBe(1);
  });

  it("does nothing without a collision world", () => {
    system.notifyProjectile("proj_1", at(0, 80, 0), 1400);
    system.notifyProjectile("proj_1", at(0, 40, 0), 1400);

    expect(system.activeRings).toBe(0);
  });
});

describe("Epic splash crowns", () => {
  /** A pool filling y <= 56 inside a 200-unit square, dry everywhere else. */
  const pool = {
    pointContents: (p: { x: number; y: number; z: number }) =>
      p.y <= 56 && Math.abs(p.x) <= 200 && Math.abs(p.z) <= 200 ? 2 /* Contents.WATER */ : 0,
  };

  const camera = () => new FreeCamera("test-cam", new Vector3(0, 100, -200), scene);

  it("allocates nothing until asked", () => {
    // The whole point of the tier gate: Low and Medium must not pay for a
    // fluid renderer they will never draw with.
    system.setCollisionWorld(pool);
    system.notify("p1", 0, "water", at(0, 50, 0), DIVING, true);
    system.notify("p1", 2, "water", at(0, 50, 0), DIVING, true);

    expect(system.crownsEnabled).toBe(false);
    expect(scene.fluidRenderer).toBeFalsy();
    expect(system.activeDroplets).toBe(0);
  });

  it("still draws the ordinary ring at Low", () => {
    // Degrading must lose the crown, never the splash.
    system.setCollisionWorld(pool);
    system.notify("p1", 0, "water", at(0, 50, 0), DIVING, true);
    system.notify("p1", 2, "water", at(0, 50, 0), DIVING, true);

    expect(system.activeRings).toBe(1);
  });

  it("throws spray once enabled", () => {
    system.enableCrowns(camera());
    system.setCollisionWorld(pool);
    system.notify("p1", 0, "water", at(0, 50, 0), DIVING, true);
    system.notify("p1", 2, "water", at(0, 50, 0), DIVING, true);

    expect(system.activeDroplets).toBeGreaterThan(0);
    // And the ring is still there — the crown is added to the splash, not
    // swapped in for it.
    expect(system.activeRings).toBe(1);
  });

  it("throws a bigger crown for a harder entry", () => {
    // Both sides must be real crossings. Comparing a crossing against a
    // baseline-only report compares a crown against zero and passes whatever
    // the tuning does.
    const crownFor = (speed: number): number => {
      const fresh = new LiquidInteractionSystem(scene);
      fresh.enableCrowns(camera());
      fresh.setCollisionWorld(pool);
      fresh.notify("p1", 0, "water", at(0, 50, 0), speed, true);
      fresh.notify("p1", 2, "water", at(0, 50, 0), speed, true);
      const droplets = fresh.activeDroplets;
      expect(droplets).toBeGreaterThan(0);
      fresh.dispose();
      return droplets;
    };

    expect(crownFor(-2000)).toBeGreaterThan(crownFor(-150));
  });

  it("does not throw spray from lava or slime", () => {
    // Thick liquids do not crown, and a pale spray over lava would read as
    // steam that is not there.
    const lavaPool = {
      pointContents: (p: { x: number; y: number; z: number }) => (p.y <= 56 ? 4 /* Contents.LAVA */ : 0),
    };
    system.enableCrowns(camera());
    system.setCollisionWorld(lavaPool);
    system.notify("p1", 0, "lava", at(0, 50, 0), DIVING, true);
    system.notify("p1", 2, "lava", at(0, 50, 0), DIVING, true);

    expect(system.activeRings).toBe(1);
    expect(system.activeDroplets).toBe(0);
  });

  it("is idempotent, so a second call does not stack a second renderer", () => {
    const cam = camera();

    expect(system.enableCrowns(cam)).toBe(true);
    expect(system.enableCrowns(cam)).toBe(true);
    expect(system.crownsEnabled).toBe(true);
  });

  it("releases the fluid renderer on dispose", () => {
    // Babylon does not dispose the particle object behind a render object, so
    // a map change with this wrong leaks a buffer per map.
    system.enableCrowns(camera());
    system.setCollisionWorld(pool);
    system.notify("p1", 0, "water", at(0, 50, 0), DIVING, true);
    system.notify("p1", 2, "water", at(0, 50, 0), DIVING, true);

    system.dispose();

    expect(system.crownsEnabled).toBe(false);
    expect(system.activeDroplets).toBe(0);
  });

  it("can be turned off and back on without leaking state", () => {
    const cam = camera();
    system.enableCrowns(cam);
    system.setCollisionWorld(pool);
    system.notify("p1", 0, "water", at(0, 50, 0), DIVING, true);
    system.notify("p1", 2, "water", at(0, 50, 0), DIVING, true);
    expect(system.activeDroplets).toBeGreaterThan(0);

    system.disableCrowns();
    expect(system.activeDroplets).toBe(0);

    system.enableCrowns(cam);
    expect(system.activeDroplets).toBe(0);
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
