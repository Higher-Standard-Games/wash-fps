import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Scene } from "@babylonjs/core/scene";
import { type PlayerModelInstance, PlayerModelManager } from "../../../../engine/animation/PlayerModelManager";
import { background } from "../../../../engine/core/AsyncErrors";
import { Cvar } from "../../../../engine/core/Cvar";
import { devLog } from "../../../../engine/core/DevLog";
import type { FPSController } from "../FPSController";

/**
 * PlayerVisuals - Handles the visual representation of the player
 *
 * Includes:
 * - Debug bounding box visualization
 * - Debug player model (Vanguard)
 * - Animation state machine and playback
 * - Position/Rotation smoothing
 */
export class PlayerVisuals {
  private controller: FPSController;
  private scene: Scene;

  // Debug visualization (cl_debugbbox cvar)
  private debugBboxMesh: Mesh | null = null;

  // Debug player model (via shared PlayerModelManager)
  private modelManager: PlayerModelManager;
  private debugInstance: PlayerModelInstance | null = null;
  private debugInitializing = false;

  // Smoothed tracking to prevent idle jitter
  private debugPlayerSmoothedYaw: number = 0;
  private debugPlayerSmoothedPos: Vector3 = new Vector3(0, 0, 0);

  constructor(controller: FPSController, scene: Scene) {
    this.controller = controller;
    this.scene = scene;
    this.modelManager = new PlayerModelManager(scene);
  }

  /**
   * Update visual elements (bbox, player model)
   */
  public update(deltaTime: number): void {
    this.updateDebugBbox();
    this.updateDebugPlayer(deltaTime);
  }

  public dispose(): void {
    if (this.debugInstance) {
      this.modelManager.disposeInstance(this.debugInstance);
      this.debugInstance = null;
    }
    this.modelManager.dispose();
    if (this.debugBboxMesh) {
      this.debugBboxMesh.dispose();
      this.debugBboxMesh = null;
    }
  }

