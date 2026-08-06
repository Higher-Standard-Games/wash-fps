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
import { enterSound, exitSound, playLiquidCrossing, splashVolume } from "../../client/FPSLiquidAudio";
import type { LiquidKind, WaterLevel } from "../LiquidTypes";

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
}

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

  /** Forget a player who left, so their id cannot resurrect a stale level. */
  forget(entityId: string): void {
    this.bodies.delete(entityId);
  }

  private spawnRing(position: { x: number; y: number; z: number }, kind: LiquidKind, strength: number): void {
    const ring = this.acquireRing();
    if (!ring) return;

    ring.mesh.position.set(position.x, position.y, position.z);
    ring.material.emissiveColor = RING_COLORS[kind];
    ring.material.alpha = 0.55 * strength;
    ring.mesh.scaling.setAll(RING_START_RADIUS);
    ring.mesh.setEnabled(true);
    ring.age = 0;

    this.start();
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

    return { mesh, material, age: RING_LIFETIME };
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
        ring.mesh.scaling.setAll(RING_START_RADIUS + (RING_END_RADIUS - RING_START_RADIUS) * eased);
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
