/**
 * The droplets a splash throws, simulated on the CPU.
 *
 * Pure ballistics over a fixed-capacity pool, with no renderer in sight — the
 * Epic tier hands these positions to Babylon's FluidRenderer, and the tests
 * run the same simulation without one.
 *
 * CPU ownership is the whole point. FluidRenderer draws particles; it does not
 * move them, and it certainly does not know where the waterline is. Owning the
 * positions is what lets a droplet be retired exactly when it falls back
 * through the surface and hand a ripple to the static water on the way out —
 * which is the join between the two effects, and the reason the crown does not
 * simply sink through the pool it came from.
 */

/** Every droplet the game may have in the air at once, across all splashes. */
export const MAX_DROPLETS = 220;

/** Gravity for droplets, in world units per second squared. */
const DROPLET_GRAVITY = 1400;

/** Air drag per second. Spray slows fast; it is water, not gravel. */
const DROPLET_DRAG = 1.6;

/** A droplet that somehow never comes down is retired anyway. */
const MAX_LIFETIME = 2.5;

export interface DropletSpawn {
  x: number;
  y: number;
  z: number;
  /** The surface height this splash belongs to; droplets retire on crossing it. */
  surfaceY: number;
  /** 0-1. Scales how many droplets and how hard they are thrown. */
  strength: number;
}

/** A droplet that fell back through the surface, for the ripple handoff. */
export interface DropletReentry {
  x: number;
  y: number;
  z: number;
  /** Speed it came down at, for how hard the ripple should be. */
  speed: number;
}

interface Droplet {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  surfaceY: number;
  age: number;
  alive: boolean;
}

/**
 * Deterministic spread, so a splash looks the same to everyone watching it.
 *
 * The seed is the splash, not the frame — two clients rendering the same
 * crossing get the same crown without any of it being replicated.
 */
function seededUnit(seed: number, index: number): number {
  const h = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

export class SplashDroplets {
  private readonly droplets: Droplet[] = [];
  /** Interleaved xyz for the renderer, sized once. */
  private readonly positions = new Float32Array(MAX_DROPLETS * 3);
  private liveCount = 0;

  constructor() {
    for (let i = 0; i < MAX_DROPLETS; i++) {
      this.droplets.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, surfaceY: 0, age: 0, alive: false });
    }
  }

  /**
   * Throw a crown of droplets.
   *
   * Upward and outward: the vertical component dominates so the shape reads as
   * a crown rather than a puff, and the outward spread grows with strength so
   * a rocket throws a wider one than a body does.
   */
  spawn(spawn: DropletSpawn, seed: number): number {
    const wanted = Math.round(6 + spawn.strength * 22);
    let spawned = 0;

    for (let i = 0; i < wanted; i++) {
      const droplet = this.free();
      if (!droplet) break;

      const angle = seededUnit(seed, i) * Math.PI * 2;
      const spread = 40 + seededUnit(seed, i + 500) * 150 * spawn.strength;
      const lift = 190 + seededUnit(seed, i + 1000) * 260 * spawn.strength;

      droplet.x = spawn.x;
      droplet.y = spawn.surfaceY;
      droplet.z = spawn.z;
      droplet.vx = Math.cos(angle) * spread;
      droplet.vy = lift;
      droplet.vz = Math.sin(angle) * spread;
      droplet.surfaceY = spawn.surfaceY;
      droplet.age = 0;
      droplet.alive = true;
      spawned++;
    }

    return spawned;
  }

  /**
   * Advance every live droplet, and report the ones that came back down.
   *
   * Re-entry is checked against the surface the droplet was thrown from rather
   * than a fresh query: a droplet belongs to its own splash, and asking the
   * world again mid-flight would let one drift over a bank and retire against
   * a pool it was never part of.
   */
  update(deltaTime: number): DropletReentry[] {
    const reentries: DropletReentry[] = [];
    this.liveCount = 0;

    for (const d of this.droplets) {
      if (!d.alive) continue;

      d.age += deltaTime;

      const drag = Math.max(0, 1 - DROPLET_DRAG * deltaTime);
      d.vx *= drag;
      d.vz *= drag;
      d.vy = d.vy * drag - DROPLET_GRAVITY * deltaTime;

      d.x += d.vx * deltaTime;
      d.y += d.vy * deltaTime;
      d.z += d.vz * deltaTime;

      // Falling back through the surface ends it, and hands the energy to the
      // static water as a ripple rather than letting the droplet sink through
      // a pool the renderer cannot depth-sort it against.
      if (d.vy < 0 && d.y <= d.surfaceY) {
        d.alive = false;
        reentries.push({ x: d.x, y: d.surfaceY, z: d.z, speed: Math.abs(d.vy) });
        continue;
      }

      if (d.age >= MAX_LIFETIME) {
        d.alive = false;
        continue;
      }

      const o = this.liveCount * 3;
      this.positions[o] = d.x;
      this.positions[o + 1] = d.y;
      this.positions[o + 2] = d.z;
      this.liveCount++;
    }

    return reentries;
  }

  private free(): Droplet | null {
    for (const d of this.droplets) {
      if (!d.alive) return d;
    }
    // At capacity. Dropping the request is right: a splash nobody has room for
    // is one of many on screen, and stealing a droplet mid-flight would make
    // an existing crown flicker to pay for it.
    return null;
  }

  /**
   * How many droplets are packed in the buffer. The renderer draws this many.
   *
   * Only meaningful after `update()` — the buffer is packed there, so a droplet
   * that has been spawned but not yet stepped is not in it. For "is anything in
   * flight", which is a different question, use `aliveCount`.
   */
  get count(): number {
    return this.liveCount;
  }

  /** Droplets in flight, whether or not they have been packed yet. */
  get aliveCount(): number {
    let alive = 0;
    for (const d of this.droplets) if (d.alive) alive++;
    return alive;
  }

  /** Interleaved xyz positions. Only the first `count * 3` entries are live. */
  get buffer(): Float32Array {
    return this.positions;
  }

  /** Retire everything, for a map change. */
  clear(): void {
    for (const d of this.droplets) d.alive = false;
    this.liveCount = 0;
  }
}