  /**
   * Update the debug bounding box visualization
   */
  private updateDebugBbox(): void {
    const debugBboxVal = Cvar.get("cl_debugbbox");
    const showBbox = debugBboxVal !== undefined && Number(debugBboxVal) > 0;

    if (!showBbox) {
      if (this.debugBboxMesh) {
        this.debugBboxMesh.dispose();
        this.debugBboxMesh = null;
      }
      return;
    }

    if (!this.debugBboxMesh) {
      const width = this.controller.radius * 2;
      const height = this.controller.height; // Use current height (crouch aware)
      const depth = this.controller.radius * 2;

      this.debugBboxMesh = MeshBuilder.CreateBox("debugBbox", { width, height, depth }, this.scene);
      this.debugBboxMesh.isPickable = false;
      this.debugBboxMesh.renderingGroupId = 1; // Draw over geometry if depth test allows

      // Wireframe material is complex in BJS, simpler to use edges or just CreateBox lines?
      // MeshBuilder.CreateBox creates a solid mesh. For lines we want edges renderer or CreateLines
      // Let's stick to simple box for now but make it wireframe via material if we had one.
      // Better: CreateLines for a box shape.

      this.debugBboxMesh.dispose(); // Discard the solid box

      // Manual box lines

      // 8 corners... actually let's use CreateBox with enableEdgesRendering?
      // Or just standard BJS EdgesRenderer.
      // Simplest for now: CreateBox with visibility 0.2
      this.debugBboxMesh = MeshBuilder.CreateBox("debugBbox", { width, height, depth }, this.scene) as LinesMesh;
      this.debugBboxMesh.visibility = 0.3;
      this.debugBboxMesh.isPickable = false;
    }

    // Update size if changed (crouch)
    const height = this.controller.height;
    if (this.debugBboxMesh.scaling.y !== height) {
      // Recreating is easier than rescaling non-uniform with absolute dimensions
      this.debugBboxMesh.dispose();
      const width = this.controller.radius * 2;
      const depth = this.controller.radius * 2;
      this.debugBboxMesh = MeshBuilder.CreateBox("debugBbox", { width, height, depth }, this.scene) as LinesMesh;
      this.debugBboxMesh.visibility = 0.3;
      this.debugBboxMesh.isPickable = false;
    }

    // Position: Physics origin is 24 units above feet.
    // Box origin is center.
    // If player is standing (height 56), feet are at origin-24. Top is feet+56 = origin+32.
    // Box center should be feet + height/2.
    // Box center = (origin - 24) + height/2.

    // Q3 Mins/Maxs for player: [-15, -15, -24] to [15, 15, 32] (Total height 56)
    // Origin is at (0,0,0) relative to these bounds.

    // So box center relative to physics origin: (-24 + 32) / 2 = 4 for Z?
    // Wait, Box center Z = (MinZ + MaxZ) / 2 = (-24 + 32) / 2 = 4.

    const aheadPos = this.controller.getPlayerPosition().clone();

    // Look direction for offset
    const yaw = this.controller.getRotation().y;
    const offset = 100;
    aheadPos.x += Math.sin(yaw) * offset;
    aheadPos.z += Math.cos(yaw) * offset;

    // Adjust y to center of box
    // Controller physicsY is origin.
    // Box center needs to be shift based on height
    // If Standing: Center is y + 4.
    // If Crouching: Mins/Maxs are [-15, -15, -24] to [15, 15, 12] (Total 36). Center = -6.

    // Dynamic calculation:
    // Feet Y = physicsY - 24 (always)
    // Center Y = Feet Y + height/2
    // Center Y = physicsY - 24 + height/2

    // Correct crouch behavior: feet stay on ground, head lowers
    // When crouched, origin drops by (PLAYER_MINS_Z - CROUCH_MINS_Z) = 20 units
    // to keep feet at the same level as standing
    // In FPSController, this logic is handled by setting physicsY.
    // But we are visualizing the hitbox relative to the ghost player.

    // Let's align with FPSController updateDebugBbox logic exactly:
    /*
        const crouchOriginDrop = isCrouched ? (PLAYER_MINS_Z - CROUCH_MINS_Z) : 0; 
        aheadPos.y = this.physicsY + crouchOriginDrop; // This puts it at feet level? No...
        */

    // The previous code in FPSController:
    // const crouchOriginDrop = isCrouched ? (PLAYER_MINS_Z - CROUCH_MINS_Z) : 0;
    // aheadPos.y = this.physicsY + crouchOriginDrop;

    // This looks like it was just placing the box at the origin?
    // If strict bounding box visualization is needed, we should be precise.
    // For now, porting the existing logic logic:

    const isCrouched = height < 56; // approximate check
    // In Quake 3:
    // Standard: -24 to 32 (56 units)
    // Crouch: -24 to 12 (36 units)
    // The origin stays at same relative point? No, viewheight changes.

    // Let's just copy exactly what was in FPSController to maintain behavior
    // it was: const crouchOriginDrop = isCrouched ? (PLAYER_MINS_Z - CROUCH_MINS_Z) : 0;
    // But PLAYER_MINS_Z etc are private constants in FPSController?
    // We'll need to define them or access them.

    // Checking FPSController imports... they are constants.
    // I will redefine them here for simplicity or export them.
    const CONST_PLAYER_MINS_Z = -24;
    const CONST_CROUCH_MINS_Z = -4; // Based on comment in FPSController: "-24 - (-4) = -20" -> Wait,
    // "origin drops by (PLAYER_MINS_Z - CROUCH_MINS_Z) = 20 units"
    // -24 - (-4) = -20. So CROUCH_MINS_Z is -4?

    const crouchOriginDrop = isCrouched ? CONST_PLAYER_MINS_Z - CONST_CROUCH_MINS_Z : 0;
    aheadPos.y += crouchOriginDrop;

    this.debugBboxMesh.position.copyFrom(aheadPos);
    this.debugBboxMesh.isVisible = true;
  }

