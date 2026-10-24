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

import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { CameraSystem } from "../../../engine/camera/CameraSystem";
import { applySafeMaxSimultaneousLights } from "../../../engine/lighting/DynamicLightSafety";
import { BspManager } from "../../../engine/loader/bsp/BspManager";
import type { PVSCuller } from "../../../engine/loader/bsp/PVSCuller";
import { resolveModelAsset } from "../../../engine/loader/model/ModelAsset";
import { Pickup, type PickupOptions } from "../../../engine/world/Pickup";
import type { WeaponDef } from "../../../shared/entities/WeaponDef";
import type { FPSController } from "../camera/FPSController";
import { FPS, getActionKeyLabel } from "../client/FPSActions";
import { InventoryManager } from "./InventoryManager";
import { hidePickupPrompt, showPickupPrompt } from "./PickupPrompt";

/** The local player's inventory, when the first-person controller is active. */
function activeInventory(): InventoryManager | null {
  const controller = CameraSystem.getInstance().getActiveController();
  return controller?.type === "fps" ? (controller as FPSController).inventory : null;
}

export type FPSPickupType = "weapon" | "ammo" | "health" | "armor" | "powerup";

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

  /** All FPSPickup instances currently alive, including unregistered diagnostics targets. */
  private static allPickups: Set<FPSPickup> = new Set();

  /** Last authoritative active-set received from the server snapshot. */
  private static latestMask: boolean[] = [];

  /** Currently-tracked nearby weapon pickup (for HUD swap prompt). */
  private static nearbyWeaponPickup: FPSPickup | null = null;

  /** Ammo pool (weapon.ammoType) → Warsow simpleitem icon shown on the ammo box. */
  private static readonly AMMO_ICONS: Record<string, string> = {
    bullets: "gfx/hud/icons/ammo/bulletsammo",
    shells: "gfx/hud/icons/ammo/riotammo",
    grenades: "gfx/hud/icons/ammo/grenadeammo",
    rockets: "gfx/hud/icons/ammo/rocketammo",
    cells: "gfx/hud/icons/ammo/plasmaammo",
    lasers: "gfx/hud/icons/ammo/laserammo",
    bolts: "gfx/hud/icons/ammo/electroammo",
  };

  /** The PVS cluster this pickup stands in, per culler (one per map load). */
  private pvsCuller: PVSCuller | null = null;
  private pvsCluster = -1;
  private readonly pvsAt = new Vector3(Number.NaN, 0, 0);

  constructor(name: string, scene: Scene, position: Vector3, options: FPSPickupOptions) {
    super(name, scene, position, options);
  }

  /**
   * In PVS from the camera: a map pickup does not move, so its cluster is
   * looked up once (again only if the map or its position changes).
   */
  protected override isInView(): boolean {
    const culler = BspManager.getInstance().getPvsCuller();
    if (!culler) return true;
    const at = this.getAbsolutePosition();
    if (culler !== this.pvsCuller || !at.equals(this.pvsAt)) {
      this.pvsCuller = culler;
      this.pvsAt.copyFrom(at);
      this.pvsCluster = culler.findClusterAtPosition(at);
    }
    return culler.isClusterVisible(this.pvsCluster);
  }

  /** A server-managed MAP pickup (not a dropped-weapon visual) that never got a
   *  shared table id — the exact shape of the "ghost pickup" bug. Used by both
   *  the construction-time warn and the pickup_audit report. */
  private static isUnidentifiedServerPickup(p: FPSPickup): boolean {
    return Boolean(p.options.serverManagedRespawn) && !p.options.entityId && p.options.pickupId === undefined;
  }

  protected override onConstructed(): void {
    FPSPickup.allPickups.add(this);

    if (FPSPickup.isUnidentifiedServerPickup(this)) {
      console.warn(`[FPSPickup] Server-managed map pickup has no pickupId: ${this.options.id}`);
    }

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
      await this._loadBarrels(this.mesh, this.options.value as string);
    }
    // Ammo boxes share one generic model; overlay the per-ammo icon quad so each
    // box reads as its ammo type (Warsow ammobox_icon.md3 + simpleitem icon).
    if (this.options.type === "ammo" && this.options.value && this.mesh) {
      await this._loadAmmoIcon(this.mesh, this.options.value as string);
    }
  }

  /** Load the ammobox icon quad and skin it with the ammo type's simpleitem icon. */
  private async _loadAmmoIcon(leaderMesh: Mesh, ammoType: string): Promise<void> {
    const iconPath = FPSPickup.AMMO_ICONS[ammoType];
    if (!iconPath) return; // unknown ammo type — leave the plain box

    const scene = this.getScene();
    const [{ ModelLoader }, { loadAmmoIconTexture }, { StandardMaterial }, { Color3 }] = await Promise.all([
      import("../../../engine/loader/model/ModelLoader"),
      import("./pickups/AmmoIconTexture"),
      import("@babylonjs/core/Materials/standardMaterial"),
      import("@babylonjs/core/Maths/math.color"),
    ]);

    // Skip the quad when artwork is unavailable instead of showing a white placeholder.
    const tex = await loadAmmoIconTexture(iconPath);
    if (!tex) {
      console.warn(`[FPSPickup] Ammo icon not found: ${iconPath} — showing plain box`);
      return;
    }

    // Load the icon quad (separate model, authored in the ammobox's own space).
    const loader = ModelLoader.getInstance();
    if (!loader.isInitialized()) loader.init(scene);
    const iconResult = await loader.loadModel("models/items/ammo/ammobox/ammobox_icon.md3", {
      position: Vector3.Zero(),
      scale: 1.0,
      hasCollision: false,
      applyLighting: false,
    });
    if (!iconResult?.meshes?.length) return;

    // The simpleitem icon, rendered unlit so it stays legible on the box like a decal.
    tex.hasAlpha = true;
    const mat = new StandardMaterial(`ammo_icon_${ammoType}`, scene);
    mat.backFaceCulling = false;
    mat.disableLighting = true;
    mat.emissiveColor = Color3.White();
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.transparencyMode = 2; // ALPHABLEND

    for (const m of iconResult.meshes) {
      if (!(m instanceof Mesh) || m.getTotalVertices() === 0) continue;
      m.parent = leaderMesh;
      m.position.setAll(0);
      m.rotationQuaternion = null;
      m.rotation.setAll(0);
      m.scaling.setAll(1);
      m.isVisible = true;
      m.material = mat;
    }

    // Detach the loader root so it doesn't linger enabled in the scene graph.
    if (iconResult.root) {
      iconResult.root.parent = null;
      iconResult.root.setEnabled(false);
    }
  }

  /** Load barrel sub-model GLBs and parent them to the weapon's authored attachment point. */
  private async _loadBarrels(leaderMesh: Mesh, weaponId: string): Promise<void> {
    try {
      const { EntityRegistry } = await import("../../../shared/entities/EntityRegistry");
      const wdef = EntityRegistry.getInstance().get<WeaponDef>(weaponId);
      const barrelDefs = wdef?.barrels;
      if (!barrelDefs?.length) return;

      const firstPath = barrelDefs[0].modelPath;
      const modelDir = firstPath.substring(0, firstPath.lastIndexOf("/") + 1);

      const { loadTags, findTag } = await import("../../../engine/loader/model/TagsLoader");
      const tags = await loadTags(modelDir);
      const barrelTag = findTag(tags, "tag_barrel");

      // GLB attachment nodes are the authoritative model-space anchors. They
      // must be snapshotted by ModelLoader/AssetPreloader because the pickup
      // cache intentionally flattens render meshes and otherwise loses tags.
      const attachment =
        (barrelTag?.boneName && this.modelAttachmentPoints[barrelTag.boneName]) ||
        this.modelAttachmentPoints.tag_barrel;

      let boneOffX = attachment?.position.x ?? 0;
      let boneOffY = attachment?.position.y ?? 0;
      let boneOffZ = attachment?.position.z ?? 0;
      if (!attachment && barrelTag?.boneName) {
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

      const { ImportMeshAsync } = await import("@babylonjs/core/Loading/sceneLoader");
      for (const barrelDef of barrelDefs) {
        try {
          const asset = await resolveModelAsset(barrelDef.modelPath);
          const barrelResult = await ImportMeshAsync(asset.source, this.getScene(), asset.options);
          const barrelRoot = barrelResult.meshes[0];
          if (barrelRoot) {
            barrelRoot.parent = leaderMesh;
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
            } else if (tagOff && barrelTag) {
              barrelRoot.rotationQuaternion = null;
              barrelRoot.rotation.set(barrelTag.rotation.x, barrelTag.rotation.y, barrelTag.rotation.z);
            } else {
              barrelRoot.rotationQuaternion = null;
              barrelRoot.rotation.setAll(0);
            }
            for (const bm of barrelResult.meshes) {
              if (bm.material && "maxSimultaneousLights" in bm.material) {
                applySafeMaxSimultaneousLights(bm.material);
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

  private static suppressedFrame = -1;
  private static suppressed = false;
  /** Freefly or paused, worked out once per frame rather than once per pickup. */
  private static promptsSuppressed(frame: number): boolean {
    if (frame !== FPSPickup.suppressedFrame) {
      FPSPickup.suppressedFrame = frame;
      const activeController = CameraSystem.getInstance().getActiveController();
      FPSPickup.suppressed = activeController?.type === "freefly" || !document.pointerLockElement;
    }
    return FPSPickup.suppressed;
  }

  protected override onProximity(_playerPos: Vector3, inRange: boolean): void {
    // Suppress prompts in spectator (freefly) mode or when paused (no pointer lock).
    if (FPSPickup.promptsSuppressed(this.getScene().getFrameId())) {
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

    const inventory = activeInventory();
    const alreadyHas = inventory ? inventory.hasWeapon(this.options.value as string) : false;
    const hasRoom = inventory ? inventory.getSlotCount() < InventoryManager.MAX_WEAPONS : false;

    if (alreadyHas || hasRoom) {
      if (FPSPickup.nearbyWeaponPickup === this) {
        FPSPickup.clearNearbyWeapon();
      }
      return;
    }

    // At capacity while holding the permanent default (blade) — can't drop it, so no SWAP prompt
    const currentWeapon = inventory ? inventory.getCurrentWeaponId() : null;
    if (currentWeapon === "blade") {
      if (FPSPickup.nearbyWeaponPickup === this) {
        FPSPickup.clearNearbyWeapon();
      }
      return;
    }

    FPSPickup.setNearbyWeapon(this);
  }

  /**
   * Taken by someone else, the pickup stops its proximity checks, so the
   * "out of range" that takes the prompt down never came: it stayed up until the
   * weapon respawned (W5).
   */
  public override setActiveState(active: boolean): void {
    super.setActiveState(active);
    if (!active && FPSPickup.nearbyWeaponPickup === this) FPSPickup.clearNearbyWeapon();
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
    // Store the reference, not a copy — each snapshot decode allocates a fresh
    // mask array, and copying it every snapshot was pure GC churn for a value
    // only the on-demand pickup_audit command reads.
    FPSPickup.latestMask = mask ?? [];
    if (!mask || mask.length === 0) return;
    for (let id = 0; id < mask.length; id++) {
      FPSPickup.pickupById.get(id)?.setActiveState(mask[id]);
    }
  }

  /** Developer diagnostic for live client/server pickup reconciliation. */
  public static auditActiveSet(mask: boolean[] = FPSPickup.latestMask): string {
    const lines: string[] = [
      `pickup_audit: instances=${FPSPickup.allPickups.size} registered=${FPSPickup.pickupById.size} mask=${mask?.length ?? 0}`,
    ];

    // Per-type census (active/total, and how many have a mesh) — the summary
    // counts hide whether WEAPON pickups exist and are active at all.
    const byType = new Map<string, { total: number; active: number; withMesh: number }>();
    for (const p of FPSPickup.allPickups) {
      const t = p.options.type ?? "?";
      const e = byType.get(t) ?? { total: 0, active: 0, withMesh: 0 };
      e.total++;
      if (p.isActive) e.active++;
      if ((p as unknown as { mesh?: unknown }).mesh) e.withMesh++;
      byType.set(t, e);
    }
    const census = [...byType.entries()].map(([t, e]) => `${t}=${e.active}/${e.total}(mesh:${e.withMesh})`).join(" ");
    lines.push(`pickup_audit: by-type active/total(mesh): ${census || "none"}`);
    const weapons = [...FPSPickup.allPickups].filter((p) => p.options.type === "weapon");
    if (weapons.length > 0) {
      lines.push(`pickup_audit: weapons: ${weapons.map((p) => FPSPickup.describeForAudit(p)).join("; ")}`);
    }

    const issues: string[] = [];

    const noId = [...FPSPickup.allPickups].filter((p) => FPSPickup.isUnidentifiedServerPickup(p));
    if (noId.length > 0) {
      issues.push(
        `server-managed pickups without pickupId: ${noId.map((p) => FPSPickup.describeForAudit(p)).join("; ")}`,
      );
    }

    const missing: number[] = [];
    for (let id = 0; id < (mask?.length ?? 0); id++) {
      if (!FPSPickup.pickupById.has(id)) missing.push(id);
    }
    if (missing.length > 0) {
      issues.push(`mask ids without client pickup: ${missing.join(", ")}`);
    }

    const outside = [...FPSPickup.pickupById.keys()].filter((id) => id >= (mask?.length ?? 0));
    if (outside.length > 0) {
      issues.push(`client pickups outside mask: ${outside.join(", ")}`);
    }

    const visualMismatches: string[] = [];
    for (const pickup of FPSPickup.allPickups) {
      const mesh = (pickup as unknown as { mesh?: { isEnabled?: () => boolean } | null }).mesh;
      const meshEnabled = mesh?.isEnabled?.();
      if (meshEnabled !== undefined && meshEnabled !== pickup.isActive) {
        visualMismatches.push(FPSPickup.describeForAudit(pickup));
      }
    }
    if (visualMismatches.length > 0) {
      issues.push(`active/mesh mismatches: ${visualMismatches.join("; ")}`);
    }

    if (issues.length === 0) {
      lines.push("pickup_audit: clean");
    } else {
      lines.push(...issues);
    }
    return lines.join("\n");
  }

  private static describeForAudit(pickup: FPSPickup): string {
    const pos = pickup.position;
    const mesh = (
      pickup as unknown as {
        mesh?: {
          isEnabled?: () => boolean;
          getTotalVertices?: () => number;
          getAbsolutePosition?: () => { x: number; y: number; z: number };
          scaling?: { x: number };
          getBoundingInfo?: () => { boundingBox: { extendSizeWorld: { length: () => number } } };
          alwaysSelectAsActiveMesh?: boolean;
        } | null;
      }
    ).mesh;
    let meshInfo = "mesh=NONE";
    if (mesh) {
      const wp = mesh.getAbsolutePosition?.();
      const wpStr = wp ? `@world=${wp.x.toFixed(0)},${wp.y.toFixed(0)},${wp.z.toFixed(0)}` : "";
      const bsize = mesh.getBoundingInfo?.().boundingBox.extendSizeWorld.length().toFixed(1) ?? "?";
      meshInfo =
        `mesh(enabled=${mesh.isEnabled?.() ?? "?"},verts=${mesh.getTotalVertices?.() ?? "?"},` +
        `scale=${mesh.scaling?.x?.toFixed(3) ?? "?"},bworld=${bsize},alwaysActive=${mesh.alwaysSelectAsActiveMesh ?? "?"}${wpStr})`;
    }
    const modelAudit = (pickup as unknown as { describeModelForAudit?: () => string }).describeModelForAudit?.();
    return `${pickup.options.id}#${pickup.options.pickupId ?? "none"}@${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)} active=${pickup.isActive} ${meshInfo}${modelAudit ? ` model(${modelAudit})` : ""}`;
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

    const inventory = activeInventory();
    const weaponName = pickup.options.id.replace(/_/g, " ").toUpperCase();

    const useKey = getActionKeyLabel(FPS.USE);
    let promptText: string;
    if (inventory && inventory.getSlotCount() >= InventoryManager.MAX_WEAPONS) {
      promptText = `PRESS [${useKey}] TO SWAP TO ${weaponName}`;
    } else {
      promptText = `PRESS [${useKey}] TO PICKUP ${weaponName}`;
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
    FPSPickup.allPickups.delete(this);
    if (this.options.pickupId !== undefined) {
      FPSPickup.pickupById.delete(this.options.pickupId);
    }
    if (FPSPickup.nearbyWeaponPickup === this) {
      FPSPickup.clearNearbyWeapon();
    }
    super.dispose();
  }
}
