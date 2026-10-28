/**
 * DroppedWeaponRenderer — entity-driven lifecycle, the server's own throw.
 *
 * Architecture:
 *   Lifecycle : Server-authoritative via entity snapshots (spawn/despawn)
 *   Motion    : The shared item throw (shared/items/ItemThrow), replayed from
 *               the drop's start over the same collision world the server
 *               steps it through, so it lands where the server puts it
 *   Materials : Cloned from AssetPreloader cache or fresh ModelLoader load
 *
 * Flow:
 *   1. weapon_drop event → stash the throw's start and velocity
 *   2. syncServerEntities() sees new item_ entity → spawn model, start the throw
 *   3. The throw steps at the server's rate until it settles; the model spins
 *      while airborne and comes to rest on its side
 *   4. A weapon seen without its drop event (joined late) eases to the
 *      server's position
 *   5. Entity gone from snapshot → dispose visual
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import { background } from "../../../engine/core/AsyncErrors";
import { applySafeMaxSimultaneousLights } from "../../../engine/lighting/DynamicLightSafety";
import { BspManager } from "../../../engine/loader/bsp/BspManager";
import { ModelInstanceCache } from "../../../engine/loader/model/ModelInstanceCache";
import type { ModelLoadResult } from "../../../engine/loader/model/ModelLoader";
import { bindLoaderLeftovers, disposeModelResources } from "../../../engine/loader/model/ModelSourceCache";
import { getCollisionManager } from "../../../engine/physics/CollisionManager";
import { SweepBackendAdapter } from "../../../engine/physics/SweepBackendAdapter";
import {
  attachWorldBarrels,
  loadBarrelSource,
  prepareWorldWeaponMaterials,
} from "../../../engine/weapon/WeaponBarrels";
import { dropDistantWeaponDetail } from "../../../engine/weapon/WeaponDetail";
import { describeModelRender } from "../../../engine/world/ModelRenderAudit";
import type { CollisionWorld } from "../../../shared/collision/CollisionWorld";
import { SharedCollisionWorld } from "../../../shared/collision/SharedCollisionWorld";
import { EntityRegistry } from "../../../shared/entities/EntityRegistry";
import type { WeaponDef } from "../../../shared/entities/WeaponDef";
import type { FPSController } from "../camera/FPSController";
import { DROPPED_WEAPON_BOUNCE, ITEM_STEP_SECONDS, stepThrownItem, type ThrownItem } from "../shared/items/ItemThrow";
import { hidePickupPrompt, showPickupPrompt } from "../world/PickupPrompt";
import { FPS, getActionKeyLabel } from "./FPSActions";

/** Permanent default melee weapon (slot 0) — always free to drop, never prompts. */
function isDefaultWeapon(w: string | null): boolean {
  return w === "blade";
}

/** Data passed from GameEvents per item_ entity in snapshot */
export interface DroppedWeaponInfo {
  x: number;
  y: number;
  z: number;
  weaponId?: string;
  settled?: boolean;
}

const activeDroppedWeaponVisuals = new Set<DroppedWeaponVisual>();

interface DroppedModelSources {
  main(path: string, scale: number): Promise<ModelLoadResult | null>;
  barrel(path: string): Promise<ModelLoadResult | null>;
}

/** The start of a weapon's throw, from its weapon_drop event. */
export interface DropThrow {
  start: Vector3;
  velocity: Vector3;
}

/** The collision world items are thrown through, for the current map's sweep backend. */
let throwWorld: { sweep: object; world: CollisionWorld } | null = null;
function itemCollisionWorld(): CollisionWorld | null {
  const sweep = getCollisionManager().getSweepBackend();
  if (!sweep) return null;
  if (throwWorld?.sweep !== sweep)
    throwWorld = { sweep, world: new SharedCollisionWorld(new SweepBackendAdapter(sweep)) };
  return throwWorld.world;
}

