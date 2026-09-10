/**
 * Splash droplet ballistics (water Phase 5).
 *
 * The renderer half of the Epic tier needs a GPU and cannot be asserted here.
 * The simulation half is where the behaviour actually lives, and all of it is
 * plain arithmetic over a fixed pool — so these cover the properties that
 * would otherwise only show up as a leak or a stuck crown after ten minutes
 * of play: the pool never grows, droplets always come back, and re-entry is
 * reported so the ripple handoff has something to fire on.
 */

import { describe, expect, it } from "vitest";
import { MAX_DROPLETS, SplashDroplets } from "../client/SplashDroplets";

const SURFACE_Y = 100;
const splash = (strength = 1) => ({ x: 0, y: SURFACE_Y, z: 0, surfaceY: SURFACE_Y, strength });

/** Run the simulation forward at a fixed step, collecting every re-entry. */
function simulate(droplets: SplashDroplets, seconds: number, step = 1 / 60) {
  const reentries = [];
  for (let t = 0; t < seconds; t += step) {
    reentries.push(...droplets.update(step));
  }
  return reentries;
}

describe("spawning", () => {
  it("rejects empty/invalid splashes and caps excessive strength", () => {
    const droplets = new SplashDroplets();
    expect(droplets.spawn(splash(0), 1)).toBe(0);
    expect(droplets.spawn(splash(NaN), 1)).toBe(0);
    expect(droplets.spawn(splash(-1), 1)).toBe(0);
    expect(droplets.spawn(splash(100), 1)).toBe(24);
  });

  it("keeps weak splashes lower and narrower than hard impacts", () => {
    const weak = new SplashDroplets(),
      hard = new SplashDroplets();
    weak.spawn(splash(0.15), 23);
    hard.spawn(splash(1), 23);
    weak.update(1 / 60);
    hard.update(1 / 60);
    const maxLift = (d: SplashDroplets) =>
      Math.max(...Array.from(d.velocityBuffer.slice(0, d.count * 3)).filter((_, i) => i % 3 === 1));
    expect(maxLift(hard)).toBeGreaterThan(maxLift(weak) * 2);
    expect(hard.count).toBeGreaterThan(weak.count);
  });
  it("fades falling spray during its actual short flight, before surface re-entry", () => {
    const droplets = new SplashDroplets();
    droplets.spawn(splash(0.7), 23);
    let sawFadedDescent = false;
    for (let t = 0; t < 0.6; t += 1 / 120) {
      droplets.update(1 / 120);
      for (let i = 0; i < droplets.count; i++) {
        expect(droplets.opacityBuffer[i]).toBeGreaterThanOrEqual(0);
        expect(droplets.opacityBuffer[i]).toBeLessThanOrEqual(1);
        if (droplets.velocityBuffer[i * 3 + 1] < 0 && droplets.opacityBuffer[i] < 0.5) sawFadedDescent = true;
      }
    }
    expect(sawFadedDescent).toBe(true);
    expect(droplets.aliveCount).toBe(0);
  });
  it("throws more droplets for a harder splash", () => {
    const light = new SplashDroplets();
    const heavy = new SplashDroplets();

    expect(heavy.spawn(splash(1), 1)).toBeGreaterThan(light.spawn(splash(0.1), 1));
  });

  it("starts every droplet at the waterline, not at the body", () => {
    // A body crossing the surface is reported at its own origin, which on the
    // way out is up on the bank. Spray belongs to the water.
    const droplets = new SplashDroplets();
    droplets.spawn({ x: 0, y: 400, z: 0, surfaceY: SURFACE_Y, strength: 1 }, 1);
    droplets.update(1 / 60);

    for (let i = 0; i < droplets.count; i++) {
      // One step of upward flight above the surface, nowhere near y=400.
      expect(droplets.buffer[i * 3 + 1]).toBeLessThan(SURFACE_Y + 20);
      expect(droplets.buffer[i * 3 + 1]).toBeGreaterThan(SURFACE_Y);
    }
  });

  it("throws them upward first", () => {
    // A crown, not a puff: if the outward component dominated, a splash would
    // read as a ring of spray sliding across the surface.
    const droplets = new SplashDroplets();
    droplets.spawn(splash(1), 7);
    droplets.update(1 / 60);

    for (let i = 0; i < droplets.count; i++) {
      const y = droplets.buffer[i * 3 + 1] - SURFACE_Y;
      const x = Math.abs(droplets.buffer[i * 3]);
      const z = Math.abs(droplets.buffer[i * 3 + 2]);
      expect(y).toBeGreaterThan(Math.hypot(x, z));
    }
  });

  it("spreads them around, not along one line", () => {
    const droplets = new SplashDroplets();
    droplets.spawn(splash(1), 3);
    droplets.update(1 / 60);

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < droplets.count; i++) {
      minX = Math.min(minX, droplets.buffer[i * 3]);
      maxX = Math.max(maxX, droplets.buffer[i * 3]);
      minZ = Math.min(minZ, droplets.buffer[i * 3 + 2]);
      maxZ = Math.max(maxZ, droplets.buffer[i * 3 + 2]);
    }

    expect(maxX - minX).toBeGreaterThan(0);
    expect(maxZ - minZ).toBeGreaterThan(0);
  });

  it("gives the same crown for the same seed", () => {
    // Two clients watching one dive should see one splash, without any of it
    // being replicated.
    const a = new SplashDroplets();
    const b = new SplashDroplets();
    a.spawn(splash(1), 42);
    b.spawn(splash(1), 42);
    a.update(1 / 60);
    b.update(1 / 60);

    expect(Array.from(a.buffer)).toEqual(Array.from(b.buffer));
  });

  it("gives different crowns for different splashes", () => {
    const a = new SplashDroplets();
    const b = new SplashDroplets();
    a.spawn(splash(1), 1);
    b.spawn(splash(1), 2);
    a.update(1 / 60);
    b.update(1 / 60);

    expect(Array.from(a.buffer)).not.toEqual(Array.from(b.buffer));
  });
});

