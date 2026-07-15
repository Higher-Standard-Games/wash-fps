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

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { Scene } from "@babylonjs/core/scene";
import { applySafeMaxSimultaneousLights } from "../../../engine/lighting/DynamicLightSafety";
import { EntityRegistry } from "../../../shared/entities/EntityRegistry";
import { hidePickupPrompt, showPickupPrompt } from "../world/PickupPrompt";
import { FPS, getActionKeyLabel } from "./FPSActions";

/** Permanent default melee weapon (slot 0) — always free to drop, never prompts. */
function isDefaultWeapon(w: string | null): boolean {
  return w === "blade" || w === "gunblade";
}

/** Data passed from GameEvents per item_ entity in snapshot */
export interface DroppedWeaponInfo {
  x: number;
  y: number;
  z: number;
  weaponId?: string;
  settled?: boolean;
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
  /** Server's authoritative position — used to align visual after Havok settles */
  private serverPosition: Vector3 = Vector3.Zero();

  constructor(
    entityId: string,
    weaponId: string,
    scene: Scene,
    position: Vector3,
    velocity?: Vector3,
    useServerTransforms = false,
  ) {
    this.entityId = entityId;
    this.weaponId = weaponId;
    this.scene = scene;
    this.useServerTransforms = useServerTransforms;
    this.serverPosition.copyFrom(position);
    this.loadModel(position, velocity);
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
      let result: any = null;
      try {
        const { AssetPreloader } = await import("../../../engine/loader/AssetPreloader");
        const preloader = AssetPreloader.getInstance();
        if (preloader.hasModel(modelPath)) {
          result = preloader.cloneCachedModel(modelPath, this.scene);
        }
      } catch {
        // Preloader not available
      }

      // Fall back to fresh load
      if (!result) {
        const { ModelLoader } = await import("../../../engine/loader/model/ModelLoader");
        const loader = ModelLoader.getInstance();
        if (!loader.isInitialized()) loader.init(this.scene);
        result = await loader.loadModel(modelPath, {
          position: Vector3.Zero(),
          scale: defScale,
          hasCollision: false,
          applyLighting: false,
        });
      }

      // If disposed during async load, clean up and bail
      if (this.disposed) {
        if (result?.root) result.root.dispose();
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

            // Find bone position if tag references a bone
            let boneOffX = 0,
              boneOffY = 0,
              boneOffZ = 0;
            if (barrelTag?.boneName) {
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

            const { SceneLoader } = await import("@babylonjs/core/Loading/sceneLoader");
            for (const barrelDef of barrelDefs) {
              if (this.disposed) break;
              try {
                const lastSlash = barrelDef.modelPath.lastIndexOf("/");
                const dir = barrelDef.modelPath.substring(0, lastSlash + 1);
                const file = barrelDef.modelPath.substring(lastSlash + 1);
                const barrelResult = await SceneLoader.ImportMeshAsync("", dir, file, this.scene);
                if (this.disposed) {
                  barrelResult.meshes[0]?.dispose(false, false);
                  break;
                }
                const barrelRoot = barrelResult.meshes[0];
                if (barrelRoot) {
                  barrelRoot.parent = leaderMesh;
                  if (barrelRoot.rotationQuaternion) barrelRoot.rotationQuaternion = null;
                  // Apply: bone position + tag offset + per-barrel def offset
                  const tagOff = barrelTag?.offset;
                  const defOff = barrelDef.offset;
                  barrelRoot.position.set(
                    boneOffX + (tagOff?.x ?? 0) + (defOff?.x ?? 0),
                    boneOffY + (tagOff?.y ?? 0) + (defOff?.y ?? 0),
                    boneOffZ + (tagOff?.z ?? 0) + (defOff?.z ?? 0),
                  );
                  if (tagOff) {
                    barrelRoot.rotation.set(barrelTag!.rotation.x, barrelTag!.rotation.y, barrelTag!.rotation.z);
                  } else {
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

        // Detach loader root without disposing children
        if (result.root) {
          result.root.parent = null;
          result.root.setEnabled(false);
        }
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
        // Freeze the body — physics done
        this.mesh.physicsBody.setLinearVelocity(Vector3.Zero());
        this.mesh.physicsBody.setAngularVelocity(Vector3.Zero());
        this.settled = true;
        if (this.settleCheckTimer) clearInterval(this.settleCheckTimer);
      }
    }, 500);
  }

  /** Update server position from snapshot data */
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
    if (this.settleCheckTimer) {
      clearInterval(this.settleCheckTimer);
      this.settleCheckTimer = null;
    }
    if (this.mesh) {
      const meshName = this.mesh.name;
      // Remove Havok body first
      if (this.mesh.physicsBody) {
        this.mesh.physicsBody.dispose();
      }
      // Clean up PhysicsSystem body map reference
      import("../../../engine/physics/PhysicsSystem")
        .then(({ PhysicsSystem }) => {
          PhysicsSystem.getInstance().removeBody(meshName);
        })
        .catch(() => {});
      // Dispose child meshes (other weapon parts parented to leader)
      const children = this.mesh.getChildMeshes();
      for (const child of children) {
        child.parent = null;
        // CRITICAL: dispose(false, false) — do NOT dispose shared materials!
        // Materials are shared with AssetPreloader cache and other clones.
        child.dispose(false, false);
      }
      // Dispose leader mesh — also don't dispose materials
      this.mesh.dispose(false, false);
      this.mesh = null;
    }
  }
}

export class DroppedWeaponRenderer {
  private scene: Scene;
  private weapons: Map<string, DroppedWeaponVisual> = new Map();

  /** Stashed initial velocities from weapon_drop events (entityId → velocity) */
  private pendingVelocities: Map<string, Vector3> = new Map();

  /** Currently tracked nearby dropped weapon for F prompt */
  private static nearbyDroppedWeapon: DroppedWeaponVisual | null = null;

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
    this.pendingVelocities.set(entityId, velocity);
    // Auto-clean after 5 seconds (if entity never appears)
    setTimeout(() => this.pendingVelocities.delete(entityId), 5000);
  }

  /**
   * Sync with server entity state — the ONLY entry point for lifecycle management.
   * Called each frame with all item_ entities from the server snapshot.
   *
   * - New entity → spawn visual with Havok body
   * - Existing entity → let Havok handle position (update glow only)
   * - Missing entity → dispose Havok body + visual
   */
  syncServerEntities(entities: Map<string, DroppedWeaponInfo>): void {
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
        const vel = this.pendingVelocities.get(entityId);
        this.pendingVelocities.delete(entityId);

        const visual = new DroppedWeaponVisual(
          entityId,
          info.weaponId,
          this.scene,
          new Vector3(info.x, info.y, info.z),
          vel, // Initial toss velocity from weapon_drop event
          this.useServerTransforms,
        );
        this.weapons.set(entityId, visual);
      }
    }

    // 3. Check pickup proximity for live play only. Demo snapshot mode is
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
      this._checkPickupProximityAsync();
      return;
    }
  }

  private _cachedCameraModule: any = null;
  private _cachedInventoryModule: any = null;

  private async _checkPickupProximityAsync(): Promise<void> {
    if (!this._cachedCameraModule) {
      try {
        this._cachedCameraModule = await import("../../../engine/camera/CameraSystem");
        this._cachedInventoryModule = await import("../world/InventoryManager");
      } catch {
        return;
      }
    }

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
        // Holding the default melee (blade/gunblade) → server auto-swaps
        // silently, so never show the swap prompt. (Was hardcoded to
        // "gunblade" and missed the current default "blade".)
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
    DroppedWeaponRenderer.nearbyDroppedWeapon = null;
    hidePickupPrompt("dropped");
    for (const visual of this.weapons.values()) {
      visual.dispose();
    }
    this.weapons.clear();
    this.pendingVelocities.clear();
  }
}
