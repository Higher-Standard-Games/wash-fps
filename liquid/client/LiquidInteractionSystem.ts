/**
 * Bodies crossing a liquid surface — the splash, and the ring it leaves.
 *
 * Feeds on the water level already replicated for every player, so a remote
 * diving into a pool produces the same interaction as the local one with no
 * new network state. That is the standing rule for this feature: replicate
 * causes, derive effects.
 *
 * Scene-scoped and pooled. Rings are allocated once and reused, because a
 * firefight around a pool is exactly when allocation matters and exactly when
 * a mesh created per splash would be worst.
 */

import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import { MASK_LIQUID } from "../../../../shared/collision/CollisionWorld";
import { enterSound, exitSound, playLiquidCrossing, splashVolume } from "../../client/FPSLiquidAudio";
import type { LiquidKind, WaterLevel } from "../LiquidTypes";
import type { PointContentsSource } from "../LiquidVolumeSampler";

/** How many rings can be alive at once. Beyond this the oldest is recycled. */
const RING_POOL_SIZE = 12;
/** Seconds a ring takes to expand and fade. */
const RING_LIFETIME = 0.9;
const RING_START_RADIUS = 6;
const RING_END_RADIUS = 62;

interface Ring {
  mesh: Mesh;
  material: StandardMaterial;
  /** Seconds since spawn, or >= RING_LIFETIME when free. */
  age: number;
  /** Where this particular ring stops, clamped to the pool it is in. */
  maxRadius: number;
}

/**
 * How far above the body to start looking for the surface, and how far down.
 *
 * Generous enough to find the waterline from a body standing on a bank after
 * climbing out, tight enough that it cannot find a different pool on another
 * storey and draw the ring there.
 */
const SURFACE_SEARCH_ABOVE = 8;
const SURFACE_SEARCH_STEP = 4;
const SURFACE_SEARCH_STEPS = 24;

/** Lift off the surface so the ring does not fight the water for the same pixel. */
const RING_SURFACE_LIFT = 0.5;

/** Directions probed to find the pool's edge. Eight is enough for a circle. */
const EDGE_PROBE_DIRECTIONS = 8;
/** How far out the probe walks before giving up and using the full radius. */
const EDGE_PROBE_STEPS = 6;

const RING_COLORS: Record<LiquidKind, Color3> = {
  water: new Color3(0.75, 0.9, 1.0),
  slime: new Color3(0.6, 0.95, 0.35),
  lava: new Color3(1.0, 0.75, 0.35),
};

interface TrackedBody {
  level: WaterLevel;
}

export class LiquidInteractionSystem {
  private readonly rings: Ring[] = [];
  private readonly bodies = new Map<string, TrackedBody>();
  private observer: Observer<Scene> | null = null;
  private nextRing = 0;
  private collision: PointContentsSource | null = null;
  private lastSpawned: Ring | null = null;

  constructor(private readonly scene: Scene) {}

  /**
   * Report a body's current water level.
   *
   * Called every frame for every player the client knows about; the system
   * keeps the previous level itself and acts only on the change. Callers do
   * not have to know whether a transition happened, which is what stops the
   * same splash being emitted from three different places.
   */
  notify(
    entityId: string,
    level: WaterLevel,
    kind: LiquidKind,
    position: { x: number; y: number; z: number },
    verticalSpeed: number,
    local: boolean,
  ): void {
    const tracked = this.bodies.get(entityId);

    // A body's FIRST report establishes a baseline and produces nothing. It is
    // not a crossing: the player may have joined mid-match already submerged,
    // respawned into a pool, or simply entered PVS while swimming. Treating an
    // unknown body as previously dry would splash for all three.
    if (!tracked) {
      this.bodies.set(entityId, { level });
      return;
    }

    const previous = tracked.level;
    tracked.level = level;

    if (previous === level) return;

    const entered = previous === 0 && level > 0;
    const exited = previous > 0 && level === 0;
    if (!entered && !exited) return;

    const volume = splashVolume(verticalSpeed);
    playLiquidCrossing(entered ? enterSound(kind) : exitSound(kind), volume, position, local);

    // A ring for a body that actually broke the surface. Someone easing across
    // the waterline leaves nothing, which is also why the volume gate and the
    // ring share a threshold.
    if (volume > 0) this.spawnRing(position, kind, volume);
  }

