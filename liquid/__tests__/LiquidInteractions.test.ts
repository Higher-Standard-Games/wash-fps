/**
 * Splashes and ripples (water Phase 3).
 *
 * The system owns transition detection so its callers do not have to. That is
 * the property worth protecting: the renderer reports a level every frame,
 * and only a change may produce a splash. Get it wrong and a player standing
 * in a pool emits a splash sixty times a second.
 */

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiquidSurfaceSystem } from "../../../../engine/rendering/water/LiquidSurfaceSystem";
import { waterDisturbancesFor } from "../../../../engine/rendering/water/WaterDisturbances";
import { Contents } from "../../../../shared/collision/CollisionWorld";
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
  vi.restoreAllMocks();
  system.dispose();
  scene.dispose();
  engine.dispose();
});

const at = (x = 0, y = 0, z = 0) => ({ x, y, z });
/** Fast enough that `splashVolume` is comfortably above its gate. */
const DIVING = -400;

describe("replacement surface integration", () => {
  it("snaps a gameplay splash to render geometry without allocating the legacy disc", () => {
    const pool = CreateGround("pool", { width: 200, height: 200 }, scene);
    pool.position.y = 56;
    pool.metadata = { liquidKind: "water" };
    const renderer = new LiquidSurfaceSystem(scene);
    renderer.claim(pool);
    system.setCollisionWorld({ pointContents: (p) => (p.y < 56 ? Contents.WATER : 0) });
    try {
      system.notify("player", 0, "water", at(0, 72), DIVING, true);
      system.notify("player", 2, "water", at(0, 72), DIVING, true);
      const waves = waterDisturbancesFor(scene);
      expect(waves.impulses).toHaveLength(1);
      expect(waves.impulses[0]).toMatchObject({ y: 56, age: 0 });
      expect(waves.impulses[0].radius).toBeCloseTo(48 + 64 * splashVolume(DIVING));
      expect(waves.accepted).toBe(1);
      expect(system.activeRings).toBe(0);
      expect(scene.meshes.some((m) => m.name.startsWith("liquid-ring"))).toBe(false);
      waves.update(2);
      expect(waves.impulses).toHaveLength(0);
      expect(waves.accepted).toBe(1); // Delivery remains inspectable after the ripple expires.
    } finally {
      renderer.dispose();
    }
  });

  it("retains the legacy ring when no supported render patch accepts the splash", () => {
    const waves = waterDisturbancesFor(scene);
    waves.resolveSurface = () => null;
    system.notify("player", 0, "water", at(), DIVING, false);
    system.notify("player", 2, "water", at(), DIVING, false);
    expect(system.activeRings).toBe(1);
    expect(waves.impulses).toHaveLength(0);
    expect(waves.rejected).toBe(1);
    expect(waves.lastResult).toContain("no supported water surface");
  });
});

describe("reactive shader wakes", () => {
  it("makes swimming wakes broader/stronger than wading and suppresses submerged motion", () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const waves = waterDisturbancesFor(scene);
    waves.resolveSurface = (p) => ({ ...p, y: 56 });
    for (const level of [1, 2, 3] as const) {
      system.notify(String(level), level, "water", at(), 0, true);
      clock += 150;
      system.notify(String(level), level, "water", at(30), 0, true);
    }
    expect(waves.impulses).toHaveLength(2);
    expect(waves.impulses[1].radius).toBeGreaterThan(waves.impulses[0].radius);
    expect(waves.impulses[1].strength).toBeGreaterThan(waves.impulses[0].strength);
  });

  it("does not convert cancelling movement jitter into a radial splash", () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const waves = waterDisturbancesFor(scene);
    system.notify("jitter", 2, "water", at(), 0, true);
    clock = 60;
    system.notify("jitter", 2, "water", at(4), 0, true);
    clock = 150;
    system.notify("jitter", 2, "water", at(), 0, true);
    expect(waves.impulses).toHaveLength(0);
  });
  it("emits comparable wakes when movement per frame is below half a unit", () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const waves = waterDisturbancesFor(scene);
    waves.resolveSurface = (p) => ({ ...p, y: 56 });
    for (const fps of [60, 1000]) {
      const count = waves.impulses.length;
      const start = clock;
      system.notify(String(fps), 2, "water", at(), 0, true);
      for (let frame = 1; frame <= fps / 2; frame++) {
        clock = start + (frame * 1000) / fps;
        system.notify(String(fps), 2, "water", at((frame * 200) / fps), 0, true);
      }
      expect(waves.impulses.length - count).toBeGreaterThanOrEqual(3);
      expect(waves.impulses.at(-1)!.strength).toBeCloseTo(0.4);
      expect(waves.impulses.at(-1)!.directionX).toBeCloseTo(1);
      expect(waves.impulses.at(-1)!.directionZ).toBeCloseTo(0);
      expect(Array.from(waves.pack(() => true)).slice(-2)).toEqual([0, 0]);
    }
  });
  it("rate-limits moving local and remote bodies and ignores initial reports", () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const waves = waterDisturbancesFor(scene);
    waves.resolveSurface = (p) => ({ ...p, y: 56 });
    for (const local of [true, false]) {
      const id = String(local);
      system.notify(id, 2, "water", at(), 0, local);
      clock += 150;
      system.notify(id, 2, "water", at(30), 0, local);
      clock += 20;
      system.notify(id, 2, "water", at(35), 0, local);
    }
    expect(waves.impulses).toHaveLength(2);
    expect(waves.impulses[0].y).toBe(56);
    expect(waves.impulses[0].strength).toBeCloseTo(0.4);
    expect(Array.from(waves.pack(() => true)).slice(6, 8)).toEqual([1, 0]);
  });

  it("suppresses underwater, stationary, teleport and outside-pool movement", () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const waves = waterDisturbancesFor(scene);
    for (const [level, distance] of [
      [3, 30],
      [2, 0],
      [2, 200],
    ] as const) {
      const id = `${level}:${distance}`;
      system.notify(id, level, "water", at(), 0, false);
      clock += 150;
      system.notify(id, level, "water", at(distance), 0, false);
    }
    waves.resolveSurface = () => null;
    system.notify("outside", 2, "water", at(), 0, false);
    clock += 150;
    system.notify("outside", 2, "water", at(30), 0, false);
    expect(waves.impulses).toHaveLength(0);
  });
});

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

