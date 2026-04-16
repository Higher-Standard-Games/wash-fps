/**
 * RemotePlayerRenderer — Renders 3D models + hitbox wireframes for remote entities
 *
 * Each remote player gets:
 * - A `PlayerModelInstance` (vanguard.glb clone) with animation state machine
 * - An optional wireframe hitbox overlay (toggled via `cl_remotehitbox` cvar)
 *
 * Architecture:
 * - pushSnapshot() feeds entity data into SnapshotBuffer (~30Hz from server)
 * - render() samples interpolated positions every frame, positions models,
 *   derives animation state from velocity/grounded/yaw, and plays animations
 */

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { type PlayerModelInstance, PlayerModelManager } from "../../../engine/animation/PlayerModelManager";
import { Cvar } from "../../../engine/core/Cvar";
import {
  type EntitySnapshot,
  type InterpolatedEntity,
  SnapshotBuffer,
} from "../../../engine/network/client/SnapshotBuffer";
import type { GameState } from "../../../engine/network/core/GameState";
import { WEAPONS } from "../server/weapons/WeaponDef";

// ─── Types ───────────────────────────────────────────────────────

/** Per-entity hitbox wrapper */
interface RemotePlayerHitbox {
  mesh: Mesh;
  smoothedPos: Vector3;
  smoothedYaw: number;
  /** Current hitbox height (56 standing, 36 crouching) */
  currentHeight: number;
  /** 3D model instance (null until model loads) */
  model: PlayerModelInstance | null;
  /** Root node of weapon model attached to hand bone */
  weaponRoot: TransformNode | null;
  /** Reference to RightHand bone transform node for per-frame tracking */
  handBone: TransformNode | null;
  /** Current weapon ID string (for detecting weapon switches) */
  currentWeaponId: string;
}

// ─── Constants (Q3-style player bounds) ──────────────────────────

/** Horizontal collision radius */
const PLAYER_RADIUS = 16;

/** Box extends 24 units below origin (to feet) */
const PLAYER_MINS_Z = -24;

/** Box extends 40 units above origin (to head) */
const PLAYER_MAXS_Z = 40;

/** Total standing height: 64 */
const PLAYER_HEIGHT = PLAYER_MAXS_Z - PLAYER_MINS_Z;

/** Crouched mins Z — box extends 4 units below origin */
const CROUCH_MINS_Z = -4;

/** Total crouched height: 36 */
const CROUCH_HEIGHT = PLAYER_MAXS_Z - CROUCH_MINS_Z;

// ─── Renderer ────────────────────────────────────────────────────

// ─── Model scale (Mixamo → Q3/BSP units) ────────────────────────
const MODEL_SCALE = 36;

// ─── Model Y offset (compensates for mesh extending below Y=0) ──
// The Mixamo vanguard mesh origin isn't exactly at feet level.
// This raises the model anchor so the visual feet align with the
// hitbox bottom (floor level). Tunable per model.
const MODEL_Y_OFFSET = 12;

// ─── Animation derivation constants ─────────────────────────────
const IDLE_SPEED_THRESHOLD = 50;
const RUN_SPEED_THRESHOLD = 300;

// Mixamo animation natural speeds (Q3 units/s at 1x playback)
// Lower values → higher speedRatio → faster feet to match actual movement.
// Tuned so feet track the ground at game speeds (maxSpeed=280, runSpeed=350).
const WALK_NATURAL_SPEED = 40;
const RUN_NATURAL_SPEED = 100;
const STRAFE_NATURAL_SPEED = 29;

// Jump velocity for normalizing animation scrub (matches MovementProfile.jumpVelocity)
const JUMP_VELOCITY = 320;

export class RemotePlayerRenderer {
  private scene: Scene;
  private hitboxes: Map<string, RemotePlayerHitbox> = new Map();
  private snapshotBuffer: SnapshotBuffer = new SnapshotBuffer();
  /** Entities marked dead — value is death timestamp (performance.now) */
  private deadEntities: Map<string, number> = new Map();

  /** Shared model manager — loads vanguard.glb once, creates cloned instances */
  private modelManager: PlayerModelManager | null = null;
  private modelLoading = false;