describe("size", () => {
  it("does not draw every droplet the same", () => {
    // Uniform droplets read as a pattern rather than as spray — the first
    // version drew them all at one radius and the crown looked like a handful
    // of thrown snowballs.
    const droplets = new SplashDroplets();
    droplets.spawn(splash(1), 23);
    droplets.update(1 / 60);

    const sizes = Array.from(droplets.sizeBuffer.slice(0, droplets.count));
    expect(new Set(sizes).size).toBeGreaterThan(1);
  });

  it("makes most of them small and only a few fat", () => {
    // Real spray is mostly fine mist. A linear spread still reads as a cloud
    // of identical beads, so the roll is cubed.
    const droplets = new SplashDroplets();
    droplets.spawn(splash(1), 29);
    droplets.update(1 / 60);

    const sizes = Array.from(droplets.sizeBuffer.slice(0, droplets.count));
    const small = sizes.filter((s) => s < 0.5).length;

    expect(small / sizes.length).toBeGreaterThan(0.5);
  });

  it("keeps every droplet within a sane range", () => {
    const droplets = new SplashDroplets();
    droplets.spawn(splash(1), 31);
    droplets.update(1 / 60);

    for (let i = 0; i < droplets.count; i++) {
      expect(droplets.sizeBuffer[i]).toBeGreaterThan(0);
      expect(droplets.sizeBuffer[i]).toBeLessThanOrEqual(1);
    }
  });

  it("shrinks them toward the end of the arc", () => {
    // Spray breaks up rather than popping out of existence at full size.
    const droplets = new SplashDroplets();
    droplets.spawn(splash(1), 37);
    droplets.update(1 / 60);
    const early = Array.from(droplets.sizeBuffer.slice(0, droplets.count));
    let checked = false;
    // Check a LIVE falling droplet before the first re-entry. The previous
    // timeout test compared against an empty buffer (Math.max() = -Infinity).
    for (let frame = 0; frame < 30; frame++) {
      if (droplets.update(1 / 120).length) break;
      for (let i = 0; i < droplets.count; i++) {
        if (droplets.velocityBuffer[i * 3 + 1] >= -10) continue;
        expect(droplets.sizeBuffer[i]).toBeLessThan(early[i]);
        expect(droplets.sizeBuffer[i]).toBeGreaterThan(0);
        checked = true;
      }
    }
    expect(checked).toBe(true);
  });

  it("has a size for every packed position", () => {
    // The renderer indexes both buffers with the same counter; a mismatch
    // would scale droplets by their neighbour's size.
    const droplets = new SplashDroplets();
    droplets.spawn(splash(1), 41);
    droplets.spawn(splash(0.5), 43);
    droplets.update(1 / 60);

    expect(droplets.sizeBuffer.length).toBe(MAX_DROPLETS);
    for (let i = 0; i < droplets.count; i++) expect(droplets.sizeBuffer[i]).toBeGreaterThan(0);
  });
});

