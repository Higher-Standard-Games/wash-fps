/**
 * FPSPickup — FPS-specific subclass of the engine generic Pickup.
 *
 * Adds the FPS-specific surface that the engine base doesn't know about:
 *   - Weapon/ammo/health/armor type taxonomy
 *   - Weapon-barrel sub-model loading
 *   - Inventory-aware proximity prompt ("PRESS [F] TO PICKUP/SWAP")
 *   - Static server-deactivation registry (allPickups + pickupById + pendingDeactivations)
 *   - Server-driven deactivation by id or position with weapon-id prefix matching
 *
 * The generic in-world collectible behavior (model loading, physics toss,
 * dropToGround, glow pulse, respawn, dispose) lives in
 * `src/engine/world/Pickup.ts`.
 */

import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { CameraSystem } from "../../../engine/camera/CameraSystem";
import { InventoryManager } from "./InventoryManager";
import { hidePickupPrompt, showPickupPrompt } from "./PickupPrompt";
import { Pickup, type PickupOptions } from "../../../engine/world/Pickup";

export type FPSPickupType = "weapon" | "ammo" | "health" | "armor";

export interface FPSPickupOptions extends PickupOptions {
  type: FPSPickupType;
  /** weaponId (string) or amount (number) — depends on `type`. */
  value: string | number;
  /** Ammo amount (for ammo pickups). */
  amount?: number;
  /** Ammo count for dropped weapons. If set, pickup gives this amount instead of default. */
  ammoCount?: number;
}

export class FPSPickup extends Pickup {
  // Narrow the inherited options type.
  declare protected options: FPSPickupOptions;

  // ═════════════════════════════════════════════════════════════════
  // STATIC: server-deactivation registry
  // ═════════════════════════════════════════════════════════════════

  /** Registry of all FPSPickup instances for server-driven deactivation. */
  private static allPickups: FPSPickup[] = [];

  /** ID-based lookup map for deterministic deactivation (server pickupId → pickup). */
  private static pickupById: Map<number, FPSPickup> = new Map();

  /** Deferred deactivation queue — for item_pickup events that arrive before the client Pickup is constructed. */
  private static pendingDeactivations: {
    weaponId: string;
    x: number;
    y: number;
    z: number;
    pickupId?: number;
    timestamp: number;
  }[] = [];

  /** Currently-tracked nearby weapon pickup (for HUD swap prompt). */
  private static nearbyWeaponPickup: FPSPickup | null = null;

  constructor(name: string, scene: Scene, position: Vector3, options: FPSPickupOptions) {
    super(name, scene, position, options);
  }

  protected override onConstructed(): void {
    // Only register map-spawn pickups (no entityId) on the static registry.
    // Dropped weapons (with entityId) are managed by DroppedWeaponRenderer.
    if (!this.options.entityId) {
      FPSPickup.allPickups.push(this);
      if (this.options.pickupId !== undefined) {
        FPSPickup.pickupById.set(this.options.pickupId, this);
      }
      FPSPickup.checkDeferredDeactivation(this);
    }
  }

  protected override getPickupSoundKey(): string {
    return this.options.type === "weapon" ? "weapon_pickup" : "ammo_pickup";
  }

  protected override async loadModel(): Promise<void> {
    await super.loadModel();
    // After base model is loaded, attach weapon barrel sub-models (weapons only)
    if (this.options.type === "weapon" && this.options.value && this.mesh) {
      this._loadBarrels(this.mesh, this.options.value as string).catch(() => {});
    }
  }