  /** Reference to enemyWeapons from GameEventContext — maps entityId → weaponId */
  private enemyWeapons: Map<string, string> = new Map();

  /** Entity whose mesh+model should be hidden (e.g. followed player in demo POV) */
  private _hiddenEntityId: string | null = null;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /** Set reference to enemy weapons map from GameEventContext */
  setEnemyWeapons(weapons: Map<string, string>): void {
    this.enemyWeapons = weapons;
  }

  /**
   * Hide the mesh + model for a specific entity (e.g. the followed player in demo POV).
   * Restores the previously hidden entity before hiding the new one.
   * Pass null to unhide all.
   */
  setHiddenEntity(entityId: string | null): void {
    // Restore previously hidden entity
    if (this._hiddenEntityId !== null) {
      const old = this.hitboxes.get(this._hiddenEntityId);
      if (old) {
        if (old.model) old.model.anchor.setEnabled(true);
      }
    }
    this._hiddenEntityId = entityId;
    // Immediately hide the new target if its hitbox already exists
    if (entityId !== null) {
      const hitbox = this.hitboxes.get(entityId);
      if (hitbox) {
        hitbox.mesh.setEnabled(false);
        if (hitbox.model) hitbox.model.anchor.setEnabled(false);
      }
    }
  }

  // ── Model Loading ────────────────────────────────────────────

  private async ensureModelLoaded(): Promise<void> {
    if (this.modelManager?.isLoaded || this.modelLoading) return;
    this.modelLoading = true;

    this.modelManager = new PlayerModelManager(this.scene);
    try {
      await this.modelManager.loadModel();
      console.log("[RemotePlayerRenderer] Player model loaded");

      // Create model instances for any hitboxes that were created before model loaded
      for (const [entityId, hitbox] of this.hitboxes) {
        if (!hitbox.model) {
          hitbox.model = this.createModelInstance(entityId);
        }
      }
    } catch (err) {
      console.error("[RemotePlayerRenderer] Failed to load player model:", err);
    } finally {
      this.modelLoading = false;
    }
  }

  private createModelInstance(entityId: string): PlayerModelInstance | null {
    if (!this.modelManager?.isLoaded) return null;
    const instance = this.modelManager.createInstance(entityId, MODEL_SCALE);
    if (instance) {
      // Start with idle animation
      this.modelManager.playAnimation(instance, "idle");

      // PROTOTYPE: Apply team color based on entity ID hash
      // TODO: Use actual team assignment from server
      const hash = entityId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
      const team = hash % 2 === 0 ? "alpha" : "bravo";
      this.modelManager.applyTeamColor(instance, team);
    }
    return instance;
  }

  // ── Public API ───────────────────────────────────────────────

  /**
   * Push a new snapshot into the interpolation buffer.
   * Called once per server state update (~30Hz).
   *
   * @param state Server game state
   * @param localEntityId ID of local player's entity (excluded from rendering)
   * @param serverLocalTime Optional server timestamp converted to local time via ClockSync
   */
  pushSnapshot(state: GameState, localEntityId: string, serverLocalTime?: number): void {
    // Extract entity data into snapshot format
    const entities = new Map<string, EntitySnapshot>();

    for (const [entityId, entity] of state.entities) {
      if (entityId === localEntityId) continue;
      if (!entityId.startsWith("player_")) continue;

      const transform = entity.getComponent("transform") as any;
      const velocity = entity.getComponent("velocity") as any;
      const movementState = entity.getComponent("movementState") as any;

      if (!transform?.position) continue;

      entities.set(entityId, {
        x: transform.position.x,
        y: transform.position.y,
        z: transform.position.z,
        yaw: transform.rotation?.y ?? 0,
        vx: velocity?.linear?.x ?? velocity?.x ?? 0,
        vy: velocity?.linear?.y ?? velocity?.y ?? 0,
        vz: velocity?.linear?.z ?? velocity?.z ?? 0,
        grounded: velocity?.grounded ?? true,
        crouching: movementState?.isCrouching ?? false,
        sliding: movementState?.isSliding ?? false,
        wallJumping: movementState?.wallJumpState === "charging",
      });
    }

    this.snapshotBuffer.push(state.tick, entities, serverLocalTime);

    // Clear dead status ONLY when entity reappears in a fresh snapshot
    // (meaning the server has confirmed respawn with valid position data)
    for (const [entityId] of this.deadEntities) {
      if (entities.has(entityId)) {
        this.deadEntities.delete(entityId);
      }
    }
  }

