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

import type { Camera } from "@babylonjs/core/Cameras/camera";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import { MASK_LIQUID } from "../../../../shared/collision/CollisionWorld";
import { enterSound, exitSound, HIT_WATER, playLiquidCrossing, splashVolume } from "../../client/FPSLiquidAudio";
import type { LiquidKind, WaterLevel } from "../LiquidTypes";
import type { PointContentsSource } from "../LiquidVolumeSampler";
import { FluidSplashRenderer } from "./FluidSplashRenderer";
import { SplashDroplets } from "./SplashDroplets";

/** How many rings can be alive at once. Beyond this the oldest is recycled. */
const RING_POOL_SIZE = 12;
/** Seconds a ring takes to expand and fade. */
const RING_LIFETIME = 0.5;
const RING_START_RADIUS = 4;
const RING_END_RADIUS = 48;

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

/**
 * How hard a droplet must land to leave a ripple of its own, in units/sec.
 *
 * The gate is what keeps the handoff readable. A crown throws dozens of
 * droplets and they do not all come down hard; ringing every one would spend
 * the whole ring pool on a single splash, and the result reads as static
 * rather than as water.
 */
const REENTRY_RING_SPEED = 260;
/** Re-entry ripples are faint — a crown's aftermath, not another splash. */
const REENTRY_RING_STRENGTH = 0.25;

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

/** Size of the generated ring mask. Soft edges need no more than this. */
const RING_MASK_SIZE = 64;
/** Where the band sits, as a fraction of the disc radius. */
const RING_BAND_CENTRE = 0.78;
const RING_BAND_WIDTH = 0.22;

/** Scene-scoped ring mask — one texture for every ripple in the map. */
const ringMaskByScene = new WeakMap<Scene, RawTexture>();

/**
 * A soft annulus, generated rather than shipped.
 *
 * Alpha peaks in a band near the rim and falls to nothing both inward and
 * outward, so a scaled disc reads as a spreading ripple rather than a growing
 * plate. Generated for the same reason the water normals are: an asset here
 * would live outside version control and could go missing on a fresh checkout.
 */
function ringMask(scene: Scene): RawTexture {
  const existing = ringMaskByScene.get(scene);
  if (existing) return existing;

  const size = RING_MASK_SIZE;
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const r = Math.sqrt(dx * dx + dy * dy);

      // Smooth falloff either side of the band, and hard zero past the disc
      // edge so the corners of the quad never show.
      const distance = Math.abs(r - RING_BAND_CENTRE) / RING_BAND_WIDTH;
      const band = r > 1 ? 0 : Math.max(0, 1 - distance * distance);

      const i = (y * size + x) * 4;
      const v = Math.round(band * 255);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = v;
    }
  }

  const texture = RawTexture.CreateRGBATexture(data, size, size, scene, false, false);
  texture.name = "liquid-ring-mask";
  texture.hasAlpha = true;
  ringMaskByScene.set(scene, texture);
  return texture;
}

export class LiquidInteractionSystem {
  private readonly rings: Ring[] = [];
  private readonly bodies = new Map<string, TrackedBody>();
  private observer: Observer<Scene> | null = null;
  private nextRing = 0;
  private collision: PointContentsSource | null = null;
  private lastSpawned: Ring | null = null;
  /** Whether each tracked projectile was in liquid last frame. */
  private readonly projectiles = new Map<string, boolean>();
  /** Epic tier only. Null until enableCrowns() succeeds. */
  private droplets: SplashDroplets | null = null;
  private fluid: FluidSplashRenderer | null = null;
  /** Splash counter, used as the deterministic seed for each crown's spread. */
  private splashSeed = 0;

  constructor(private readonly scene: Scene) {}

  /**
   * Turn on Epic splash crowns.
   *
   * Separate from the constructor and reversible, because this is the only
   * part of the water feature that allocates render targets. Low and Medium
   * never call it and pay nothing — not a smaller target, none at all.
   *
   * Returns false if FluidRenderer refused to start, in which case the plain
   * ring stays and nothing else changes.
   */
  enableCrowns(camera: Camera): boolean {
    if (this.fluid) return true;

    const droplets = new SplashDroplets();
    const fluid = new FluidSplashRenderer(this.scene);
    if (!fluid.start(camera, droplets.buffer)) return false;

    this.droplets = droplets;
    this.fluid = fluid;
    return true;
  }

  /** Drop back to plain rings, releasing the fluid targets. */
  disableCrowns(): void {
    this.fluid?.dispose();
    this.fluid = null;
    this.droplets?.clear();
    this.droplets = null;
  }