  /**
   * Initialize debug player model via shared PlayerModelManager
   */
  private async initDebugPlayer(): Promise<void> {
    if (!this.scene || this.debugInitializing || this.debugInstance) return;

    this.debugInitializing = true;

    try {
      // Load model + animations (idempotent)
      await this.modelManager.loadModel();

      // Create instance
      const scaleCvar = Cvar.get("cl_debugplayer_scale");
      const scale = scaleCvar !== undefined ? Number(scaleCvar) : 36;
      this.debugInstance = this.modelManager.createInstance("debug", scale);
      if (!this.debugInstance) return;

      // Initialize smoothed values to prevent fly-in from origin
      const yaw = this.controller.getRotation().y;
      const forward = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const myPos = this.controller.getPlayerPosition();
      const initialPos = new Vector3(myPos.x, myPos.y, myPos.z);
      initialPos.addInPlace(forward.scale(100));

      const CONST_PLAYER_MINS_Z = -24;
      const MODEL_Y_OFFSET = 12;
      initialPos.y = myPos.y + CONST_PLAYER_MINS_Z + MODEL_Y_OFFSET;

      this.debugPlayerSmoothedPos.copyFrom(initialPos);
      this.debugPlayerSmoothedYaw = yaw;

      this.modelManager.playAnimation(this.debugInstance, "idle");
    } catch (error) {
      console.error("[DebugPlayer] Init error:", error);
    } finally {
      this.debugInitializing = false;
    }
  }