  /**
   * Render all remote entities using interpolated positions.
   * Called every frame from the render loop.
   */
  render(): void {
    // Get all entities from latest snapshot for lifecycle management
    const aliveIds = this.snapshotBuffer.getLatestEntityIds();

    // Sample interpolated state for each alive entity
    for (const entityId of aliveIds) {
      // Skip dead entities — their mesh is hidden until entity leaves snapshot
      if (this.deadEntities.has(entityId)) continue;

      const interp = this.snapshotBuffer.sample(entityId);
      if (!interp) continue;

      let hitbox = this.hitboxes.get(entityId);

      // Create hitbox for new entity
      if (!hitbox) {
        const created = this.createHitbox(entityId, interp);
        if (created) {
          this.hitboxes.set(entityId, created);
          hitbox = created;
          // Trigger async model load on first remote player
          this.ensureModelLoaded();
        }
      }

      if (!hitbox) continue;

      // Hidden entity (followed player in demo POV) — keep invisible every frame
      if (entityId === this._hiddenEntityId) {
        hitbox.mesh.setEnabled(false);
        if (hitbox.model) hitbox.model.anchor.setEnabled(false);
        continue;
      }

      // Ensure model is assigned — catches any timing gaps during initial load
      if (!hitbox.model && this.modelManager?.isLoaded) {
        hitbox.model = this.createModelInstance(entityId);
        if (hitbox.model) {
          console.log(`[RemotePlayerRenderer] Late model assign for ${entityId}`);
        }
      }

      // Ensure hitbox is visible (may have been hidden during death)
      const showHitbox = Cvar.get("cl_remotehitbox");
      hitbox.mesh.setEnabled(showHitbox !== undefined ? Number(showHitbox) > 0 : true);

      // Check if height changed (crouch/uncrouch) — rebuild hitbox mesh if so
      const targetHeight = interp.crouching ? CROUCH_HEIGHT : PLAYER_HEIGHT;
      if (hitbox.currentHeight !== targetHeight) {
        hitbox.mesh.dispose();
        const newMesh = this.createHitboxMesh(entityId, targetHeight);
        hitbox.mesh = newMesh;
        hitbox.currentHeight = targetHeight;
      }

      // Update position/rotation from interpolated data
      this.updatePosition(hitbox, interp);

      // Update model position + animation
      this.updateModel(hitbox, interp, entityId);
    }

    // Remove hitboxes for entities no longer alive
    for (const [entityId, hitbox] of this.hitboxes) {
      if (!aliveIds.has(entityId)) {
        hitbox.mesh.dispose();
        if (hitbox.weaponRoot) {
          hitbox.weaponRoot.dispose(false, true);
        }
        if (hitbox.model && this.modelManager) {
          this.modelManager.disposeInstance(hitbox.model);
        }
        this.hitboxes.delete(entityId);
        this.deadEntities.delete(entityId);
      }
    }
  }

  /**
   * Legacy update method — calls pushSnapshot + render for backward compat.
   * NOTE: Prefer using pushSnapshot() + render() separately for proper
   * decoupled interpolation. This method is only kept for smooth migration.
   */
  update(state: GameState, localEntityId: string): void {
    this.pushSnapshot(state, localEntityId);
    this.render();
  }

  /** Clean up all hitboxes and models */
  dispose(): void {
    for (const hitbox of this.hitboxes.values()) {
      hitbox.mesh.dispose();
      if (hitbox.model && this.modelManager) {
        this.modelManager.disposeInstance(hitbox.model);
      }
    }
    this.hitboxes.clear();
    this.deadEntities.clear();
    if (this.modelManager) {
      this.modelManager.dispose();
      this.modelManager = null;
    }
  }

