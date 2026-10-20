/**
 * DroppedWeaponRenderer — Hybrid: entity-driven lifecycle + client Havok physics.
 *
 * Architecture:
 *   Lifecycle : Server-authoritative via entity snapshots (spawn/despawn)
 *   Physics   : Client-side Havok (arc, tumble, settle, BSP collision)
 *   Materials : Cloned from AssetPreloader cache or fresh ModelLoader load
 *
 * Flow:
 *   1. weapon_drop event → stash initial velocity (velX/Y/Z) in pendingVelocities
 *   2. syncServerEntities() sees new item_ entity → spawn model + Havok body
 *   3. Havok handles visual physics (gravity, tumble, collision with BSP trimesh)
 *   4. Once settled, Havok body frozen — position locked
 *   5. Entity gone from snapshot → dispose Havok body + visual
 */

import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { Scene } from "@babylonjs/core/scene";
import { background } from "../../../engine/core/AsyncErrors";
import { applySafeMaxSimultaneousLights } from "../../../engine/lighting/DynamicLightSafety";
import { BspManager } from "../../../engine/loader/bsp/BspManager";
import { ModelInstanceCache } from "../../../engine/loader/model/ModelInstanceCache";
import type { ModelLoadResult } from "../../../engine/loader/model/ModelLoader";
import { bindLoaderLeftovers, disposeModelResources } from "../../../engine/loader/model/ModelSourceCache";
import { describeModelRender } from "../../../engine/world/ModelRenderAudit";
import { EntityRegistry } from "../../../shared/entities/EntityRegistry";
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

/** Visual representation of a single dropped weapon with Havok physics */
class DroppedWeaponVisual {
  readonly entityId: string;
  readonly weaponId: string;
  mesh: Mesh | null = null;
  private scene: Scene;
  private disposed: boolean = false;
  private settled: boolean = false;
  private settleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly useServerTransforms: boolean;
  hasPhysics: boolean = false;
  private loadSource: "pending" | "cache-flat" | "cached-fallback" = "pending";
  /** Server's authoritative position — used to align visual after Havok settles */
  private serverPosition: Vector3 = Vector3.Zero();
  /** Whether the camera can see it (set by the renderer, applied once the model is in). */
  private visible = true;

  constructor(
    entityId: string,
    weaponId: string,
    scene: Scene,
    position: Vector3,
    private readonly sources: DroppedModelSources,
    velocity?: Vector3,
    useServerTransforms = false,
  ) {
    this.entityId = entityId;
    this.weaponId = weaponId;
    this.scene = scene;
    this.useServerTransforms = useServerTransforms;
    this.serverPosition.copyFrom(position);
    activeDroppedWeaponVisuals.add(this);
    background(this.loadModel(position, velocity), "DroppedWeaponRenderer");
  }