/** Most a frame advances a throw: a stalled tab catches up without a burst of steps. */
const MAX_THROW_CATCHUP_SECONDS = 0.25;
/** How fast a landed weapon's tumble eases onto its side (per second). */
const SETTLE_LEVEL_RATE = 6;
/** Vertical speed either side of a step that makes it a bounce (units/s). */
const BOUNCE_SPEED = 20;
/** Spin kept through a bounce off the floor. */
const BOUNCE_SPIN_KEPT = 0.5;
/** Spin kept per throw step while sliding along the floor. */
const SLIDE_SPIN_KEPT = 0.96;
/** Roll per unit slid, so a sliding gun rolls with its speed (radians per unit). */
const SLIDE_ROLL_PER_UNIT = 0.02;

/** Visual representation of a single dropped weapon */
class DroppedWeaponVisual {
  readonly entityId: string;
  readonly weaponId: string;
  mesh: Mesh | null = null;
  private scene: Scene;
  private disposed: boolean = false;
  private readonly useServerTransforms: boolean;
  private loadSource: "pending" | "cache-flat" | "cached-fallback" = "pending";
  /** Server's authoritative position */
  private serverPosition: Vector3 = Vector3.Zero();
  /** The server's throw replayed here, or null when only the server's position is known */
  private throw: ThrownItem | null = null;
  private readonly throwWorld: CollisionWorld | null;
  /** Where the throw was one step ago, for drawing between steps */
  private readonly throwPrevious = new Vector3();
  private throwElapsed = 0;
  private lastUpdateMs = performance.now();
  /** Airborne spin (yaw), roll around the barrel (x) and end-over-end tumble (z), radians per second */
  private spin = (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 4);
  private rollRate = (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 5);
  private tumbleRate = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 4);
  private yaw = Math.random() * Math.PI * 2;
  private roll = 0;
  private tumble = 0;
  /** Whether the camera can see it (set by the renderer, applied once the model is in). */
  private visible = true;

  constructor(
    entityId: string,
    weaponId: string,
    scene: Scene,
    position: Vector3,
    private readonly sources: DroppedModelSources,
    thrown?: DropThrow,
    useServerTransforms = false,
  ) {
    this.entityId = entityId;
    this.weaponId = weaponId;
    this.scene = scene;
    this.useServerTransforms = useServerTransforms;
    this.serverPosition.copyFrom(position);
    this.throwWorld = useServerTransforms ? null : itemCollisionWorld();
    if (thrown && this.throwWorld) {
      this.throw = {
        position: { x: thrown.start.x, y: thrown.start.y, z: thrown.start.z },
        velocity: { x: thrown.velocity.x, y: thrown.velocity.y, z: thrown.velocity.z },
        settled: false,
        bounce: DROPPED_WEAPON_BOUNCE,
      };
      this.throwPrevious.copyFrom(thrown.start);
    }
    activeDroppedWeaponVisuals.add(this);
    background(this.loadModel(this.throw ? thrown!.start : position), "DroppedWeaponRenderer");
  }

  private async loadModel(position: Vector3): Promise<void> {
    if (this.disposed) return;

    try {
      // Look up model path from EntityRegistry
      const registry = EntityRegistry.getInstance();
      const def = registry.get<WeaponDef>(this.weaponId);
      const modelPath = def?.modelPath || `models/weapons/${this.weaponId}/${this.weaponId}.md3`;
      const defScale = def?.scale ?? 1.5;

      // Try AssetPreloader cache first for instant spawn
      let result: ModelLoadResult | null = null;
      try {
        const { AssetPreloader } = await import("../../../engine/loader/AssetPreloader");
        const preloader = AssetPreloader.getInstance();
        if (preloader.hasModel(modelPath)) {
          result = preloader.cloneCachedModel(modelPath, this.scene);
          if (result) this.loadSource = "cache-flat";
        }
      } catch {
        // Preloader not available
      }

      // Models absent from the BSP preloader get one shared source per renderer.
      if (!result) {
        result = await this.sources.main(modelPath, defScale);
        if (result) this.loadSource = "cached-fallback";
      }

      // If disposed during async load, clean up and bail
      if (this.disposed) {
        if (result?.root) disposeModelResources([result.root], result);
        return;
      }

      if (result?.root) {
        // Find leader mesh (first mesh with geometry) — same pattern as Pickup.loadModel
        let leaderMesh: Mesh | null = null;
        const otherMeshes: Mesh[] = [];

        prepareWorldWeaponMaterials(result.meshes);
        for (const m of result.meshes) {
          if (m instanceof Mesh && m.getTotalVertices() > 0) {
            // Cap lights to prevent shader uniform block overflow
            if (m.material && "maxSimultaneousLights" in m.material) {
              applySafeMaxSimultaneousLights(m.material);
            }
            if (!leaderMesh) {
              leaderMesh = m;
            } else {
              otherMeshes.push(m);
            }
          }
        }

        if (leaderMesh) {
          // A root-level mesh, placed and turned in world space by update()
          leaderMesh.parent = null;
          leaderMesh.name = `droppedWeapon_${this.entityId}`;
          leaderMesh.position.copyFrom(position);
          leaderMesh.rotationQuaternion = null;
          leaderMesh.rotation.setAll(0);
          leaderMesh.isVisible = true;
          leaderMesh.scaling.setAll(defScale);

          // Parent other meshes under leader (they move with it)
          for (const m of otherMeshes) {
            m.parent = leaderMesh;
            m.position.setAll(0);
            m.rotationQuaternion = null;
            m.rotation.setAll(0);
            m.isVisible = true;
          }

          this.mesh = leaderMesh;
          this.mesh.setEnabled(this.visible);
          // Bind before awaiting barrels: a pickup/map disposal during that
          // await must also release the main model's detached rig and clips.
          result.root.parent = null;
          result.root.setEnabled(false);
          bindLoaderLeftovers(leaderMesh, result.root, result.animationGroups);

          // === BARREL SUB-MODELS === (e.g. the plasmagun's dual chambers)
          await attachWorldBarrels({
            leader: leaderMesh,
            barrels: def?.barrels ?? [],
            attachmentPoints: result.attachmentPoints,
            scene: this.scene,
            load: (path) => this.sources.barrel(path),
            adopt: (barrel) => bindLoaderLeftovers(leaderMesh, barrel.root, barrel.animationGroups),
            stale: () => this.disposed,
            label: "DroppedWeapon",
          });
        }

        if (!leaderMesh) disposeModelResources([result.root], result);
      }
    } catch (e) {
      console.error(`[DroppedWeaponVisual] Failed to load model for ${this.weaponId}:`, e);
    }
  }

  /**
   * Draw it or not. A hidden weapon keeps its model and its throw: out of
   * view is not gone, and rebuilding it on the way back in re-tossed it.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.mesh?.setEnabled(visible);
  }

  /** Where it is drawn: the model once loaded, the server's position before. */
  get position(): Vector3 {
    return this.mesh?.position ?? this.serverPosition;
  }

  /** Whether it has come to rest: its throw settled, or the server said so. */
  get resting(): boolean {
    return this.throw ? this.throw.settled : this.serverSettled;
  }
  private serverSettled = false;

  setServerPosition(x: number, y: number, z: number, settled = false): void {
    this.serverPosition.set(x, y, z);
    this.serverSettled = settled;
    if (this.useServerTransforms && this.mesh) {
      this.mesh.position.copyFrom(this.serverPosition);
    }
  }

  /**
   * Turn the model's spin with what the throw did this step: a bounce knocks
   * spin out of it and jolts it a little; sliding on the floor rolls it with
   * its speed while the spin dies away.
   */
  private reactToStep(fallingBefore: number): void {
    const velocity = this.throw!.velocity;
    // A real fall turned into a real rise: the slide move leaves a sliver of
    // upward speed on a dead landing, which is not a bounce
    if (fallingBefore < -BOUNCE_SPEED && velocity.y > BOUNCE_SPEED) {
      this.spin *= BOUNCE_SPIN_KEPT;
      this.tumbleRate = this.tumbleRate * BOUNCE_SPIN_KEPT + (Math.random() - 0.5) * 4;
      this.rollRate = this.rollRate * BOUNCE_SPIN_KEPT + (Math.random() - 0.5) * 4;
    } else if (velocity.y === 0) {
      const sliding = Math.hypot(velocity.x, velocity.z);
      this.spin *= SLIDE_SPIN_KEPT;
      this.tumbleRate *= SLIDE_SPIN_KEPT;
      this.rollRate = this.rollRate * SLIDE_SPIN_KEPT + Math.sign(this.rollRate || 1) * sliding * SLIDE_ROLL_PER_UNIT;
    }
  }

  /** Update each frame: step the throw, place and turn the model. */
  update(): void {
    const now = performance.now();
    const dt = Math.min(MAX_THROW_CATCHUP_SECONDS, (now - this.lastUpdateMs) / 1000);
    this.lastUpdateMs = now;
    const mesh = this.mesh;

    let between = 0;
    if (this.throw && this.throwWorld && !this.throw.settled) {
      this.throwElapsed += dt;
      while (this.throwElapsed >= ITEM_STEP_SECONDS && !this.throw.settled) {
        const { x, y, z } = this.throw.position;
        this.throwPrevious.set(x, y, z);
        const falling = this.throw.velocity.y;
        stepThrownItem(this.throw, this.throwWorld);
        this.reactToStep(falling);
        this.throwElapsed -= ITEM_STEP_SECONDS;
      }
      between = this.throw.settled ? 1 : this.throwElapsed / ITEM_STEP_SECONDS;
    }
    if (!mesh || this.useServerTransforms) return;

    if (this.throw && !(this.throw.settled && this.serverSettled)) {
      // The server's path, drawn between its steps
      const { x, y, z } = this.throw.position;
      const from = this.throwPrevious;
      mesh.position.set(
        from.x + (x - from.x) * between,
        from.y + (y - from.y) * between,
        from.z + (z - from.z) * between,
      );
    } else if (this.throw) {
      // Both at rest. The drop's start crossed the network rounded, so a throw
      // that slid along an edge can stop a little off the server's spot,
      // where the pickup is: settle onto it gently
      Vector3.LerpToRef(mesh.position, this.serverPosition, Math.min(1, dt * 4), mesh.position);
    } else {
      // Only the server's word: follow it, without the jumps of its snapshot rate
      Vector3.LerpToRef(mesh.position, this.serverPosition, Math.min(1, dt * 20), mesh.position);
    }

    // Spinning, rolling and tumbling while it flies. At rest it lies flat on
    // whichever side it was nearer to, at its last heading: on its side a gun
    // is thin enough to lie on the floor, where upright its grip would sink in
    if (this.resting) {
      const ease = Math.min(1, dt * SETTLE_LEVEL_RATE);
      const side = Math.round((this.roll - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
      const flat = Math.round(this.tumble / Math.PI) * Math.PI;
      this.roll += (side - this.roll) * ease;
      this.tumble += (flat - this.tumble) * ease;
    } else {
      this.yaw += this.spin * dt;
      this.roll += this.rollRate * dt;
      this.tumble += this.tumbleRate * dt;
    }
    mesh.rotation.set(this.roll, this.yaw, this.tumble);
  }

  dispose(): void {
    this.disposed = true;
    activeDroppedWeaponVisuals.delete(this);
    if (this.mesh) {
      if (!this.mesh.isDisposed()) {
        // The weapon, its parts and barrels, and the loader leftovers bound to
        // it. Materials shared with the AssetPreloader cache and other clones
        // are still drawn by them, so they stay; ones only this weapon used go.
        disposeModelResources([this.mesh]);
      }
      this.mesh = null;
    }
  }

  describeModelForAudit(): string {
    if (!this.mesh) return `${this.entityId}:${this.weaponId} source=${this.loadSource} model=NONE`;
    return `${this.entityId}:${this.weaponId} source=${this.loadSource},${describeModelRender(this.mesh, this.scene)}`;
  }
}

/** A dropped weapon's small parts stop drawing at range, as held weapons' do. */
function withDistantDetailDropped(result: ModelLoadResult | null): ModelLoadResult | null {
  if (result) dropDistantWeaponDetail(result.meshes);
  return result;
}

export class DroppedWeaponRenderer {
  private scene: Scene;
  private disposed = false;
  private weapons: Map<string, DroppedWeaponVisual> = new Map();
  private fallbackCache?: ModelInstanceCache;
  private barrelCache?: ModelInstanceCache;
  private readonly sources: DroppedModelSources = {
    main: (path, scale) => this.loadFallbackModel(path, scale),
    barrel: (path) => this.loadBarrelModel(path),
  };

  private async loadFallbackModel(path: string, scale: number): Promise<ModelLoadResult | null> {
    if (this.disposed || this.scene.isDisposed) return null;
    const { ModelLoader } = await import("../../../engine/loader/model/ModelLoader");
    if (this.disposed || this.scene.isDisposed) return null;
    this.fallbackCache ??= new ModelInstanceCache(
      this.scene,
      async (modelPath, modelScale) => {
        const loader = ModelLoader.getInstance();
        if (!loader.isInitialized()) loader.init(this.scene);
        return loader.loadModel(modelPath, {
          position: Vector3.Zero(),
          scale: modelScale,
          hasCollision: false,
          applyLighting: false,
        });
      },
      // A drop only moves and fades its meshes; its read-only PBR materials are
      // shared, so a death in a fight builds no new material. WebGPU keeps
      // clones, as remote held weapons do.
      { shareStaticMaterials: !this.scene.getEngine().isWebGPU },
    );
    return withDistantDetailDropped(await this.fallbackCache.createInstance(path, scale));
  }

  private async loadBarrelModel(path: string): Promise<ModelLoadResult | null> {
    if (this.disposed || this.scene.isDisposed) return null;
    this.barrelCache ??= new ModelInstanceCache(
      this.scene,
      async (modelPath) => {
        if (this.disposed || this.scene.isDisposed) return null;
        const source = await loadBarrelSource(modelPath, this.scene, "droppedBarrelSource");
        if (this.disposed || this.scene.isDisposed) {
          disposeModelResources([source.root], source);
          return null;
        }
        return source;
      },
      { shareStaticMaterials: !this.scene.getEngine().isWebGPU },
    );
    return withDistantDetailDropped(await this.barrelCache.createInstance(path, 1));
  }

  /** Throws stashed from weapon_drop events (entityId → throw, when) */
  private pendingThrows: Map<string, { thrown: DropThrow; atMs: number }> = new Map();

  /** How long after its weapon_drop event a weapon first seen is still in the air. */
  private static readonly TOSS_FRESH_MS = 500;

  /** Currently tracked nearby dropped weapon for F prompt */
  private static nearbyDroppedWeapon: DroppedWeaponVisual | null = null;

  static auditModelState(): string {
    const entries = [...activeDroppedWeaponVisuals].map((visual) => visual.describeModelForAudit());
    return `pickup_audit: dropped weapons: ${entries.length > 0 ? entries.join("; ") : "none"}`;
  }

  /** Moves and turns every dropped weapon each frame, between server updates */
  private readonly frameObserver: Observer<Scene> | null;

  constructor(
    scene: Scene,
    private readonly useServerTransforms = false,
  ) {
    this.scene = scene;
    this.frameObserver = scene.onBeforeRenderObservable?.add(() => this.updateVisuals()) ?? null;
  }

  /** Step each weapon's throw and place its model for this frame. */
  updateVisuals(): void {
    for (const visual of this.weapons.values()) visual.update();
  }

  /**
   * Stash a throw from its weapon_drop event.
   * Called from GameEvents when weapon_drop fires — the throw is replayed
   * when the corresponding item_ entity appears in snapshot.
   */
  stashThrow(entityId: string, thrown: DropThrow): void {
    this.pendingThrows.set(entityId, { thrown, atMs: performance.now() });
    // Auto-clean after 5 seconds (if entity never appears)
    setTimeout(() => this.pendingThrows.delete(entityId), 5000);
  }

  /**
   * Sync with server entity state — the ONLY entry point for lifecycle management.
   * Called each frame with all item_ entities from the server snapshot.
   *
   * - New entity → spawn visual, replaying its throw when its drop was seen
   * - Existing entity → step its throw, or follow the server's position
   * - Missing entity → dispose visual (the server sends every
   *   dropped weapon regardless of PVS, so missing means picked up or expired)
   * - Out of the camera's PVS → hidden, kept
   */
  syncServerEntities(entities: Map<string, DroppedWeaponInfo>): void {
    if (this.disposed) return;
    // 1. Remove visuals for entities that server no longer sends
    const toRemove: string[] = [];
    for (const entityId of this.weapons.keys()) {
      if (!entities.has(entityId)) {
        toRemove.push(entityId);
      }
    }
    for (const entityId of toRemove) {
      const visual = this.weapons.get(entityId);
      if (visual) {
        // Clear prompt if this weapon was the nearby one
        if (DroppedWeaponRenderer.nearbyDroppedWeapon === visual) {
          DroppedWeaponRenderer.nearbyDroppedWeapon = null;
          hidePickupPrompt("dropped");
        }
        visual.dispose();
        this.weapons.delete(entityId);
      }
    }

    // 2. Update existing or spawn new visuals
    for (const [entityId, info] of entities) {
      const existing = this.weapons.get(entityId);
      if (existing) {
        // Update server position + glow/lerp
        existing.setServerPosition(info.x, info.y, info.z, info.settled);
      } else if (info.weaponId) {
        // New entity — spawn visual
        // A toss only while the drop is fresh. One first seen seconds later has
        // landed: thrown again from there, it hopped off its resting place (W7).
        const pending = this.pendingThrows.get(entityId);
        this.pendingThrows.delete(entityId);
        const thrown =
          pending && performance.now() - pending.atMs <= DroppedWeaponRenderer.TOSS_FRESH_MS
            ? pending.thrown
            : undefined;

        const visual = new DroppedWeaponVisual(
          entityId,
          info.weaponId,
          this.scene,
          new Vector3(info.x, info.y, info.z),
          this.sources,
          thrown,
          this.useServerTransforms,
        );
        this.weapons.set(entityId, visual);
      }
    }

    // 3. Hide what the camera cannot see. The server sends every dropped weapon
    // (a missing one is gone), so PVS here only decides what is drawn, the same
    // check remote players use.
    const culler = BspManager.getInstance().getPvsCuller();
    for (const visual of this.weapons.values()) {
      visual.setVisible(!culler || culler.isPositionVisible(visual.position));
    }

    // 4. Check pickup proximity for live play only. Demo snapshot mode is
    // presentation-only and must never expose an interactive swap prompt.
    if (!this.useServerTransforms) this.checkPickupProximity();
  }

  /**
   * Check player proximity to dropped weapons and show/hide swap prompt.
   * Same cylindrical distance check as Pickup.checkPickup().
   */
  private checkPickupProximity(): void {
    // Lazy-import to avoid circular dependencies
    background(this._checkPickupProximityAsync(), "DroppedWeaponRenderer");
  }

  private _cachedCameraModule: typeof import("../../../engine/camera/CameraSystem") | null = null;
  private _cachedInventoryModule: typeof import("../world/InventoryManager") | null = null;
  private _pickupModulesLoading = false;

  private async _checkPickupProximityAsync(): Promise<void> {
    if (this.disposed || this._pickupModulesLoading) return;
    if (!this._cachedCameraModule || !this._cachedInventoryModule) {
      this._pickupModulesLoading = true;
      try {
        // Publish both modules together. A snapshot arriving between sequential
        // imports must not mistake the camera cache for complete initialization.
        [this._cachedCameraModule, this._cachedInventoryModule] = await Promise.all([
          import("../../../engine/camera/CameraSystem"),
          import("../world/InventoryManager"),
        ]);
      } catch {
        return;
      } finally {
        this._pickupModulesLoading = false;
      }
    }
    if (this.disposed) return;

    const { CameraSystem } = this._cachedCameraModule;
    const { InventoryManager } = this._cachedInventoryModule;

    const camera = CameraSystem.getInstance().getCamera();
    if (!camera) return;

    const activeController = CameraSystem.getInstance().getActiveController();
    if (activeController?.type === "freefly" || !document.pointerLockElement) {
      if (DroppedWeaponRenderer.nearbyDroppedWeapon) {
        DroppedWeaponRenderer.nearbyDroppedWeapon = null;
        hidePickupPrompt("dropped");
      }
      return;
    }

    // Get player position
    let playerPos = camera.position;
    if (activeController && typeof activeController.getPlayerPosition === "function") {
      playerPos = activeController.getPlayerPosition();
    }

    // Get inventory
    const inventory = activeController?.type === "fps" ? (activeController as FPSController).inventory : null;

    // Find nearest dropped weapon in range
    let nearest: DroppedWeaponVisual | null = null;
    let nearestDistSq = Infinity;

    const pickupRadius = 96;
    const pickupRadiusSq = pickupRadius * pickupRadius;
    const verticalRangeMin = -24;
    const verticalRangeMax = 88;

    for (const visual of this.weapons.values()) {
      if (!visual.mesh) continue;
      const meshPos = visual.mesh.getAbsolutePosition();

      const dx = playerPos.x - meshPos.x;
      const dz = playerPos.z - meshPos.z;
      const dy = playerPos.y - meshPos.y;
      const horizDistSq = dx * dx + dz * dz;

      if (horizDistSq < pickupRadiusSq && dy > verticalRangeMin && dy < verticalRangeMax) {
        if (horizDistSq < nearestDistSq) {
          nearestDistSq = horizDistSq;
          nearest = visual;
        }
      }
    }

    if (nearest) {
      // Check if player needs to swap (at capacity + doesn't have weapon + not
      // holding the default weapon — which is always free to drop).
      const alreadyHas = inventory ? inventory.hasWeapon(nearest.weaponId) : false;
      const hasRoom = inventory ? inventory.getSlotCount() < InventoryManager.MAX_WEAPONS : false;

      if (alreadyHas || hasRoom) {
        // Auto-pickup by server, no prompt needed
        if (DroppedWeaponRenderer.nearbyDroppedWeapon) {
          DroppedWeaponRenderer.nearbyDroppedWeapon = null;
          hidePickupPrompt("dropped");
        }
      } else {
        const currentWeapon = inventory ? inventory.getCurrentWeaponId() : null;
        // Holding the default melee (blade) → server auto-swaps silently, so
        // never show the swap prompt.
        if (isDefaultWeapon(currentWeapon)) {
          if (DroppedWeaponRenderer.nearbyDroppedWeapon) {
            DroppedWeaponRenderer.nearbyDroppedWeapon = null;
            hidePickupPrompt("dropped");
          }
        } else {
          // Show swap prompt
          if (DroppedWeaponRenderer.nearbyDroppedWeapon !== nearest) {
            DroppedWeaponRenderer.nearbyDroppedWeapon = nearest;
            const weaponName = nearest.weaponId.replace(/_/g, " ").toUpperCase();
            showPickupPrompt("dropped", `PRESS [${getActionKeyLabel(FPS.USE)}] TO SWAP TO ${weaponName}`);
          }
        }
      }
    } else {
      if (DroppedWeaponRenderer.nearbyDroppedWeapon) {
        DroppedWeaponRenderer.nearbyDroppedWeapon = null;
        hidePickupPrompt("dropped");
      }
    }
  }

  /** Get count of active dropped weapons (for debug). */
  get count(): number {
    return this.weapons.size;
  }

  /** Dispose all weapons. */
  dispose(): void {
    this.disposed = true;
    if (this.frameObserver) this.scene.onBeforeRenderObservable.remove(this.frameObserver);
    DroppedWeaponRenderer.nearbyDroppedWeapon = null;
    hidePickupPrompt("dropped");
    for (const visual of this.weapons.values()) {
      visual.dispose();
    }
    this.weapons.clear();
    this.pendingThrows.clear();
    this.fallbackCache?.dispose();
    this.barrelCache?.dispose();
  }
}