  /**
   * Mark an entity as dead — dispose its mesh immediately.
   * Called from Game on death events.
   * A fresh hitbox will be created when the entity respawns and reappears in snapshots.
   */
  markDead(entityId: string): void {
    this.deadEntities.set(entityId, performance.now());
    const hitbox = this.hitboxes.get(entityId);
    if (hitbox) {
      hitbox.mesh.dispose();
      if (hitbox.model && this.modelManager) {
        this.modelManager.disposeInstance(hitbox.model);
      }
      this.hitboxes.delete(entityId);
    }
  }

  /**
   * Detach a player model from the renderer WITHOUT disposing it.
   * Returns the PlayerModelInstance for ragdoll use.
   * The hitbox mesh is disposed but the model (skeleton + mesh + anchor) is preserved.
   */
  detachModel(entityId: string): import("../../../engine/animation/PlayerModelManager").PlayerModelInstance | null {
    this.deadEntities.set(entityId, performance.now());
    const hitbox = this.hitboxes.get(entityId);
    if (!hitbox || !hitbox.model) {
      if (hitbox) {
        hitbox.mesh.dispose();
        this.hitboxes.delete(entityId);
      }
      return null;
    }
    const model = hitbox.model;
    hitbox.mesh.dispose();
    this.hitboxes.delete(entityId);
    return model;
  }

  /**
   * Mark an entity as alive — hitbox will reappear on next render.
   * Called when a respawn/combat_state event clears dead status.
   */
  markAlive(entityId: string): void {
    this.deadEntities.delete(entityId);
  }

  /** Get diagnostics */
  getDiagnostics(): { bufferSize: number; interpDelay: number } {
    return {
      bufferSize: this.snapshotBuffer.getBufferSize(),
      interpDelay: this.snapshotBuffer.getInterpDelay(),
    };
  }

  /**
   * Play a one-shot attack animation on a remote player entity.
   * Used for blade slash animation on weapon_fire events.
   * @param speedRatio - Playback speed multiplier (default 1.0, higher = faster)
   */
  playAttackAnim(entityId: string, animName: string, speedRatio: number = 1.0): void {
    const hitbox = this.hitboxes.get(entityId);
    if (!hitbox?.model || !this.modelManager) return;
    this.modelManager.playOnce(hitbox.model, animName, speedRatio);
  }

  // ── Hitbox Creation ─────────────────────────────────────────

  private createHitboxMesh(entityId: string, height: number): Mesh {
    const hw = PLAYER_RADIUS; // 16 (half-width)
    const hh = height / 2; // half-height
    const hd = PLAYER_RADIUS; // 16 (half-depth)

    // 8 corners of the box (centered at origin, positioned later)
    const c = [
      new Vector3(-hw, -hh, -hd), // 0: bottom-back-left
      new Vector3(hw, -hh, -hd), // 1: bottom-back-right
      new Vector3(hw, -hh, hd), // 2: bottom-front-right
      new Vector3(-hw, -hh, hd), // 3: bottom-front-left
      new Vector3(-hw, hh, -hd), // 4: top-back-left
      new Vector3(hw, hh, -hd), // 5: top-back-right
      new Vector3(hw, hh, hd), // 6: top-front-right
      new Vector3(-hw, hh, hd), // 7: top-front-left
    ];

    // 12 edges as a continuous line strip
    const points = [
      // Bottom face
      c[0],
      c[1],
      c[2],
      c[3],
      c[0],
      // Up to top face
      c[4],
      c[5],
      c[6],
      c[7],
      c[4],
      // Remaining 3 vertical edges
      c[5],
      c[1],
      c[2],
      c[6],
      c[7],
      c[3],
    ];

    const mesh = MeshBuilder.CreateLines(
      `hitbox_${entityId}`,
      {
        points,
        updatable: false,
      },
      this.scene,
    );

    mesh.color = new Color3(0, 1, 0); // Bright green
    mesh.isPickable = false;

    return mesh as unknown as Mesh;
  }