  /**
   * Forget a body, so its next report is a baseline rather than a crossing.
   *
   * Needed wherever a body moves without swimming: leaving the match, a
   * respawn, a teleport. Dying at the bottom of a pool and respawning dry is a
   * level going 3 to 0 with no surface broken, and without this it would
   * announce itself with a splash at the spawn point.
   */
  forget(entityId: string): void {
    this.bodies.delete(entityId);
  }

  private spawnRing(position: { x: number; y: number; z: number }, kind: LiquidKind, strength: number): void {
    // Snap to the waterline. The position handed in is the BODY's, and on the
    // way out of a pool the body is already standing on the bank — so a ring
    // drawn there floats over dry land a couple of feet up, which is exactly
    // what it looked like. A ripple belongs to the surface, not to the swimmer.
    const surfaceY = this.surfaceYNear(position);
    if (surfaceY === null) return;

    const at = { x: position.x, y: surfaceY, z: position.z };

    const ring = this.acquireRing();
    if (!ring) return;

    ring.mesh.position.set(at.x, at.y + RING_SURFACE_LIFT, at.z);
    ring.material.emissiveColor = RING_COLORS[kind];
    ring.material.alpha = 0.55 * strength;
    ring.maxRadius = this.edgeLimitedRadius(at);
    ring.mesh.scaling.setAll(RING_START_RADIUS);
    ring.mesh.setEnabled(true);
    ring.age = 0;
    this.lastSpawned = ring;

    this.start();
  }

  /**
   * The height of the liquid surface near a body, or null if there is none.
   *
   * Walks down a column through the body's position and returns the first
   * height where liquid begins. Returning null rather than guessing matters:
   * a crossing detected while the body is nowhere near a surface — a teleport,
   * a respawn the forget() call did not cover — produces no ring at all, which
   * is better than one drawn at an invented height.
   */
  private surfaceYNear(position: { x: number; y: number; z: number }): number | null {
    if (!this.collision) return position.y;

    for (let i = 0; i <= SURFACE_SEARCH_STEPS; i++) {
      const y = position.y + SURFACE_SEARCH_ABOVE - i * SURFACE_SEARCH_STEP;
      const contents = this.collision.pointContents({ x: position.x, y, z: position.z });
      if ((contents & MASK_LIQUID) !== 0) return y;
    }

    return null;
  }

  /**
   * How far this ring may expand before it runs out of pool.
   *
   * A ring is a flat disc, and nothing about a disc knows where the water
   * stops — so a splash near a bank drew a spreading circle out across the dry
   * floor beside it. Rather than guess from the render bounds, walk outward
   * through the actual liquid volume and stop at the first dry sample: the
   * collision contents are what define where the pool IS, so the ring cannot
   * disagree with the water it belongs to.
   *
   * Eight directions, a handful of steps, once per splash. Cheap enough to not
   * think about, and irregular pool outlines get an honest answer rather than
   * a bounding box's.
   */
  private edgeLimitedRadius(position: { x: number; y: number; z: number }): number {
    if (!this.collision) return RING_END_RADIUS;

    let limit = RING_END_RADIUS;
    const step = RING_END_RADIUS / EDGE_PROBE_STEPS;

    for (let d = 0; d < EDGE_PROBE_DIRECTIONS; d++) {
      const angle = (d / EDGE_PROBE_DIRECTIONS) * Math.PI * 2;
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);

      for (let s = 1; s <= EDGE_PROBE_STEPS; s++) {
        const distance = step * s;
        const contents = this.collision.pointContents({
          x: position.x + dx * distance,
          // Probe just below the surface: exactly at it is the boundary case,
          // and a float either side of the plane would answer at random.
          y: position.y - 2,
          z: position.z + dz * distance,
        });

        if ((contents & MASK_LIQUID) === 0) {
          // Stop one step short, so the ring stays inside rather than touching
          // the bank it just found.
          limit = Math.min(limit, Math.max(RING_START_RADIUS, distance - step));
          break;
        }
      }
    }