describe("which liquid a splash belongs to", () => {
  /** Lava below y=56, water below y=56 on the far side of x=500. */
  const lavaPit = {
    pointContents: (p: { x: number; y: number; z: number }) => {
      if (p.y > 56) return 0;
      return p.x > 500 ? 2 /* WATER */ : 4 /* LAVA */;
    },
  };

  it("reads the liquid from the surface, not from the caller", () => {
    // Only the water LEVEL is replicated, never the kind, so the remote
    // renderer has nothing honest to pass and used to hardcode "water" — a
    // lava dive got a water splash and a blue ring. The client has the map.
    system.setCollisionWorld(lavaPit);
    system.notify("p1", 0, "water", at(0, 50, 0), DIVING, false);
    system.notify("p1", 2, "water", at(0, 50, 0), DIVING, false);

    expect(system.lastRingKind).toBe("lava");
  });

  it("still believes the caller when there is no map to consult", () => {
    // No collision world: the caller's guess is the only information there is.
    system.notify("p1", 0, "slime", at(0, 50, 0), DIVING, false);
    system.notify("p1", 2, "slime", at(0, 50, 0), DIVING, false);

    expect(system.lastRingKind).toBe("slime");
  });

  it("reads it per splash, not once", () => {
    system.setCollisionWorld(lavaPit);
    system.notify("p1", 0, "water", at(0, 50, 0), DIVING, false);
    system.notify("p1", 2, "water", at(0, 50, 0), DIVING, false);
    expect(system.lastRingKind).toBe("lava");

    system.notify("p2", 0, "water", at(600, 50, 0), DIVING, false);
    system.notify("p2", 2, "water", at(600, 50, 0), DIVING, false);

    expect(system.lastRingKind).toBe("water");
  });

  it("does not throw a crown into lava", () => {
    // Thick liquids do not crown, and the check must use the DERIVED kind —
    // reading the caller's "water" would spray a lava pit.
    system.enableCrowns();
    system.setCollisionWorld(lavaPit);
    system.notify("p1", 0, "water", at(0, 50, 0), DIVING, false);
    system.notify("p1", 2, "water", at(0, 50, 0), DIVING, false);

    expect(system.activeDroplets).toBe(0);
  });

  it("gives a rocket into lava a lava splash", () => {
    system.setCollisionWorld(lavaPit);
    system.notifyProjectile("proj_1", at(0, 80, 0), 1400);
    system.notifyProjectile("proj_1", at(0, 40, 0), 1400);

    expect(system.lastRingKind).toBe("lava");
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
  it("limits droplet aftermath to small ripples and lets the spray settle", () => {
    vi.spyOn(engine, "getDeltaTime").mockReturnValue(1000 / 60);
    const waves = waterDisturbancesFor(scene);
    waves.resolveSurface = (p) => ({ ...p, y: 56 });
    system.enableCrowns();
    system.notify("impact", 0, "water", at(0, 56), -700, true);
    system.notify("impact", 2, "water", at(0, 56), -700, true);
    for (let frame = 0; frame < 60; frame++) scene.onBeforeRenderObservable.notifyObservers(scene);
    const aftermath = waves.impulses.filter((wave) => wave.radius === 24);
    expect(aftermath.length).toBeGreaterThan(0);
    expect(aftermath.length).toBeLessThanOrEqual(5);
    expect(aftermath.every((wave) => wave.strength === 0.25)).toBe(true);
    expect(system.activeDroplets).toBe(0);
    expect(system.activeRings).toBe(0);
  });

  it("makes exiting quieter visually than an equally fast entry", () => {
    const waves = waterDisturbancesFor(scene);
    waves.resolveSurface = (p) => p;
    system.notify("cross", 0, "water", at(), -400, true);
    system.notify("cross", 2, "water", at(), -400, true);
    system.notify("cross", 0, "water", at(), 400, true);
    expect(waves.impulses).toHaveLength(2);
    expect(waves.impulses[1].strength).toBeLessThan(waves.impulses[0].strength);
    expect(waves.impulses[1].radius).toBeLessThan(waves.impulses[0].radius);
  });
  /** A pool filling y <= 56 inside a 200-unit square, dry everywhere else. */
  const pool = {
    pointContents: (p: { x: number; y: number; z: number }) =>
      p.y <= 56 && Math.abs(p.x) <= 200 && Math.abs(p.z) <= 200 ? 2 /* Contents.WATER */ : 0,
  };

  it("builds nothing until asked", () => {
    // The point of the tier gate: Low and Medium must not carry a droplet
    // mesh they will never draw.
    const meshes = scene.meshes.length;
    system.setCollisionWorld(pool);
    system.notify("p1", 0, "water", at(0, 50, 0), DIVING, true);
    system.notify("p1", 2, "water", at(0, 50, 0), DIVING, true);

    expect(system.crownsEnabled).toBe(false);
    expect(system.activeDroplets).toBe(0);
    // One ring mesh from the splash, and no droplet mesh.
    expect(scene.meshes.some((m) => m.name.includes("droplet"))).toBe(false);
    expect(scene.meshes.length).toBeGreaterThanOrEqual(meshes);
  });

  it("draws spray as ordinary geometry, touching no post-process", () => {
    // The property the whole rewrite exists for. Babylon's FluidRenderer
    // spliced a composite into the camera's post-process chain, which
    // DefaultRenderingPipeline owns and gameplay's second camera renders
    // through — and the world stopped being drawn at all. Nothing here may go
    // near a camera.
    system.enableCrowns();

    expect(scene.postProcesses.length).toBe(0);
    expect(scene.customRenderTargets.length).toBe(0);
    expect(scene.meshes.some((m) => m.name.includes("droplet"))).toBe(true);
  });

  it("still draws the ordinary ring at Low", () => {
    // Degrading must lose the crown, never the splash.
    system.setCollisionWorld(pool);
    system.notify("p1", 0, "water", at(0, 50, 0), DIVING, true);
    system.notify("p1", 2, "water", at(0, 50, 0), DIVING, true);

    expect(system.activeRings).toBe(1);
  });

  it("throws spray once enabled", () => {
    system.enableCrowns();
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
      fresh.enableCrowns();
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
    system.enableCrowns();
    system.setCollisionWorld(lavaPool);
    system.notify("p1", 0, "lava", at(0, 50, 0), DIVING, true);
    system.notify("p1", 2, "lava", at(0, 50, 0), DIVING, true);

    expect(system.activeRings).toBe(1);
    expect(system.activeDroplets).toBe(0);
  });

  it("is idempotent, so a second call does not stack a second renderer", () => {
    expect(system.enableCrowns()).toBe(true);
    expect(system.enableCrowns()).toBe(true);
    expect(system.crownsEnabled).toBe(true);
  });

  it("releases the droplet mesh on dispose", () => {
    // A map change leaves nothing behind: the mesh and its material both go.
    system.enableCrowns();
    system.setCollisionWorld(pool);
    system.notify("p1", 0, "water", at(0, 50, 0), DIVING, true);
    system.notify("p1", 2, "water", at(0, 50, 0), DIVING, true);

    system.dispose();

    expect(system.crownsEnabled).toBe(false);
    expect(system.activeDroplets).toBe(0);
    expect(scene.meshes.some((m) => m.name.includes("droplet"))).toBe(false);
  });

  it("does not stack a droplet mesh per map", () => {
    // Ten map loads is ten enable calls on the same scene if disposal misses.
    for (let i = 0; i < 10; i++) {
      system.enableCrowns();
      system.disableCrowns();
    }
    system.enableCrowns();

    expect(scene.meshes.filter((m) => m.name.includes("droplet")).length).toBe(1);
  });

  it("keeps spray out of the viewmodel camera's layer", () => {
    // A default layer mask is visible to BOTH cameras, so the crown would be
    // drawn a second time at the weapon's field of view — a handful of
    // boulders across the screen.
    system.enableCrowns();

    const mesh = scene.meshes.find((m) => m.name.includes("droplet"));
    expect(mesh).toBeDefined();
    expect((mesh?.layerMask ?? 0) & 0x10000000).toBe(0);
  });

  it("can be turned off and back on without leaking state", () => {
    system.enableCrowns();
    system.setCollisionWorld(pool);
    system.notify("p1", 0, "water", at(0, 50, 0), DIVING, true);
    system.notify("p1", 2, "water", at(0, 50, 0), DIVING, true);
    expect(system.activeDroplets).toBeGreaterThan(0);

    system.disableCrowns();
    expect(system.activeDroplets).toBe(0);

    system.enableCrowns();
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