  private createHitbox(entityId: string, initialState: InterpolatedEntity): RemotePlayerHitbox | null {
    const height = initialState.crouching ? CROUCH_HEIGHT : PLAYER_HEIGHT;
    const mesh = this.createHitboxMesh(entityId, height);

    const smoothedPos = new Vector3(initialState.x, initialState.y, initialState.z);

    // Position mesh at correct Y (box center relative to origin)
    this.positionMesh(mesh, smoothedPos, height);

    // Create model instance if manager is loaded
    const model = this.createModelInstance(entityId);

    return {
      mesh,
      smoothedPos,
      smoothedYaw: initialState.yaw,
      currentHeight: height,
      model,
      weaponRoot: null,
      handBone: null,
      currentWeaponId: "",
    };
  }

  // ── Position Update ─────────────────────────────────────────

  /**
   * Position the hitbox mesh correctly relative to Q3 origin.
   *
   * Q3 origin is at "waist" level. The box bottom should ALWAYS
   * be at feet level (origin + PLAYER_MINS_Z), regardless of crouch.
   * Crouching shrinks the box from the TOP (head lowers), not the bottom.
   */
  private positionMesh(mesh: Mesh, origin: Vector3, height: number): void {
    // Bottom always at feet level
    const bottomY = origin.y + PLAYER_MINS_Z;
    const centerY = bottomY + height / 2;
    mesh.position.set(origin.x, centerY, origin.z);
  }

  private updatePosition(hitbox: RemotePlayerHitbox, interp: InterpolatedEntity): void {
    // Direct interpolated position — SnapshotBuffer handles smooth time-based interpolation
    hitbox.smoothedPos.set(interp.x, interp.y, interp.z);

    // Position mesh relative to Q3 origin
    this.positionMesh(hitbox.mesh, hitbox.smoothedPos, hitbox.currentHeight);

    // Rotation from interpolated yaw
    hitbox.smoothedYaw = interp.yaw;
    if (hitbox.mesh.rotationQuaternion) hitbox.mesh.rotationQuaternion = null;
    hitbox.mesh.rotation.set(0, hitbox.smoothedYaw, 0);
  }

  // ── Model Update ─────────────────────────────────────────────

