/**
 * FPSPickup — FPS-specific subclass of the engine generic Pickup.
 *
 * Adds the FPS-specific surface that the engine base doesn't know about:
 *   - Weapon/ammo/health/armor type taxonomy
 *   - Weapon-barrel sub-model loading
 *   - Inventory-aware proximity prompt ("PRESS [F] TO PICKUP/SWAP")
 *   - Static id registry (pickupById) + reconcileActiveSet(), which toggles
 *     pickup visibility from the server's authoritative snapshot active-set
 *     (GameState.pickupActiveMask). See docs/research/SERVER_AUTHORITATIVE_PICKUPS.md.
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
  // STATIC: pickup registry (for server-authoritative active-set reconcile)
  // ═════════════════════════════════════════════════════════════════

  /** Map-spawn pickups by authoritative server pickup id → instance. Used by
   * reconcileActiveSet() to toggle visibility from the snapshot active-set. */
  private static pickupById: Map<number, FPSPickup> = new Map();

  /** Currently-tracked nearby weapon pickup (for HUD swap prompt). */
  private static nearbyWeaponPickup: FPSPickup | null = null;

  constructor(name: string, scene: Scene, position: Vector3, options: FPSPickupOptions) {
    super(name, scene, position, options);
  }

  protected override onConstructed(): void {
    // Register map-spawn pickups (no entityId) by their authoritative server id
    // so the active-set reconcile can find them. Dropped weapons (with entityId)
    // are managed by DroppedWeaponRenderer and aren't part of the static set.
    if (!this.options.entityId && this.options.pickupId !== undefined) {
      FPSPickup.pickupById.set(this.options.pickupId, this);
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

  // ═════════════════════════════════════════════════════════════════
  // Dispose: unregister from the static registry
  // ═════════════════════════════════════════════════════════════════

  public override dispose(): void {
    if (this.options.pickupId !== undefined) {
      FPSPickup.pickupById.delete(this.options.pickupId);
    }
    if (FPSPickup.nearbyWeaponPickup === this) {
      FPSPickup.clearNearbyWeapon();
    }
    super.dispose();
  }
}