describe("flight", () => {
  it("brings every droplet back down", () => {
    // Nothing may stay in the air. A stuck droplet is a white dot hanging over
    // a pool for the rest of the map.
    const droplets = new SplashDroplets();
    droplets.spawn(splash(1), 5);

    simulate(droplets, 4);

    expect(droplets.count).toBe(0);
  });

  it("reports where each one landed", () => {
    const droplets = new SplashDroplets();
    const thrown = droplets.spawn(splash(1), 5);

    const reentries = simulate(droplets, 4);

    expect(reentries.length).toBe(thrown);
    for (const hit of reentries) {
      // Landing is reported AT the surface, so a ripple raised from it sits on
      // the water rather than slightly under it.
      expect(hit.y).toBe(SURFACE_Y);
      expect(hit.speed).toBeGreaterThan(0);
    }
  });

  it("lands them away from where they were thrown", () => {
    const droplets = new SplashDroplets();
    droplets.spawn(splash(1), 11);

    const reentries = simulate(droplets, 4);

    expect(reentries.some((hit) => Math.hypot(hit.x, hit.z) > 10)).toBe(true);
  });

  it("slows the outward drift instead of letting it fly forever", () => {
    // Drag is what makes spray read as water. Without it the crown becomes a
    // cone of gravel arcing off across the map.
    const droplets = new SplashDroplets();
    droplets.spawn(splash(1), 13);

    const reentries = simulate(droplets, 4);
    const furthest = Math.max(...reentries.map((hit) => Math.hypot(hit.x, hit.z)));

    expect(furthest).toBeLessThan(200);
  });

  it("does not retire a droplet on the way up", () => {
    // It starts exactly at the surface, so a check that ignored direction
    // would kill the whole crown on its first frame.
    const droplets = new SplashDroplets();
    const thrown = droplets.spawn(splash(1), 17);

    const first = droplets.update(1 / 60);

    expect(first).toHaveLength(0);
    expect(droplets.count).toBe(thrown);
  });
});

describe("the pool", () => {
  it("never exceeds its capacity however many splashes arrive", () => {
    const droplets = new SplashDroplets();

    for (let i = 0; i < 100; i++) droplets.spawn(splash(1), i);
    droplets.update(1 / 60);

    expect(droplets.count).toBeLessThanOrEqual(MAX_DROPLETS);
  });

  it("keeps the buffer a fixed size", () => {
    const droplets = new SplashDroplets();
    const buffer = droplets.buffer;

    for (let i = 0; i < 100; i++) droplets.spawn(splash(1), i);
    droplets.update(1 / 60);

    // Same object, never reallocated: the renderer holds this reference for
    // the life of the map and pushes it to the GPU in place.
    expect(droplets.buffer).toBe(buffer);
    expect(droplets.buffer.length).toBe(MAX_DROPLETS * 3);
  });

  it("recycles droplets once they have landed", () => {
    const droplets = new SplashDroplets();
    for (let i = 0; i < 100; i++) droplets.spawn(splash(1), i);
    simulate(droplets, 4);

    // Everything is down; the pool should be able to serve a full splash again.
    expect(droplets.spawn(splash(1), 999)).toBeGreaterThan(0);
  });

  it("clears for a map change", () => {
    const droplets = new SplashDroplets();
    droplets.spawn(splash(1), 1);
    droplets.update(1 / 60);
    expect(droplets.count).toBeGreaterThan(0);

    droplets.clear();

    expect(droplets.update(1 / 60)).toHaveLength(0);
    expect(droplets.count).toBe(0);
  });
});

describe("the surface a droplet belongs to", () => {
  it("retires against its own splash's waterline, not wherever it drifts", () => {
    // Two pools at different heights. A droplet thrown from the low one must
    // not retire against the high one's surface just because it flew over it.
    const droplets = new SplashDroplets();
    droplets.spawn({ x: 0, y: 0, z: 0, surfaceY: 0, strength: 1 }, 21);

    const reentries = simulate(droplets, 4);

    for (const hit of reentries) expect(hit.y).toBe(0);
  });
});