  /**
   * Update debug player model position and animation
   */
  private updateDebugPlayer(_deltaTime: number): void {
    if (!this.scene) return;

    const debugCvar = Cvar.get("cl_debugplayer");
    const debugEnabled = debugCvar !== undefined && Number(debugCvar) > 0;

    if (!debugEnabled) {
      if (this.debugInstance) {
        this.debugInstance.anchor.setEnabled(false);
        this.debugInstance.mesh.isVisible = false;
        this.debugInstance.mesh.getChildMeshes().forEach((m) => {
          m.isVisible = false;
        });
      }
      return;
    }

    // Initialize if needed
    if (!this.debugInstance && !this.debugInitializing) {
      background(this.initDebugPlayer(), "PlayerVisuals");
      return;
    }

    const inst = this.debugInstance;
    if (!inst) return;

    // Get cvars
    const offsetCvar = Cvar.get("cl_debugplayer_offset");
    const offset = offsetCvar !== undefined ? Number(offsetCvar) : 100;
    const scaleCvar = Cvar.get("cl_debugplayer_scale");
    const scale = scaleCvar !== undefined ? Number(scaleCvar) : 36;

    // Position the ANCHOR using stable physics coordinates
    const yaw = this.controller.getRotation().y;
    const forward = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));

    // Calculate target position
    const myPos = this.controller.getPlayerPosition();
    const targetPos = new Vector3(myPos.x, myPos.y, myPos.z);
    targetPos.addInPlace(forward.scale(offset));

    const CONST_PLAYER_MINS_Z = -24;
    const MODEL_Y_OFFSET = 12;
    targetPos.y = myPos.y + CONST_PLAYER_MINS_Z + MODEL_Y_OFFSET;

    // Smooth position
    const velocity = this.controller.getVelocity();
    const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    const positionSmoothFactor = speed > 10 ? 0.3 : 0.1;

    this.debugPlayerSmoothedPos.x += (targetPos.x - this.debugPlayerSmoothedPos.x) * positionSmoothFactor;
    this.debugPlayerSmoothedPos.y += (targetPos.y - this.debugPlayerSmoothedPos.y) * positionSmoothFactor;
    this.debugPlayerSmoothedPos.z += (targetPos.z - this.debugPlayerSmoothedPos.z) * positionSmoothFactor;

    // Smooth rotation
    let yawDelta = yaw - this.debugPlayerSmoothedYaw;
    while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
    while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    this.debugPlayerSmoothedYaw += yawDelta * 0.15;

    // Set anchor position and rotation
    inst.anchor.position.copyFrom(this.debugPlayerSmoothedPos);
    if (inst.anchor.rotationQuaternion) {
      inst.anchor.rotationQuaternion = null;
    }
    inst.anchor.rotation.set(0, this.debugPlayerSmoothedYaw, 0);
    inst.anchor.setEnabled(true);

    // Reset root motion and apply scale
    this.modelManager.resetRootMotion(inst);
    inst.mesh.scaling.set(scale, scale, scale);

    // Clear rotation
    if (inst.mesh.rotationQuaternion) {
      inst.mesh.rotationQuaternion = null;
    }
    inst.mesh.rotation.set(0, 0, 0);

    // Make visible
    inst.mesh.isVisible = true;
    inst.mesh.getChildMeshes().forEach((m) => {
      m.isVisible = true;
    });

    // Determine animation from movement state
    const derivedAnim = this.deriveAnimationState();

    if (this.modelManager.playAnimation(inst, derivedAnim)) {
      devLog(`[DebugPlayer] Switching to: ${derivedAnim} (speed: ${speed.toFixed(1)})`);
    }

    // Anim speed scaling
    if (inst.masterGroup) {
      const walkNaturalCvar = Cvar.get("cl_debugplayer_walk_speed");
      const runNaturalCvar = Cvar.get("cl_debugplayer_run_speed");
      const WALK_NATURAL_SPEED = walkNaturalCvar !== undefined ? Number(walkNaturalCvar) : 40;
      const RUN_NATURAL_SPEED = runNaturalCvar !== undefined ? Number(runNaturalCvar) : 100;
      const STRAFE_NATURAL_SPEED = 29;
      const JUMP_VELOCITY = 320;

      if (inst.currentAnim === "walk" || inst.currentAnim === "run") {
        const naturalSpeed = inst.currentAnim === "run" ? RUN_NATURAL_SPEED : WALK_NATURAL_SPEED;

        const velocityDir = new Vector3(velocity.x, 0, velocity.z);
        const forwardDot = Vector3.Dot(forward, velocityDir);
        const isMovingBackwards = forwardDot < 0;

        let speedRatio = speed / naturalSpeed;
        if (isMovingBackwards) speedRatio = -speedRatio;
        inst.masterGroup.speedRatio = Math.max(-3.0, Math.min(3.0, speedRatio));
      } else if (inst.currentAnim === "strafe_l" || inst.currentAnim === "strafe_r") {
        const right = new Vector3(forward.z, 0, -forward.x);
        const velocityDir = new Vector3(velocity.x, 0, velocity.z);
        const lateralSpeed = Math.abs(Vector3.Dot(right, velocityDir));
        const speedRatio = lateralSpeed / STRAFE_NATURAL_SPEED;
        inst.masterGroup.speedRatio = Math.max(0.3, Math.min(3.0, speedRatio));
      } else if (inst.currentAnim === "jump") {
        // Warsow-style: ascending plays forward, descending reverses
        if (velocity.y > 10) {
          inst.masterGroup.speedRatio = Math.max(0.3, (velocity.y / JUMP_VELOCITY) * 2.0);
        } else if (velocity.y < -10) {
          inst.masterGroup.speedRatio = Math.min(-0.2, (velocity.y / JUMP_VELOCITY) * 1.5);
        } else {
          inst.masterGroup.speedRatio = 0;
        }
      } else {
        inst.masterGroup.speedRatio = 1.0;
      }
    }
  }

  private deriveAnimationState(): string {
    // Replicate getDebugPlayerAnimationFromState logic
    // Requires exposing state from controller

    // Public properties on FPSController needed:
    // - isSliding
    // - getWallJumpState()
    // - isPlayerGrounded()
    // - getVelocity()
    // - mouseRotationY? (already have via getRotation)

    if (this.controller.isSliding) return "walk"; // Fallback

    // Need to check walljump state... FPSController has `getWallJumpState()` which returns complex object
    // But internal property `wallJumpState` is what we checked.
    // Access via public getter or add one.
    const wj = this.controller.getWallJumpState();
    if (wj.state !== "none") return "jump";

    const velocity = this.controller.getVelocity();

    if (!this.controller.isPlayerGrounded()) return "jump";

    const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);

    if (speed > 50) {
      const rotation = this.controller.getRotation();
      const forward = new Vector3(Math.sin(rotation.y), 0, Math.cos(rotation.y));
      const right = new Vector3(forward.z, 0, -forward.x);

      const forwardDot = forward.x * velocity.x + forward.z * velocity.z;
      const rightDot = right.x * velocity.x + right.z * velocity.z;

      if (Math.abs(rightDot) > Math.abs(forwardDot) * 1.5) {
        return rightDot > 0 ? "strafe_l" : "strafe_r";
      }

      return speed > 300 ? "run" : "walk";
    }

    return "idle";
  }
}