  /** Load barrel sub-model GLBs and parent to the weapon's leader mesh (fire-and-forget). */
  private async _loadBarrels(leaderMesh: Mesh, weaponId: string): Promise<void> {
    try {
      const { EntityRegistry } = await import("../../../shared/entities/EntityRegistry");
      // biome-ignore lint/suspicious/noExplicitAny: weapon def schema introspection
      const wdef = EntityRegistry.getInstance().get(weaponId) as any;
      const barrelDefs = wdef?.barrels as
        | Array<{ modelPath: string; offset?: { x: number; y: number; z: number } }>
        | undefined;
      if (!barrelDefs?.length) return;

      const firstPath = barrelDefs[0].modelPath;
      const modelDir = firstPath.substring(0, firstPath.lastIndexOf("/") + 1);

      const { loadTags, findTag } = await import("../../../engine/loader/model/TagsLoader");
      const tags = await loadTags(modelDir);
      const barrelTag = findTag(tags, "tag_barrel");

      let boneOffX = 0;
      let boneOffY = 0;
      let boneOffZ = 0;
      if (barrelTag?.boneName) {
        for (const skeleton of this.getScene().skeletons) {
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
        try {
          const lastSlash = barrelDef.modelPath.lastIndexOf("/");
          const dir = barrelDef.modelPath.substring(0, lastSlash + 1);
          const file = barrelDef.modelPath.substring(lastSlash + 1);
          const barrelResult = await SceneLoader.ImportMeshAsync("", dir, file, this.getScene());
          const barrelRoot = barrelResult.meshes[0];
          if (barrelRoot) {
            barrelRoot.parent = leaderMesh;
            if (barrelRoot.rotationQuaternion) barrelRoot.rotationQuaternion = null;
            const tagOff = barrelTag?.offset;
            const defOff = barrelDef.offset;
            barrelRoot.position.set(
              boneOffX + (tagOff?.x ?? 0) + (defOff?.x ?? 0),
              boneOffY + (tagOff?.y ?? 0) + (defOff?.y ?? 0),
              boneOffZ + (tagOff?.z ?? 0) + (defOff?.z ?? 0),
            );
            if (tagOff) {
              // biome-ignore lint/style/noNonNullAssertion: presence checked one line up
              barrelRoot.rotation.set(barrelTag!.rotation.x, barrelTag!.rotation.y, barrelTag!.rotation.z);
            } else {
              barrelRoot.rotation.setAll(0);
            }
            for (const bm of barrelResult.meshes) {
              if (bm.material && "maxSimultaneousLights" in bm.material) {
                // biome-ignore lint/suspicious/noExplicitAny: Babylon material introspection
                (bm.material as any).maxSimultaneousLights = 4;
              }
            }
          }
        } catch (e) {
          console.warn(`[FPSPickup] Barrel load failed:`, e);
        }
      }
    } catch {
      /* EntityRegistry or TagsLoader not available */
    }
  }

  // ═════════════════════════════════════════════════════════════════
  // Proximity prompt (FPS-specific weapon-swap UX)
  // ═════════════════════════════════════════════════════════════════

  protected override onProximity(_playerPos: Vector3, inRange: boolean): void {
    // Suppress prompts in spectator (freefly) mode or when paused (no pointer lock).
    const activeController = CameraSystem.getInstance().getActiveController();
    if (activeController?.type === "freefly" || !document.pointerLockElement) {
      if (FPSPickup.nearbyWeaponPickup === this) {
        FPSPickup.clearNearbyWeapon();
      }
      return;
    }

    if (!inRange) {
      if (FPSPickup.nearbyWeaponPickup === this) {
        FPSPickup.clearNearbyWeapon();
      }
      return;
    }

    // Client-side FPSPickup is DISPLAY-ONLY.
    // All actual pickup logic is server-authoritative (PickupSystem.ts).
    // We only show/hide the SWAP prompt here for the HUD.
    if (this.options.type !== "weapon") return;

    const controller = CameraSystem.getInstance().getActiveController();
    // biome-ignore lint/suspicious/noExplicitAny: controller adapter shape
    const inventory = controller && ((controller as any).inventory as InventoryManager | null);
    const alreadyHas = inventory ? inventory.hasWeapon(this.options.value as string) : false;
    const hasRoom = inventory ? inventory.getSlotCount() < InventoryManager.MAX_WEAPONS : false;

    if (alreadyHas || hasRoom) {
      if (FPSPickup.nearbyWeaponPickup === this) {
        FPSPickup.clearNearbyWeapon();
      }
      return;
    }

    // At capacity with a non-gunblade — show SWAP prompt
    const currentWeapon = inventory ? inventory.getCurrentWeaponId() : null;
    if (currentWeapon === "gunblade") {
      if (FPSPickup.nearbyWeaponPickup === this) {
        FPSPickup.clearNearbyWeapon();
      }
      return;
    }

    FPSPickup.setNearbyWeapon(this);
  }

  // ═════════════════════════════════════════════════════════════════
  // Static API: nearby weapon tracking + server-driven deactivation
  // ═════════════════════════════════════════════════════════════════

  /**
   * Reconcile all registered map pickups to the server's authoritative
   * active-set (GameState.pickupActiveMask, indexed by pickup id). Called every
   * snapshot. Idempotent — only pickups whose state changed are toggled. This is
   * the convergent, self-healing replacement for item_pickup events + the old
   * client respawn timer.
   */
  public static reconcileActiveSet(mask: boolean[]): void {
    if (!mask || mask.length === 0) return;
    for (let id = 0; id < mask.length; id++) {
      FPSPickup.pickupById.get(id)?.setActiveState(mask[id]);
    }
  }

  /** Called by FPSController.onUse (F key) — clears the prompt; server handles the actual swap. */
  public static triggerUseAction(): void {
    if (FPSPickup.nearbyWeaponPickup) {
      FPSPickup.clearNearbyWeapon();
    }
  }

  private static setNearbyWeapon(pickup: FPSPickup): void {
    if (FPSPickup.nearbyWeaponPickup === pickup) return;

    FPSPickup.nearbyWeaponPickup = pickup;

    const controller = CameraSystem.getInstance().getActiveController();
    // biome-ignore lint/suspicious/noExplicitAny: controller adapter shape
    const inventory = controller && ((controller as any).inventory as InventoryManager | null);
    const weaponName = pickup.options.id.replace(/_/g, " ").toUpperCase();

    let promptText: string;
    if (inventory && inventory.getSlotCount() >= InventoryManager.MAX_WEAPONS) {
      promptText = `PRESS [F] TO SWAP TO ${weaponName}`;
    } else {
      promptText = `PRESS [F] TO PICKUP ${weaponName}`;
    }

    showPickupPrompt("pickup", promptText);
  }

  private static clearNearbyWeapon(): void {
    FPSPickup.nearbyWeaponPickup = null;
    hidePickupPrompt("pickup");
  }

  /**
   * Deactivate a pickup by server-assigned ID (O(1) deterministic lookup).
   * Falls back to position-based matching if pickupId is not registered.
   */
  public static deactivateById(pickupId: number, weaponId: string, x: number, y: number, z: number): void {
    const pickup = FPSPickup.pickupById.get(pickupId);
    if (pickup?.isActive) {
      pickup.deactivateFromServer();
      return;
    }
    FPSPickup.deactivateByPosition(weaponId, x, y, z);
  }

  /**
   * Deactivate a pickup by position match (called from Game on item_pickup event).
   * Uses XZ-only proximity since dropToGround changes server-vs-client Y.
   */
  public static deactivateByPosition(weaponId: string, x: number, y: number, z: number): void {
    const MATCH_DIST_SQ = 200 * 200;
    let bestPickup: FPSPickup | null = null;
    let bestDistSq = Infinity;

    for (const pickup of FPSPickup.allPickups) {
      if (!pickup.isActive) continue;
      const val = String(pickup.options.value || "");
      const id = String(pickup.options.id || "");
      const matchesWeapon =
        val === weaponId ||
        id === weaponId ||
        val === `weapon_${weaponId}` ||
        id === `weapon_${weaponId}` ||
        val.replace("weapon_", "") === weaponId ||
        id.replace("weapon_", "") === weaponId;
      if (!matchesWeapon) continue;

      const dx = pickup.position.x - x;
      const dz = pickup.position.z - z;
      const distSq = dx * dx + dz * dz;

      if (distSq < MATCH_DIST_SQ && distSq < bestDistSq) {
        bestDistSq = distSq;
        bestPickup = pickup;
      }
    }

    if (bestPickup) {
      bestPickup.deactivateFromServer();
    } else {
      console.warn(
        `[FPSPickup] Server deactivate MISS: ${weaponId} at (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)}) — queuing for deferred deactivation (${FPSPickup.allPickups.filter((p) => p.isActive).length} active pickups)`,
      );
      FPSPickup.pendingDeactivations.push({ weaponId, x, y, z, timestamp: Date.now() });
      FPSPickup.pendingDeactivations = FPSPickup.pendingDeactivations.filter((d) => Date.now() - d.timestamp < 10000);
    }
  }

  /**
   * Check the deferred deactivation queue when a new FPSPickup is created.
   * If there's a pending deactivation that matches this pickup, deactivate it immediately.
   */
  private static checkDeferredDeactivation(pickup: FPSPickup): void {
    const MATCH_DIST_SQ = 200 * 200;
    const val = String(pickup.options.value || "");
    const id = String(pickup.options.id || "");

    for (let i = FPSPickup.pendingDeactivations.length - 1; i >= 0; i--) {
      const pending = FPSPickup.pendingDeactivations[i];
      const matchesWeapon =
        val === pending.weaponId ||
        id === pending.weaponId ||
        val === `weapon_${pending.weaponId}` ||
        id === `weapon_${pending.weaponId}` ||
        val.replace("weapon_", "") === pending.weaponId ||
        id.replace("weapon_", "") === pending.weaponId;
      if (!matchesWeapon) continue;

      const dx = pickup.position.x - pending.x;
      const dz = pickup.position.z - pending.z;
      const distSq = dx * dx + dz * dz;

      if (distSq < MATCH_DIST_SQ) {
        FPSPickup.pendingDeactivations.splice(i, 1);
        setTimeout(() => pickup.deactivateFromServer(), 100);
        return;
      }
    }
  }

  // ═════════════════════════════════════════════════════════════════
  // Dispose: unregister from the static registry
  // ═════════════════════════════════════════════════════════════════

  public override dispose(): void {
    const idx = FPSPickup.allPickups.indexOf(this);
    if (idx >= 0) FPSPickup.allPickups.splice(idx, 1);
    if (this.options.pickupId !== undefined) {
      FPSPickup.pickupById.delete(this.options.pickupId);
    }
    if (FPSPickup.nearbyWeaponPickup === this) {
      FPSPickup.clearNearbyWeapon();
    }
    super.dispose();
  }
}
