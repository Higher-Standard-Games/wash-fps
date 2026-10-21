/**
 * RagdollSystem — Per-bone Havok ragdoll physics on death
 *
 * Uses BabylonJS's built-in `Ragdoll` class (Physics v2) to create
 * realistic per-bone ragdoll physics. Each major bone gets a physics
 * body connected by joints — Havok simulates them, driving the skinned mesh.
 *
 * Lifecycle:
 *   1. On non-gib death → detach model from RemotePlayerRenderer
 *   2. Stop/dispose animations
 *   3. Create Ragdoll from skeleton + bone config → call .ragdoll() to activate
 *   4. Apply initial velocity to root bone aggregate
 *   5. After RAGDOLL_LIFETIME seconds → gib-explode and dispose (Warsow-style)
 */

import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TrailMesh } from "@babylonjs/core/Meshes/trailMesh";
import type { IPhysicsEngine } from "@babylonjs/core/Physics/IPhysicsEngine";
import { PhysicsConstraintType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { PhysicsEngine } from "@babylonjs/core/Physics/v2/physicsEngine";
import { Ragdoll } from "@babylonjs/core/Physics/v2/ragdoll";
import type { Scene } from "@babylonjs/core/scene";
import { disposePlayerModel, type PlayerModelInstance } from "../../../engine/animation/PlayerModelManager";
import { background } from "../../../engine/core/AsyncErrors";
import { PhysicsSystem } from "../../../engine/physics/PhysicsSystem";
import { devLog } from "./DevLog";

// ============================================================================
// Constants
// ============================================================================

/** How long ragdoll simulates before gib-exploding (seconds) */
const RAGDOLL_LIFETIME = 5.0;

/** Maximum simultaneous ragdolls (oldest are force-disposed) */
const MAX_RAGDOLLS = 4;

/**
 * Launch speed along the server's knockback direction (units/sec).
 *
 * Matches the magnitude of the old fixed 600-horizontal + 300-up launch
 * (hypot ≈ 671), so deaths stay as cartoonishly punchy as before — what changed
 * is the DIRECTION. Previously the horizontal part was renormalized to a flat
 * 600 and the vertical was always 300, which threw away the server's whole
 * knockback vector; and when a kill had no horizontal component — a rocket or
 * grenade at your feet, the most common death in the game — the client fell back
 * to a RANDOM compass heading at full speed, flinging the corpse somewhere
 * unrelated to the frag. Now the body flies along the same upward-biased vector
 * that pushed the player.
 */
const LAUNCH_SPEED = 670;

/** Max linear velocity for Havok physics engine — must be raised to allow ragdoll launches */
const HAVOK_MAX_LINEAR_VELOCITY = 10000;

/** Ragdoll gravity multiplier (1.0 = normal, 0.8 = slightly floatier arcs) */
const RAGDOLL_GRAVITY_FACTOR = 0.8;

/** Speed trail settings */
const TRAIL_LIFETIME = 1.0; // seconds before trail fades
const TRAIL_DIAMETER = 8; // trail ribbon width
const TRAIL_LENGTH = 30; // trail segment count

/** Model scale used in RemotePlayerRenderer — physics boxes must match */
const MODEL_SCALE = 36;

// ============================================================================
// Vanguard (Mixamo) bone config for ragdoll
// ============================================================================

/**
 * Extended bone config — the BabylonJS Ragdoll class source code uses
 * `bone` or `bones` properties to map config entries to skeleton bones,
 * but these are NOT declared in the .d.ts type definition.
 * We use `any` cast when passing to the constructor.
 */
interface BoneConfig {
  bone: string; // bone name (maps to skeleton)
  width?: number;
  height?: number;
  depth?: number;
  size?: number;
  joint?: number; // PhysicsConstraintType
  rotationAxis?: Vector3;
  min?: number;
  max?: number;
  mass?: number;
  restitution?: number;
  boxOffset?: number;
  boneOffsetAxis?: Vector3;
  putBoxInBoneCenter?: boolean;
}

/**
 * Maps key bones of the Mixamo Vanguard skeleton to box physics shapes.
 *
 * IMPORTANT: Sizes are in WORLD SPACE — already scaled by MODEL_SCALE (36).
 * The Ragdoll class uses these directly as PhysicsAggregate extents.
 */
function createBoneConfig(): BoneConfig[] {
  const S = MODEL_SCALE;
  return [
    // ── Torso chain ──
    {
      bone: "mixamorig:Hips",
      width: 0.3 * S,
      height: 0.15 * S,
      depth: 0.2 * S,
      mass: 2,
      restitution: 0,
    },
    {
      bone: "mixamorig:Spine",
      width: 0.25 * S,
      height: 0.12 * S,
      depth: 0.18 * S,
      joint: PhysicsConstraintType.BALL_AND_SOCKET,
      rotationAxis: Vector3.Right(),
      min: -0.1,
      max: 0.1,
      restitution: 0,
    },
    {
      bone: "mixamorig:Spine2",
      width: 0.32 * S,
      height: 0.16 * S,
      depth: 0.22 * S,
      joint: PhysicsConstraintType.BALL_AND_SOCKET,
      rotationAxis: Vector3.Right(),
      min: -0.1,
      max: 0.1,
      restitution: 0,
      mass: 1,
    },

    // ── Head ──
    {
      bone: "mixamorig:Neck",
      width: 0.08 * S,
      height: 0.05 * S,
      depth: 0.08 * S,
      joint: PhysicsConstraintType.BALL_AND_SOCKET,
      rotationAxis: Vector3.Right(),
      min: -0.15,
      max: 0.15,
      restitution: 0,
      mass: 1,
    },
    {
      bone: "mixamorig:Head",
      width: 0.18 * S,
      height: 0.22 * S,
      depth: 0.18 * S,
      joint: PhysicsConstraintType.BALL_AND_SOCKET,
      rotationAxis: Vector3.Right(),
      min: -0.2,
      max: 0.2,
      restitution: 0,
      mass: 1,
    },

    // ── Left arm ──
    {
      bone: "mixamorig:LeftArm",
      width: 0.08 * S,
      height: 0.22 * S,
      depth: 0.08 * S,
      joint: PhysicsConstraintType.BALL_AND_SOCKET,
      rotationAxis: Vector3.Forward(),
      min: -0.6,
      max: 0.6,
      restitution: 0,
      mass: 1,
    },
    {
      bone: "mixamorig:LeftForeArm",
      width: 0.06 * S,
      height: 0.22 * S,
      depth: 0.06 * S,
      joint: PhysicsConstraintType.HINGE,
      rotationAxis: Vector3.Right(),
      min: -1.5,
      max: 0.0,
      restitution: 0,
      mass: 1,
    },

    // ── Right arm ──
    {
      bone: "mixamorig:RightArm",
      width: 0.08 * S,
      height: 0.22 * S,
      depth: 0.08 * S,
      joint: PhysicsConstraintType.BALL_AND_SOCKET,
      rotationAxis: Vector3.Forward(),
      min: -0.6,
      max: 0.6,
      restitution: 0,
      mass: 1,
    },
    {
      bone: "mixamorig:RightForeArm",
      width: 0.06 * S,
      height: 0.22 * S,
      depth: 0.06 * S,
      joint: PhysicsConstraintType.HINGE,
      rotationAxis: Vector3.Right(),
      min: -1.5,
      max: 0.0,
      restitution: 0,
      mass: 1,
    },

    // ── Left leg ──
    {
      bone: "mixamorig:LeftUpLeg",
      width: 0.12 * S,
      height: 0.4 * S,
      depth: 0.12 * S,
      joint: PhysicsConstraintType.BALL_AND_SOCKET,
      rotationAxis: Vector3.Right(),
      min: -0.5,
      max: 0.3,
      restitution: 0,
      mass: 1,
    },
    {
      bone: "mixamorig:LeftLeg",
      width: 0.1 * S,
      height: 0.38 * S,
      depth: 0.1 * S,
      joint: PhysicsConstraintType.HINGE,
      rotationAxis: Vector3.Right(),
      min: 0.0,
      max: 1.2,
      restitution: 0,
      mass: 1,
    },
    {
      bone: "mixamorig:LeftFoot",
      width: 0.1 * S,
      height: 0.06 * S,
      depth: 0.2 * S,
      joint: PhysicsConstraintType.BALL_AND_SOCKET,
      rotationAxis: Vector3.Right(),
      min: -0.2,
      max: 0.2,
      restitution: 0,
      mass: 1,
    },

    // ── Right leg ──
    {
      bone: "mixamorig:RightUpLeg",
      width: 0.12 * S,
      height: 0.4 * S,
      depth: 0.12 * S,
      joint: PhysicsConstraintType.BALL_AND_SOCKET,
      rotationAxis: Vector3.Right(),
      min: -0.5,
      max: 0.3,
      restitution: 0,
      mass: 1,
    },
    {
      bone: "mixamorig:RightLeg",
      width: 0.1 * S,
      height: 0.38 * S,
      depth: 0.1 * S,
      joint: PhysicsConstraintType.HINGE,
      rotationAxis: Vector3.Right(),
      min: 0.0,
      max: 1.2,
      restitution: 0,
      mass: 1,
    },
    {
      bone: "mixamorig:RightFoot",
      width: 0.1 * S,
      height: 0.06 * S,
      depth: 0.2 * S,
      joint: PhysicsConstraintType.BALL_AND_SOCKET,
      rotationAxis: Vector3.Right(),
      min: -0.2,
      max: 0.2,
      restitution: 0,
      mass: 1,
    },
  ];
}

// ============================================================================
// Active ragdoll instance
// ============================================================================

interface ActiveRagdoll {
  model: PlayerModelInstance;
  ragdoll: Ragdoll;
  /** Seconds lived, by the clock update() is handed: wall time live, the playhead in a demo. */
  age: number;
  disposed: boolean;
  /** Speed trail mesh attached to hips bone */
  trail: TrailMesh | null;
  trailMat: StandardMaterial | null;
}

/**
 * Handle returned from spawn() so a caller (e.g. the death camera) can follow a
 * ragdoll's live position without reaching into its physics internals.
 */
export interface RagdollHandle {
  /** World position of the hips bone, or null once the ragdoll is disposed. */
  getPosition(): Vector3 | null;
  /** Whether the ragdoll is still simulating. */
  isAlive(): boolean;
}

// ============================================================================
// RagdollSystem
// ============================================================================

export class RagdollSystem {
  private static instance: RagdollSystem | null = null;

  private scene: Scene | null = null;
  private ragdolls: ActiveRagdoll[] = [];
  private physicsReady = false;

  /** Callback for gib explosion on ragdoll cleanup */
  private onGibExplode: ((x: number, y: number, z: number, vx: number, vy: number, vz: number) => void) | null = null;

  private constructor() {}

  static getInstance(): RagdollSystem {
    if (!RagdollSystem.instance) {
      RagdollSystem.instance = new RagdollSystem();
    }
    return RagdollSystem.instance;
  }

  /** Create an independently-owned instance for demo playback. */
  static create(scene: Scene): RagdollSystem {
    const system = new RagdollSystem();
    system.init(scene);
    return system;
  }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  init(scene: Scene): void {
    if (this.scene === scene) return;
    if (this.scene) {
      this.disposeAll();
    }
    this.scene = scene;

    // Ensure Havok physics is enabled on this scene
    background(this.ensurePhysics(scene), "RagdollSystem");

    devLog(`[RagdollSystem] Initialized`);
  }

  private async ensurePhysics(scene: Scene): Promise<void> {
    const physics = PhysicsSystem.getInstance();
    if (!physics.isInitialized()) {
      const ok = await physics.enablePhysics(scene);
      if (!ok) {
        console.warn("[RagdollSystem] Failed to enable Havok physics");
        return;
      }
    }
    this.physicsReady = true;
  }

  setGibCallback(cb: (x: number, y: number, z: number, vx: number, vy: number, vz: number) => void): void {
    this.onGibExplode = cb;
  }

  // ========================================================================
  // Spawn ragdoll
  // ========================================================================

  spawn(model: PlayerModelInstance, dirX: number, dirY: number, dirZ: number): RagdollHandle | null {
    if (!this.scene) {
      console.warn("[RagdollSystem] Not initialized — disposing model");
      this.disposeModel(model);
      return null;
    }

    if (!this.physicsReady) {
      console.warn("[RagdollSystem] Havok physics not ready — disposing model");
      this.disposeModel(model);
      return null;
    }

    if (!model.skeleton) {
      console.warn("[RagdollSystem] Model has no skeleton — disposing");
      this.disposeModel(model);
      return null;
    }

    // Enforce max ragdolls
    while (this.ragdolls.length >= MAX_RAGDOLLS) {
      const oldest = this.ragdolls.shift();
      if (oldest && !oldest.disposed) {
        this.disposeRagdoll(oldest, false);
      }
    }

    try {
      // 1. FULLY DISPOSE all animations — they fight with physics
      if (model.masterGroup) {
        model.masterGroup.stop();
        model.masterGroup.dispose();
        model.masterGroup = null;
      }
      for (const anim of model.anims) {
        for (const entry of anim.animations) {
          if (entry.target) {
            this.scene?.stopAnimation(entry.target);
          }
        }
      }
      model.anims = [];

      // Stop the groups that drive THIS body — a one-shot overlay outlives the
      // master group and would fight physics for the bones.
      //
      // This used to stop every group in the scene, so any death froze every
      // other player where they stood. Entity LOD has been hiding it since it
      // landed: it restarts a stopped group the next frame it judges the body
      // visible, which repaired the damage before anyone saw it.
      if (this.scene) {
        for (const ag of this.scene.animationGroups) {
          const drivesThisBody = ag.targetedAnimations.some(({ target }) => {
            const node = target as { isDescendantOf?: (ancestor: object) => boolean } | null;
            return target === model.mesh || node?.isDescendantOf?.(model.mesh) === true;
          });
          if (drivesThisBody) ag.stop();
        }
      }

      // 2. Mark meshes non-pickable
      model.mesh.isPickable = false;
      model.mesh.name = `ragdoll_${model.id}`;
      for (const child of model.mesh.getChildMeshes()) {
        child.isPickable = false;
      }

      // 3. Log skeleton bones for debugging
      const boneNames = model.skeleton.bones.map((b) => b.name);
      devLog(`[RagdollSystem] Skeleton has ${boneNames.length} bones: ${boneNames.slice(0, 8).join(", ")}...`);

      // 4. Build bone config and verify all required bones exist
      const boneConfig = createBoneConfig();
      const missingBones = boneConfig.filter((cfg) => !model.skeleton!.bones.some((b) => b.name === cfg.bone));
      if (missingBones.length > 0) {
        console.warn(`[RagdollSystem] Missing bones: ${missingBones.map((b) => b.bone).join(", ")}`);
        this.disposeModel(model);
        return null;
      }

      // 5. Create BabylonJS Ragdoll
      //    The .d.ts type doesn't declare the 'bone' property, but the source code
      //    uses it to map config entries to skeleton bones
      devLog(`[RagdollSystem] Creating ragdoll with ${boneConfig.length} bone configs`);

      const ragdollInstance = new Ragdoll(
        model.skeleton,
        model.mesh, // rootTransformNode — the skinned mesh
        boneConfig,
      );

      // 6. Raise Havok’s global max velocity so our launch isn’t clamped
      // Only the v2 engine has velocity limits; the shared interface omits them.
      const physicsEngine = this.scene!.getPhysicsEngine() as
        | (IPhysicsEngine & Partial<Pick<PhysicsEngine, "getMaxLinearVelocity" | "setVelocityLimits">>)
        | null;
      if (physicsEngine) {
        const currentMax = physicsEngine.getMaxLinearVelocity?.() ?? 0;
        if (currentMax < HAVOK_MAX_LINEAR_VELOCITY) {
          physicsEngine.setVelocityLimits?.(HAVOK_MAX_LINEAR_VELOCITY, 100);
          devLog(`[RagdollSystem] Raised Havok max linear velocity from ${currentMax} to ${HAVOK_MAX_LINEAR_VELOCITY}`);
        }
      }

      // 7. Activate ragdoll mode — Havok Physics takes over bone transforms
      ragdollInstance.ragdoll();
      devLog("[RagdollSystem] Ragdoll mode activated");

      // 8. Apply knockback velocity to ALL bone aggregates.
      // Fly along the FULL 3D direction the server sent (already normalized and
      // upward-biased by CombatSystem), scaled to the launch speed. A degenerate
      // direction pops straight up rather than picking a random heading.
      const dirLen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
      const launchVel =
        dirLen > 0.001
          ? new Vector3((dirX / dirLen) * LAUNCH_SPEED, (dirY / dirLen) * LAUNCH_SPEED, (dirZ / dirLen) * LAUNCH_SPEED)
          : new Vector3(0, LAUNCH_SPEED, 0);

      for (let b = 0; b < boneConfig.length; b++) {
        try {
          const agg = ragdollInstance.getAggregate(b);
          if (agg?.body) {
            agg.body.setLinearVelocity(launchVel);
            agg.body.setGravityFactor(RAGDOLL_GRAVITY_FACTOR);
          }
        } catch {
          /* skip */
        }
      }
      devLog(
        `[RagdollSystem] Applied velocity (${launchVel.x.toFixed(0)}, ${launchVel.y.toFixed(0)}, ${launchVel.z.toFixed(0)}) gravity=${RAGDOLL_GRAVITY_FACTOR} to ${boneConfig.length} bones`,
      );

      // 9. Create speed trail attached to hips bone
      let trail: TrailMesh | null = null;
      let trailMat: StandardMaterial | null = null;
      try {
        // Extract player color from model's PBR material
        const trailColor = this.extractModelColor(model);

        // Attach trail to hips bone aggregate transform
        const hipsAgg = ragdollInstance.getAggregate(0);
        if (hipsAgg?.body?.transformNode) {
          trail = new TrailMesh(
            "ragdoll_trail",
            hipsAgg.body.transformNode,
            this.scene!,
            TRAIL_DIAMETER,
            TRAIL_LENGTH,
            true,
          );
          trailMat = new StandardMaterial("ragdoll_trail_mat", this.scene!);
          trailMat.emissiveColor = trailColor;
          trailMat.diffuseColor = trailColor;
          trailMat.disableLighting = true;
          trailMat.alpha = 0.6;
          trailMat.backFaceCulling = false;
          trail.material = trailMat;
          trail.isPickable = false;
        }
      } catch (e) {
        console.warn("[RagdollSystem] Trail creation failed:", e);
      }

      // 10. Track active ragdoll
      const active: ActiveRagdoll = {
        model,
        ragdoll: ragdollInstance,
        age: 0,
        disposed: false,
        trail,
        trailMat,
      };
      this.ragdolls.push(active);

      const worldPos = model.anchor.getAbsolutePosition();
      devLog(
        `[RagdollSystem] Spawned per-bone ragdoll at (${worldPos.x.toFixed(0)}, ${worldPos.y.toFixed(0)}, ${worldPos.z.toFixed(0)}) (${this.ragdolls.length} active)`,
      );

      // Follow handle — lets the death camera trail the hips bone without touching
      // physics internals. Returns null once this ragdoll is disposed.
      return {
        getPosition: (): Vector3 | null => {
          if (active.disposed) return null;
          try {
            const hips = ragdollInstance.getAggregate(0);
            return hips?.body?.transformNode?.getAbsolutePosition() ?? null;
          } catch {
            return null;
          }
        },
        isAlive: (): boolean => !active.disposed,
      };
    } catch (e) {
      console.error("[RagdollSystem] Failed to create ragdoll:", e);
      this.disposeModel(model);
      return null;
    }
  }

  // ========================================================================
  // Per-frame update
  // ========================================================================

  /** Age every ragdoll by `dt` seconds: trails fade, then each fades out and bursts. */
  update(dt: number): void {
    if (!this.scene) return;

    for (let i = this.ragdolls.length - 1; i >= 0; i--) {
      const active = this.ragdolls[i];
      if (active.disposed) {
        this.ragdolls.splice(i, 1);
        continue;
      }

      active.age += Math.max(0, dt);
      const age = active.age;

      // Fade and dispose trail after TRAIL_LIFETIME
      if (active.trail && age < TRAIL_LIFETIME) {
        const trailAlpha = 0.6 * (1 - age / TRAIL_LIFETIME);
        if (active.trailMat) active.trailMat.alpha = trailAlpha;
      } else if (active.trail && age >= TRAIL_LIFETIME) {
        active.trail.dispose();
        active.trail = null;
        if (active.trailMat) {
          active.trailMat.dispose();
          active.trailMat = null;
        }
      }

      // Fade mesh visibility in last second
      if (age > RAGDOLL_LIFETIME - 1.0) {
        const fade = Math.max(0, RAGDOLL_LIFETIME - age);
        active.model.mesh.visibility = fade;
        for (const child of active.model.mesh.getChildMeshes()) {
          child.visibility = fade;
        }
      }

      // Expire: gib-explode and dispose
      if (age >= RAGDOLL_LIFETIME) {
        this.disposeRagdoll(active, true);
        this.ragdolls.splice(i, 1);
      }
    }
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  /** Extract dominant color from player model's PBR material (team color) */
  private extractModelColor(model: PlayerModelInstance): Color3 {
    const allMeshes = [model.mesh, ...model.mesh.getChildMeshes()];
    for (const mesh of allMeshes) {
      const mat = mesh.material as PBRMaterial | null;
      if (mat?.albedoColor) {
        // Team colors are HDR (>1.0), clamp for trail material
        return new Color3(
          Math.min(1, mat.albedoColor.r),
          Math.min(1, mat.albedoColor.g),
          Math.min(1, mat.albedoColor.b),
        );
      }
    }
    // Fallback: white
    return Color3.White();
  }

  // ========================================================================
  // Cleanup
  // ========================================================================

  private disposeRagdoll(active: ActiveRagdoll, gibExplode: boolean): void {
    if (active.disposed) return;
    active.disposed = true;

    // Gib explosion at ragdoll's current position
    if (gibExplode && this.onGibExplode) {
      // Get position from root aggregate or anchor
      let pos: Vector3;
      try {
        const rootAgg = active.ragdoll.getAggregate(0);
        pos = rootAgg?.transformNode?.getAbsolutePosition() ?? active.model.anchor.getAbsolutePosition();
      } catch {
        pos = active.model.anchor.getAbsolutePosition();
      }
      this.onGibExplode(pos.x, pos.y, pos.z, 0, 0, 0);
    }

    // Dispose trail
    if (active.trail) {
      try {
        active.trail.dispose();
      } catch (_) {
        /* noop */
      }
      active.trail = null;
    }
    if (active.trailMat) {
      try {
        active.trailMat.dispose();
      } catch (_) {
        /* noop */
      }
      active.trailMat = null;
    }

    // Dispose ragdoll (cleans up physics bodies + joints)
    try {
      active.ragdoll.dispose();
    } catch (e) {
      console.warn("[RagdollSystem] Error disposing ragdoll:", e);
    }

    // Dispose model
    this.disposeModel(active.model);
    devLog(`[RagdollSystem] Disposed ragdoll for ${active.model.id}`);
  }

  private disposeModel(model: PlayerModelInstance): void {
    // The same path every player model leaves by: hand weapon (bone-attached,
    // so not a scene-graph child), cloned materials and the loader's leftovers.
    try {
      disposePlayerModel(model);
    } catch (_) {
      /* noop */
    }
  }

  disposeAll(): void {
    for (const rd of this.ragdolls) {
      if (!rd.disposed) {
        this.disposeRagdoll(rd, false);
      }
    }
    this.ragdolls = [];
  }

  dispose(): void {
    this.disposeAll();
    this.scene = null;
    RagdollSystem.instance = null;
  }
}