  private updateModel(hitbox: RemotePlayerHitbox, interp: InterpolatedEntity, entityId: string): void {
    const inst = hitbox.model;
    if (!inst || !this.modelManager) return;

    // ── Weapon model on hand ──
    this.updateWeaponModel(hitbox, inst, entityId);

    // Position the model anchor at player feet (Q3 origin - 24 = feet level)
    // MODEL_Y_OFFSET raises the model so visual feet align with hitbox bottom
    let feetY = interp.y + PLAYER_MINS_Z + MODEL_Y_OFFSET;

    // Crouch/slide Y offset: Mixamo animations don't lower the skeleton
    // enough to match the shorter hitbox. Drop the model anchor to compensate.
    // Slide needs full -20 (Mixamo slide anim doesn't lower at all).
    // Crouch walk needs only -10 (Mixamo crouch walk partially lowers).
    if (interp.sliding) {
      feetY -= 20;
    } else if (interp.crouching) {
      feetY -= 10;
    }

    inst.anchor.position.set(interp.x, feetY, interp.z);

    // Rotation
    if (inst.anchor.rotationQuaternion) inst.anchor.rotationQuaternion = null;
    inst.anchor.rotation.set(0, interp.yaw, 0);
    inst.anchor.setEnabled(true);

    // Reset root motion each frame (position + rotation drift from anims)
    this.modelManager.resetRootMotion(inst);
    inst.mesh.scaling.set(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);
    if (inst.mesh.rotationQuaternion) inst.mesh.rotationQuaternion = null;
    inst.mesh.rotation.set(0, 0, 0);

    // Ensure mesh is visible
    inst.mesh.isVisible = true;
    inst.mesh.getChildMeshes().forEach((m) => (m.isVisible = true));

    // Derive animation from network data
    // Skip if a one-shot animation (e.g. blade slash) is still playing
    if (inst.oneshotUntil > 0 && performance.now() < inst.oneshotUntil) {
      // One-shot is playing — don't override with locomotion
      return;
    }
    // Clear expired one-shot flag and force locomotion re-evaluation
    if (inst.oneshotUntil > 0) {
      inst.oneshotUntil = 0;
      inst.currentAnim = ""; // Force playAnimation to re-apply locomotion
    }
    const animName = this.deriveAnimation(interp);
    this.modelManager.playAnimation(inst, animName);

    // Scale animation speed to match movement speed (eliminate foot sliding)
    if (inst.masterGroup) {
      const speed = Math.sqrt(interp.vx * interp.vx + interp.vz * interp.vz);

      if (animName === "run" || animName === "walk") {
        const naturalSpeed = animName === "run" ? RUN_NATURAL_SPEED : WALK_NATURAL_SPEED;

        // Detect backward movement
        const fwdX = Math.sin(interp.yaw);
        const fwdZ = Math.cos(interp.yaw);
        const forwardDot = fwdX * interp.vx + fwdZ * interp.vz;
        const isBackward = forwardDot < 0;

        let speedRatio = speed / naturalSpeed;
        if (isBackward) speedRatio = -speedRatio;
        inst.masterGroup.speedRatio = Math.max(-3.0, Math.min(3.0, speedRatio));
      } else if (animName === "strafe_l" || animName === "strafe_r") {
        // Use lateral speed for strafe ratio
        const fwdX = Math.sin(interp.yaw);
        const fwdZ = Math.cos(interp.yaw);
        const rightX = fwdZ;
        const rightZ = -fwdX;
        const rightDot = rightX * interp.vx + rightZ * interp.vz;
        const lateralSpeed = Math.abs(rightDot);
        const speedRatio = lateralSpeed / STRAFE_NATURAL_SPEED;
        inst.masterGroup.speedRatio = Math.max(0.3, Math.min(3.0, speedRatio));
      } else if (animName === "jump") {
        // Warsow-style: ascending plays forward to tucked pose,
        // descending reverses back to extended pose.
        // Freeze at peak (vy ≈ 0).
        if (interp.vy > 10) {
          // Ascending — play forward, speed proportional to upward velocity
          inst.masterGroup.speedRatio = Math.max(0.3, (interp.vy / JUMP_VELOCITY) * 2.0);
        } else if (interp.vy < -10) {
          // Descending — play in reverse, speed proportional to downward velocity
          inst.masterGroup.speedRatio = Math.min(-0.2, (interp.vy / JUMP_VELOCITY) * 1.5);
        } else {
          // At peak — freeze
          inst.masterGroup.speedRatio = 0;
        }
      } else if (animName === "slide") {
        // Crouchslide: play forward proportional to horizontal speed
        // Animation naturally decelerates as slide velocity drops
        const slideSpeed = Math.sqrt(interp.vx * interp.vx + interp.vz * interp.vz);
        const slideRatio = slideSpeed / 400; // Normalize to max slide speed
        inst.masterGroup.speedRatio = Math.max(0.3, Math.min(2.0, slideRatio));
      } else if (animName === "crouch_walk") {
        // Crouch walk: speed proportional to horizontal velocity
        // When speed is very low (crouch idle), freeze on first frame
        // When walking backward, reverse the animation (negative speedRatio)
        const crouchSpeed = Math.sqrt(interp.vx * interp.vx + interp.vz * interp.vz);
        if (crouchSpeed < IDLE_SPEED_THRESHOLD) {
          inst.masterGroup.speedRatio = 0; // Freeze first frame = crouch idle
        } else {
          // Detect backward movement
          const fwdX = Math.sin(interp.yaw);
          const fwdZ = Math.cos(interp.yaw);
          const forwardDot = fwdX * interp.vx + fwdZ * interp.vz;
          const isBackward = forwardDot < 0;

          let crouchRatio = crouchSpeed / WALK_NATURAL_SPEED;
          if (isBackward) crouchRatio = -crouchRatio;
          inst.masterGroup.speedRatio = Math.max(-3.0, Math.min(3.0, crouchRatio));
        }
      } else if (animName === "crouch_strafe_l" || animName === "crouch_strafe_r") {
        // Crouch strafe: same as standing strafe
        const fwdX = Math.sin(interp.yaw);
        const fwdZ = Math.cos(interp.yaw);
        const rightX = fwdZ;
        const rightZ = -fwdX;
        const rightDot = rightX * interp.vx + rightZ * interp.vz;
        const lateralSpeed = Math.abs(rightDot);
        const crouchStrafeRatio = lateralSpeed / STRAFE_NATURAL_SPEED;
        inst.masterGroup.speedRatio = Math.max(0.3, Math.min(3.0, crouchStrafeRatio));
      } else {
        inst.masterGroup.speedRatio = 1.0;
      }
    }
  }