  get crownsEnabled(): boolean {
    return this.fluid !== null;
  }

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
   * Report a projectile's position, and splash if it just entered a liquid.
   *
   * Water is NONSOLID, so a rocket flies straight through it and the ordinary
   * impact event never fires — a shot into a pool used to land in silence.
   * This watches the previous-to-current segment instead, which is cosmetic
   * and needs no new network state: the projectile's motion is already
   * replicated for the visual.
   *
   * Detection is by contents at each end rather than a trace, because the
   * distance covered in one frame is short and the two samples the crossing
   * needs are the two the system already has.
   */
  notifyProjectile(id: string, position: { x: number; y: number; z: number }, speed: number): void {
    if (!this.collision) return;

    const wet = (this.collision.pointContents(position) & MASK_LIQUID) !== 0;
    const previous = this.projectiles.get(id);
    this.projectiles.set(id, wet);

    // First sighting establishes a baseline, like a body's does — a projectile
    // spawned already inside liquid never entered it.
    if (previous === undefined || previous === wet || !wet) return;

    // Projectiles hit harder than bodies drift, so the splash is scaled off
    // their own speed rather than the body gate, which they would always clear.
    const strength = Math.min(1, 0.35 + speed / 3000);
    playLiquidCrossing(HIT_WATER, strength, position, false);
    this.spawnRing(position, "water", strength);
  }

  /** A projectile that exploded or expired. */
  forgetProjectile(id: string): void {
    this.projectiles.delete(id);
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

    // Epic: throw a crown of spray from the same waterline the ring sits on.
    // Water only — slime and lava are thick and do not throw droplets, and a
    // pale crown over lava would read as steam.
    if (this.droplets && kind === "water") {
      this.splashSeed++;
      this.droplets.spawn({ ...at, surfaceY, strength }, this.splashSeed);
    }

    this.placeRing(at, kind, strength);
  }

  /**
   * Put a ring on the surface at an already-resolved waterline.
   *
   * Split out from `spawnRing` so droplet re-entries can raise their own small
   * ripple without throwing another crown — which would be a splash spawning
   * a splash, forever.
   */
  private placeRing(at: { x: number; y: number; z: number }, kind: LiquidKind, strength: number): void {
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
    // A ripple is a RING, and a disc is a filled circle. Without this mask the
    // effect is a pale plate lying on the water — which is exactly what it
    // looked like. The texture is what turns the geometry into an expanding
    // band with nothing in the middle.
    material.opacityTexture = ringMask(this.scene);
    material.emissiveTexture = ringMask(this.scene);

    const mesh = CreateDisc(`liquid-ring-${this.rings.length}`, { radius: 1, tessellation: 32 }, this.scene);
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

      if (this.droplets) active = this.updateDroplets(dt) || active;

      // Nothing to animate: stop costing a frame callback until the next splash.
      if (!active) this.stop();
    });
  }

  /**
   * Advance the crown and turn what came back down into ripples.
   *
   * The handoff is the point of the Epic tier. A droplet that falls back
   * through the surface does not fade out in mid-air — it leaves a small ring
   * where it landed, so the crown and the static water are one effect rather
   * than two playing at once. The ripples are quiet on purpose: many small
   * rings from one splash, not many splashes.
   *
   * Returns whether anything is still in the air, so the frame callback can
   * shut down once the last droplet has landed.
   */
  private updateDroplets(dt: number): boolean {
    if (!this.droplets) return false;

    const reentries = this.droplets.update(dt);
    this.fluid?.update(this.droplets.count);

    let placed = false;
    for (const hit of reentries) {
      // Only the harder landings earn a ring; the rest of the crown simply
      // rejoins the water. Every droplet ringing would use the whole pool on
      // one splash and leave nothing for the next.
      if (hit.speed < REENTRY_RING_SPEED) continue;
      this.placeRing(hit, "water", REENTRY_RING_STRENGTH);
      placed = true;
    }

    // `placed` matters on the frame the LAST droplet lands: the ring loop above
    // already ran and saw nothing, the count is now zero, and without this the
    // callback would shut down leaving that final ripple frozen on the water.
    return placed || this.droplets.count > 0;
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

  /** Droplets in flight. For tests and the debug command. */
  get activeDroplets(): number {
    return this.droplets?.aliveCount ?? 0;
  }

  /** Edge-clamped radius of the most recently spawned ring. Test/debug only. */
  get lastRingMaxRadius(): number | null {
    return this.lastSpawned?.maxRadius ?? null;
  }

  dispose(): void {
    this.stop();
    this.disableCrowns();
    for (const ring of this.rings) {
      ring.mesh.dispose();
      ring.material.dispose();
    }
    this.rings.length = 0;
    this.bodies.clear();
    this.projectiles.clear();

    const mask = ringMaskByScene.get(this.scene);
    if (mask) {
      mask.dispose();
      ringMaskByScene.delete(this.scene);
    }
  }
}

export { RING_END_RADIUS, RING_LIFETIME, RING_POOL_SIZE };