  private async loadModel(position: Vector3, velocity?: Vector3): Promise<void> {
    if (this.disposed) return;

    try {
      // Look up model path from EntityRegistry
      const registry = EntityRegistry.getInstance();
      const def = registry.get(this.weaponId) as any;
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

        for (const m of result.meshes) {
          if (m instanceof Mesh && m.getTotalVertices() > 0) {
            // Cap lights to prevent shader uniform block overflow
            if (m.material && "maxSimultaneousLights" in m.material) {
              applySafeMaxSimultaneousLights(m.material as any);
            }
            if (!leaderMesh) {
              leaderMesh = m;
            } else {
              otherMeshes.push(m);
            }
          }
        }

        if (leaderMesh) {
          // CRITICAL: Havok needs root-level mesh (no parent).
          // This is identical to how Pickup.loadModel works.
          leaderMesh.parent = null;
          // Unique name so PhysicsSystem body map doesn't collide
          leaderMesh.name = `droppedWeapon_${this.entityId}`;
          leaderMesh.position.copyFrom(position);
          leaderMesh.rotationQuaternion = null;
          leaderMesh.rotation.setAll(0);
          leaderMesh.isVisible = true;
          leaderMesh.scaling.setAll(defScale);

          // Parent other meshes under leader (follow Havok movement)
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

          // === BARREL SUB-MODELS ===
          // Load barrel GLBs (e.g. plasmagun dual chambers) and parent to leader
          const barrelDefs = (def as any)?.barrels as
            | Array<{ modelPath: string; offset?: { x: number; y: number; z: number } }>
            | undefined;
          if (barrelDefs?.length) {
            // Load tags.txt for bone-based positioning
            const firstPath = barrelDefs[0].modelPath;
            const modelDir = firstPath.substring(0, firstPath.lastIndexOf("/") + 1);
            const { loadTags, findTag } = await import("../../../engine/loader/model/TagsLoader");
            const tags = await loadTags(modelDir);
            const barrelTag = findTag(tags, "tag_barrel");
            const attachment =
              (barrelTag?.boneName && result.attachmentPoints?.[barrelTag.boneName]) ||
              result.attachmentPoints?.tag_barrel;

            // Find bone position if tag references a bone
            let boneOffX = attachment?.position.x ?? 0,
              boneOffY = attachment?.position.y ?? 0,
              boneOffZ = attachment?.position.z ?? 0;
            if (!attachment && barrelTag?.boneName) {
              for (const skeleton of this.scene.skeletons) {
                const bone = skeleton.bones.find((b) => b.name === barrelTag.boneName);
                if (bone) {
                  const boneNode = bone.getTransformNode();
                  if (boneNode) {
                    boneOffX = boneNode.position.x;
                    boneOffY = boneNode.position.y;
                    boneOffZ = boneNode.position.z;
                    break;
                  }
                }
              }
            }

            for (const barrelDef of barrelDefs) {
              if (this.disposed) break;
              try {
                const barrelResult = await this.sources.barrel(barrelDef.modelPath);
                if (!barrelResult) continue;
                if (this.disposed) {
                  disposeModelResources([barrelResult.root], barrelResult);
                  break;
                }
                bindLoaderLeftovers(leaderMesh, barrelResult.root, barrelResult.animationGroups);
                const barrelRoot = barrelResult.meshes[0];
                if (barrelRoot) {
                  barrelRoot.parent = leaderMesh;
                  // Apply: bone position + tag offset + per-barrel def offset
                  const tagOff = barrelTag?.offset;
                  const defOff = barrelDef.offset;
                  barrelRoot.position.set(
                    boneOffX + (tagOff?.x ?? 0) + (defOff?.x ?? 0),
                    boneOffY + (tagOff?.y ?? 0) + (defOff?.y ?? 0),
                    boneOffZ + (tagOff?.z ?? 0) + (defOff?.z ?? 0),
                  );
                  if (attachment?.rotationQuaternion) {
                    const q = attachment.rotationQuaternion;
                    barrelRoot.rotationQuaternion = new Quaternion(q.x, q.y, q.z, q.w);
                  } else if (attachment) {
                    barrelRoot.rotationQuaternion = null;
                    barrelRoot.rotation.copyFrom(attachment.rotation);
                  } else if (tagOff) {
                    barrelRoot.rotationQuaternion = null;
                    barrelRoot.rotation.set(barrelTag!.rotation.x, barrelTag!.rotation.y, barrelTag!.rotation.z);
                  } else {
                    barrelRoot.rotationQuaternion = null;
                    barrelRoot.rotation.setAll(0);
                  }
                  for (const bm of barrelResult.meshes) {
                    if (bm.material && "maxSimultaneousLights" in bm.material) {
                      applySafeMaxSimultaneousLights(bm.material as any);
                    }
                  }
                }
              } catch (e) {
                console.warn(`[DroppedWeapon] Barrel load failed:`, e);
              }
            }
          }

          // === HAVOK PHYSICS ===
          // Create dynamic body identical to Pickup.loadModel()
          const { PhysicsSystem } = await import("../../../engine/physics/PhysicsSystem");
          const physics = PhysicsSystem.getInstance();
          if (!this.useServerTransforms && physics.isInitialized() && !this.disposed) {
            physics.createDynamicBody(leaderMesh, PhysicsShapeType.CONVEX_HULL, 10, 0.3);
            this.hasPhysics = true;

            if (leaderMesh.physicsBody) {
              if (velocity) {
                // Toss arc from weapon_drop event velocity
                leaderMesh.physicsBody.setLinearVelocity(velocity);
              }
              // Random tumble rotation (same as Pickup)
              const randomRot = new Vector3(
                (Math.random() - 0.5) * 12,
                (Math.random() - 0.5) * 12,
                (Math.random() - 0.5) * 12,
              );
              leaderMesh.physicsBody.setAngularVelocity(randomRot);

              // Settle detection: freeze when velocity < 2
              this.scheduleSettleCheck();
            }
          }
        }

        if (!leaderMesh) disposeModelResources([result.root], result);
      }
    } catch (e) {
      console.error(`[DroppedWeaponVisual] Failed to load model for ${this.weaponId}:`, e);
    }
  }

  /** Settle detection — check velocity every 500ms, freeze when near-zero */
  private scheduleSettleCheck(): void {
    this.settleCheckTimer = setInterval(() => {
      if (this.disposed || !this.mesh?.physicsBody) {
        if (this.settleCheckTimer) clearInterval(this.settleCheckTimer);
        return;
      }
      const linVel = this.mesh.physicsBody.getLinearVelocity();
      const speed = linVel.length();
      if (speed < 2) {
        // Physics done: the weapon goes to the server's position from here.
        // A body left in the world, even stopped, had Havok write its place over
        // that lerp every step, so the weapon could rest away from where pickup
        // works, with the swap prompt showing where it fails (W3).
        const name = this.mesh.name;
        this.mesh.physicsBody.dispose();
        import("../../../engine/physics/PhysicsSystem")
          .then(({ PhysicsSystem }) => PhysicsSystem.getInstance().removeBody(name))
          .catch(() => {});
        this.settled = true;
        if (this.settleCheckTimer) clearInterval(this.settleCheckTimer);
      }
    }, 500);
  }

  /** Update server position from snapshot data */
  /**
   * Draw it or not. A hidden weapon keeps its model and physics body: out of
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

  setServerPosition(x: number, y: number, z: number): void {
    this.serverPosition.set(x, y, z);
    if (this.useServerTransforms && this.mesh) {
      this.mesh.position.copyFrom(this.serverPosition);
    }
  }

  /** Update each frame: lerp to server position after settle */
  update(): void {
    if (!this.mesh) return;

    // After Havok settles, lerp mesh to server's authoritative position
    // so visual matches the actual pickup zone
    if (this.settled && this.serverPosition.lengthSquared() > 0) {
      const lerpFactor = 0.15; // Smooth convergence over ~10 frames
      this.mesh.position.x += (this.serverPosition.x - this.mesh.position.x) * lerpFactor;
      this.mesh.position.y += (this.serverPosition.y - this.mesh.position.y) * lerpFactor;
      this.mesh.position.z += (this.serverPosition.z - this.mesh.position.z) * lerpFactor;
    }
  }

  dispose(): void {
    this.disposed = true;
    activeDroppedWeaponVisuals.delete(this);
    if (this.settleCheckTimer) {
      clearInterval(this.settleCheckTimer);
      this.settleCheckTimer = null;
    }
    if (this.mesh) {
      const meshName = this.mesh.name;
      // Clean up PhysicsSystem body map reference
      import("../../../engine/physics/PhysicsSystem")
        .then(({ PhysicsSystem }) => {
          PhysicsSystem.getInstance().removeBody(meshName);
        })
        .catch(() => {});
      if (!this.mesh.isDisposed()) {
        // Remove Havok body first
        if (this.mesh.physicsBody) {
          this.mesh.physicsBody.dispose();
        }
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
    this.fallbackCache ??= new ModelInstanceCache(this.scene, async (modelPath, modelScale) => {
      const loader = ModelLoader.getInstance();
      if (!loader.isInitialized()) loader.init(this.scene);
      return loader.loadModel(modelPath, {
        position: Vector3.Zero(),
        scale: modelScale,
        hasCollision: false,
        applyLighting: false,
      });
    });
    return this.fallbackCache.createInstance(path, scale);
  }

  private async loadBarrelModel(path: string): Promise<ModelLoadResult | null> {
    if (this.disposed || this.scene.isDisposed) return null;
    this.barrelCache ??= new ModelInstanceCache(this.scene, async (modelPath) => {
      const { ImportMeshAsync } = await import("@babylonjs/core/Loading/sceneLoader");
      if (this.disposed || this.scene.isDisposed) return null;
      const slash = modelPath.lastIndexOf("/");
      const result = await ImportMeshAsync(modelPath.substring(slash + 1), this.scene, {
        rootUrl: modelPath.substring(0, slash + 1),
      });
      if (this.disposed || this.scene.isDisposed) {
        disposeModelResources([...result.meshes, ...result.transformNodes], result);
        return null;
      }
      // Retain the original glTF root and authored transforms. A neutral wrapper
      // owns all imported nodes/rigs; the cloned glTF root is attached as before.
      const root = new TransformNode("droppedBarrelSource", this.scene);
      for (const node of [...result.transformNodes, ...result.meshes]) if (!node.parent) node.parent = root;
      return {
        root,
        meshes: result.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh),
        skeletons: result.skeletons,
        animationGroups: result.animationGroups,
        lights: [],
      };
    });
    return this.barrelCache.createInstance(path, 1);
  }

  /** Stashed initial velocities from weapon_drop events (entityId → velocity, when) */
  private pendingVelocities: Map<string, { velocity: Vector3; atMs: number }> = new Map();

  /** How long after its weapon_drop event a weapon first seen is still in the air. */
  private static readonly TOSS_FRESH_MS = 500;

  /** Currently tracked nearby dropped weapon for F prompt */
  private static nearbyDroppedWeapon: DroppedWeaponVisual | null = null;

  static auditModelState(): string {
    const entries = [...activeDroppedWeaponVisuals].map((visual) => visual.describeModelForAudit());
    return `pickup_audit: dropped weapons: ${entries.length > 0 ? entries.join("; ") : "none"}`;
  }

  constructor(
    scene: Scene,
    private readonly useServerTransforms = false,
  ) {
    this.scene = scene;
  }

  /**
   * Stash initial velocity from weapon_drop event.
   * Called from GameEvents when weapon_drop fires — the velocity is used
   * by Havok when the corresponding item_ entity appears in snapshot.
   */
  stashVelocity(entityId: string, velocity: Vector3): void {
    this.pendingVelocities.set(entityId, { velocity, atMs: performance.now() });
    // Auto-clean after 5 seconds (if entity never appears)
    setTimeout(() => this.pendingVelocities.delete(entityId), 5000);
  }

  /**
   * Sync with server entity state — the ONLY entry point for lifecycle management.
   * Called each frame with all item_ entities from the server snapshot.
   *
   * - New entity → spawn visual with Havok body
   * - Existing entity → let Havok handle position (update glow only)
   * - Missing entity → dispose Havok body + visual (the server sends every
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
        existing.setServerPosition(info.x, info.y, info.z);
        existing.update();
      } else if (info.weaponId) {
        // New entity — spawn visual with Havok physics
        // A toss only while the drop is fresh. One first seen seconds later has
        // landed: thrown again from there, it hopped off its resting place (W7).
        const pending = this.pendingVelocities.get(entityId);
        this.pendingVelocities.delete(entityId);
        const vel =
          pending && performance.now() - pending.atMs <= DroppedWeaponRenderer.TOSS_FRESH_MS
            ? pending.velocity
            : undefined;

        const visual = new DroppedWeaponVisual(
          entityId,
          info.weaponId,
          this.scene,
          new Vector3(info.x, info.y, info.z),
          this.sources,
          vel, // Initial toss velocity from weapon_drop event
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
    const cameraSystem = (globalThis as any).__cameraSystem;
    if (!cameraSystem) {
      // Try dynamic import cache
      background(this._checkPickupProximityAsync(), "DroppedWeaponRenderer");
      return;
    }
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
    if (
      activeController &&
      "getPlayerPosition" in activeController &&
      typeof (activeController as any).getPlayerPosition === "function"
    ) {
      playerPos = (activeController as any).getPlayerPosition();
    }

    // Get inventory
    const inventory =
      activeController && ((activeController as any).inventory as InstanceType<typeof InventoryManager> | null);

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
    DroppedWeaponRenderer.nearbyDroppedWeapon = null;
    hidePickupPrompt("dropped");
    for (const visual of this.weapons.values()) {
      visual.dispose();
    }
    this.weapons.clear();
    this.pendingVelocities.clear();
    this.fallbackCache?.dispose();
    this.barrelCache?.dispose();
  }
}