  // ── Weapon Model on Hand ─────────────────────────────────────
  /**
   * Load and attach the correct weapon model to the player's right hand bone.
   * Called each frame from updateModel; only acts when weaponId changes.
   *
   * Uses ModelLoader — same proven code path as DroppedWeaponRenderer.
   */
  private updateWeaponModel(hitbox: RemotePlayerHitbox, inst: PlayerModelInstance, entityId: string): void {
    const weaponId = this.enemyWeapons.get(entityId);
    if (!weaponId) return;

    // No change — nothing to do
    if (weaponId === hitbox.currentWeaponId) return;

    console.log(`[RemoteWeapon] ★ Weapon change: ${entityId} → ${weaponId}`);
    hitbox.currentWeaponId = weaponId;

    // Dispose previous weapon
    if (hitbox.weaponRoot) {
      hitbox.weaponRoot.dispose(false, true);
      hitbox.weaponRoot = null;
    }

    // Look up weapon def for model path
    const weaponDef = WEAPONS[weaponId];
    const modelPath = weaponDef?.modelPath;
    if (!modelPath) {
      console.warn(`[RemoteWeapon] No modelPath for '${weaponId}'`);
      return;
    }

    const defScale = weaponDef.scale ?? 1.5;

    // Load weapon via ModelLoader — same approach as DroppedWeaponRenderer.loadModel()
    import("../../../engine/loader/model/ModelLoader")
      .then(async ({ ModelLoader }) => {
        const loader = ModelLoader.getInstance();
        if (!loader.isInitialized()) loader.init(this.scene);

        const result = await loader.loadModel(modelPath, {
          position: Vector3.Zero(),
          scale: defScale,
          hasCollision: false,
          applyLighting: false,
        });

        if (!result?.root) {
          console.warn(`[RemoteWeapon] ModelLoader returned null for ${weaponId}`);
          return;
        }

        // Find leader mesh (first mesh with geometry) — same as DroppedWeaponRenderer
        let leaderMesh: Mesh | null = null;
        for (const m of result.meshes) {
          if (m instanceof Mesh && m.getTotalVertices() > 0) {
            if (!leaderMesh) {
              leaderMesh = m;
            }
            // Cap lights to prevent shader overflow
            if (m.material && "maxSimultaneousLights" in m.material) {
              (m.material as any).maxSimultaneousLights = 4;
            }
            // Disable frustum culling
            m.alwaysSelectAsActiveMesh = true;
            m.isVisible = true;
          }
        }

        if (!leaderMesh) {
          console.warn(`[RemoteWeapon] No meshes with geometry for ${weaponId}`);
          result.root.dispose();
          return;
        }

        if (leaderMesh.rotationQuaternion) leaderMesh.rotationQuaternion = null;

        // Use Babylon.js attachToBone() API — the official way to attach
        // external meshes to animated skeleton bones.
        // attachToBone(bone, affectedTransformNode) where affectedTransformNode
        // is the mesh that owns the skeleton.
        let attached = false;
        if (inst.skeleton) {
          for (const bone of inst.skeleton.bones) {
            if (bone.name === "mixamorig:RightHand") {
              leaderMesh.attachToBone(bone, inst.mesh);
              leaderMesh.position.set(0, 0, 0);
              // Scale: compensate for 36x mesh + shrink for 3rd person
              const thirdPersonScale = (defScale / MODEL_SCALE) * 0.5;
              leaderMesh.scaling.setAll(thirdPersonScale);

              // Weapon-specific rotation in bone-local space
              // (differs from first-person loadGlbWeapon rotations)
              if (weaponId === "blade") {
                leaderMesh.rotation.set(Math.PI, 0.9, 0);
              } else {
                // IQM→GLB guns: barrel along +X in model space
                // Bone +Y = along fingers (forward), so Z rot of -90° aligns barrel
                // X rot of π flips right-side up
                leaderMesh.rotation.set(Math.PI, 0, -Math.PI / 2);
              }

              attached = true;
              console.log(
                `[RemoteWeapon] ✓ attachToBone: ${weaponId} → RightHand, scale: ${(defScale / MODEL_SCALE).toFixed(4)}`,
              );
              break;
            }
          }
        }

        if (!attached) {
          // Fallback: parent to anchor
          leaderMesh.parent = inst.anchor;
          leaderMesh.position.set(0, 30, 0);
          leaderMesh.rotation.setAll(0);
          leaderMesh.scaling.setAll(defScale);
          console.warn(`[RemoteWeapon] No RightHand bone, using anchor for ${entityId}`);
        }

        // Parent other meshes under leader
        for (const m of result.meshes) {
          if (m instanceof Mesh && m !== leaderMesh && m.getTotalVertices() > 0) {
            m.parent = leaderMesh;
            m.position.setAll(0);
            if (m.rotationQuaternion) m.rotationQuaternion = null;
            m.rotation.setAll(0);
            m.isVisible = true;
            m.alwaysSelectAsActiveMesh = true;
          }
        }

        // Detach loader root
        if (result.root) {
          result.root.parent = null;
          result.root.setEnabled(false);
        }

        hitbox.weaponRoot = leaderMesh as unknown as TransformNode;
        console.log(
          `[RemoteWeapon] ✓ Done: ${weaponId} for ${entityId}, bone: ${attached}, scale: ${attached ? defScale / MODEL_SCALE : defScale}`,
        );
      })
      .catch((err) => {
        console.warn(`[RemoteWeapon] Failed to load ${weaponId} for ${entityId}:`, err);
      });
  }