    return limit;
  }

  /** The liquid volumes are the authority on where a ring may spread. */
  setCollisionWorld(collision: PointContentsSource | null): void {
    this.collision = collision;
  }

  private acquireRing(): Ring | null {
    // Prefer a free ring; otherwise recycle the oldest, so a burst of splashes
    // degrades by dropping the stalest rather than by allocating.
    for (const ring of this.rings) {
      if (ring.age >= RING_LIFETIME) return ring;
    }

    if (this.rings.length < RING_POOL_SIZE) {
      const ring = this.createRing();
      this.rings.push(ring);
      return ring;
    }

    const recycled = this.rings[this.nextRing % this.rings.length];
    this.nextRing++;
    return recycled;
  }

  private createRing(): Ring {
    const material = new StandardMaterial(`liquid-ring-${this.rings.length}`, this.scene);
    material.disableLighting = true;
    material.emissiveColor = RING_COLORS.water;
    material.diffuseColor = Color3.Black();
    material.alpha = 0;
    material.backFaceCulling = false;

    const mesh = CreateDisc(`liquid-ring-${this.rings.length}`, { radius: 1, tessellation: 24 }, this.scene);
    mesh.material = material;
    // Flat on the surface, and never occluding what is behind it.
    mesh.rotation.x = Math.PI / 2;
    mesh.isPickable = false;
    mesh.setEnabled(false);

    return { mesh, material, age: RING_LIFETIME, maxRadius: RING_END_RADIUS };
  }

  private start(): void {
    if (this.observer) return;
    this.observer = this.scene.onBeforeRenderObservable.add(() => {
      const dt = Math.min(0.1, this.scene.getEngine().getDeltaTime() / 1000);
      let active = false;

      for (const ring of this.rings) {
        if (ring.age >= RING_LIFETIME) continue;
        ring.age += dt;

        const t = Math.min(1, ring.age / RING_LIFETIME);
        // Expand fast and settle, the way a real ring loses energy.
        const eased = 1 - (1 - t) * (1 - t);
        ring.mesh.scaling.setAll(RING_START_RADIUS + (ring.maxRadius - RING_START_RADIUS) * eased);
        ring.material.alpha = Math.max(0, ring.material.alpha * (1 - dt / RING_LIFETIME) - dt * 0.15);

        if (ring.age >= RING_LIFETIME) {
          ring.mesh.setEnabled(false);
        } else {
          active = true;
        }
      }

      // Nothing to animate: stop costing a frame callback until the next splash.
      if (!active) this.stop();
    });
  }

  private stop(): void {
    if (!this.observer) return;
    this.scene.onBeforeRenderObservable.remove(this.observer);
    this.observer = null;
  }

  /** Rings currently animating. For tests and the debug command. */
  get activeRings(): number {
    return this.rings.filter((r) => r.age < RING_LIFETIME).length;
  }

  /** Height of the most recently spawned ring, or null. Test/debug only. */
  get lastRingY(): number | null {
    return this.lastSpawned?.mesh.position.y ?? null;
  }

  /** Edge-clamped radius of the most recently spawned ring. Test/debug only. */
  get lastRingMaxRadius(): number | null {
    return this.lastSpawned?.maxRadius ?? null;
  }

  dispose(): void {
    this.stop();
    for (const ring of this.rings) {
      ring.mesh.dispose();
      ring.material.dispose();
    }
    this.rings.length = 0;
    this.bodies.clear();
  }
}

export { RING_LIFETIME, RING_POOL_SIZE };