  /**
   * Derive animation name from interpolated network data.
   * Uses velocity, grounded state, and yaw — all available from SnapshotBuffer.
   */
  private deriveAnimation(interp: InterpolatedEntity): string {
    // Walljump — player is on a wall, play wallrun animation
    // Check BEFORE grounded/airborne since walljump happens while !grounded
    if (interp.wallJumping) return "walljump";

    // Airborne — use jump for entire air time (Warsow-style)
    if (!interp.grounded) return "jump";

    // Crouchslide — takes priority over walk/run/strafe
    if (interp.sliding) {
      return "slide";
    }

    const speed = Math.sqrt(interp.vx * interp.vx + interp.vz * interp.vz);

    // Crouching (not sliding) — use crouch walk animations
    if (interp.crouching) {
      if (speed < IDLE_SPEED_THRESHOLD) return "crouch_walk"; // Frozen first frame = crouch idle

      const fwdX = Math.sin(interp.yaw);
      const fwdZ = Math.cos(interp.yaw);
      const rightX = fwdZ;
      const rightZ = -fwdX;
      const forwardDot = fwdX * interp.vx + fwdZ * interp.vz;
      const rightDot = rightX * interp.vx + rightZ * interp.vz;

      if (Math.abs(rightDot) > Math.abs(forwardDot) * 1.5) {
        return rightDot > 0 ? "crouch_strafe_l" : "crouch_strafe_r";
      }
      return "crouch_walk"; // Backward handled by negative speedRatio
    }

    // Idle
    if (speed < IDLE_SPEED_THRESHOLD) return "idle";

    // Strafe detection
    const fwdX = Math.sin(interp.yaw);
    const fwdZ = Math.cos(interp.yaw);
    const rightX = fwdZ;
    const rightZ = -fwdX;

    const forwardDot = fwdX * interp.vx + fwdZ * interp.vz;
    const rightDot = rightX * interp.vx + rightZ * interp.vz;

    if (Math.abs(rightDot) > Math.abs(forwardDot) * 1.5) {
      return rightDot > 0 ? "strafe_l" : "strafe_r";
    }

    // Run vs walk
    return speed > RUN_SPEED_THRESHOLD ? "run" : "walk";
  }
}

// ─── Cvar Registration ───────────────────────────────────────────

Cvar.register("cl_remotehitbox", 0, {
  type: "int",
  min: 0,
  max: 1,
  description: "Show wireframe hitbox outlines on remote players",
});
