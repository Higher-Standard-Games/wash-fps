import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { anchorYaw, chooseDeathClip, type DeathClip, type DeathFacts, deathClipYaw } from "./ragdoll/DeathClip";
import { createRagdollFrame } from "./ragdoll/RagdollFrame";
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
 *   3. A death that has a clip (see `chooseDeathClip`) is thrown first: the
 *      body turns to the shot, one sphere flies the launch arc and the clip
 *      plays once on the body, until the sphere touches a surface or the clip
 *      ends
 *   4. Create Ragdoll from skeleton + bone config → call .ragdoll() to activate
 *   5. Give every bone the launch velocity, or the sphere's after a throw
 *   6. Once the body comes to rest (or after RAGDOLL_LIFETIME at the latest)
 *      → fade out, gib-explode and dispose (Warsow-style)
 */

import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TrailMesh } from "@babylonjs/core/Meshes/trailMesh";
import type { IPhysicsEngine } from "@babylonjs/core/Physics/IPhysicsEngine";
import {
  type IPhysicsCollisionEvent,
  PhysicsConstraintType,
  PhysicsEventType,
  PhysicsShapeType,
} from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import type { PhysicsEngine } from "@babylonjs/core/Physics/v2/physicsEngine";
import { Ragdoll } from "@babylonjs/core/Physics/v2/ragdoll";
import type { Scene } from "@babylonjs/core/scene";
import {
  cancelRootMotion,
  type PlayerModelInstance,
  releaseLocomotionGroups,
  releasePlayerModel,
} from "../../../engine/animation/PlayerModelManager";
import { background } from "../../../engine/core/AsyncErrors";
import { PhysicsSystem } from "../../../engine/physics/PhysicsSystem";
import { devLog } from "./DevLog";
import type { GibColor } from "./GibSystem";
import { BatchedPoseSync } from "./ragdoll/BatchedPoseSync";

// ============================================================================
// Constants
// ============================================================================

/** Bursts a ragdoll into gibs where it lies, in the colour its body was drawn with. */
export type GibCallback = (
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  color: GibColor | null,
) => void;

/** Longest a ragdoll simulates before gib-exploding, resting or not (seconds) */
const RAGDOLL_LIFETIME = 5.0;
/** Seconds a ragdoll takes to fade out before it bursts into gibs. */
const RAGDOLL_FADE = 1.0;
/** A ragdoll is not judged at rest before it has flown this long (seconds). */
const REST_MIN_AGE = 0.5;
/**
 * At rest: the hips stay within this distance of where they were for
 * REST_SECONDS. A body rolling or jittering in a corner moves without going
 * anywhere, so position, not speed, decides.
 */
const REST_RADIUS = 12;
const REST_SECONDS = 0.4;

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

/**
 * The sphere a thrown body flies as: centred on the hips and as wide as the
 * body reaches from them, so it meets a floor or wall before a limb of the
 * posed body can pass into it, and the ragdoll never starts inside the world.
 * Contacts in the first THROW_CONTACT_GRACE seconds do not end the throw, so
 * the floor the player died standing on does not.
 */
const THROW_RADIUS = 34;
const THROW_CONTACT_GRACE = 0.1;
/** Hips height above the anchor when the body has no hips joint to measure. */
const THROW_HIPS_HEIGHT = 34;

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

/** A node's world position with its whole parent chain recomputed first. */
function worldPositionNow(node: TransformNode): Vector3 {
  const chain: TransformNode[] = [];
  for (let n: TransformNode | null = node; n; n = n.parent as TransformNode | null) chain.unshift(n);
  for (const n of chain) n.computeWorldMatrix(true);
  return node.getAbsolutePosition().clone();
}

// ============================================================================
// Active ragdoll instance
// ============================================================================

/** A body playing its death clip while one sphere flies the launch arc. */
interface DeathThrow {
  aggregate: PhysicsAggregate;
  /** The sphere's node, at the hips; the body's anchor follows it. */
  node: TransformNode;
  hipsHeight: number;
  group: AnimationGroup;
  fromFrame: number;
  framesPerSecond: number;
  clipLength: number;
  clipTime: number;
  /** Set by the sphere's collision events once past the grace time. */
  touched: boolean;
  /** The world normal of the surface it touched, when the contact gave one. */
  surface: Vector3 | null;
  observer: Observer<IPhysicsCollisionEvent> | null;
}

interface ActiveRagdoll {
  model: PlayerModelInstance;
  /** Null while the body is still thrown, before the ragdoll takes over. */
  ragdoll: Ragdoll | null;
  poseSync: BatchedPoseSync | null;
  frame: TransformNode | null;
  throw: DeathThrow | null;
  /** The throw's node, kept after the handoff to carry the trail along the hips. */
  trailFollower: TransformNode | null;
  /** Seconds lived, by the clock update() is handed: wall time live, the playhead in a demo. */
  age: number;
  disposed: boolean;
  /** The colour the body was drawn with, which its gibs take; null when untinted. */
  color: GibColor | null;
  /** Where the hips were when the current rest check began, and for how long they have stayed. */
  restAnchor: Vector3 | null;
  restSeconds: number;
  /** Age at which the fade-out began, once the body came to rest or ran out of time. */
  fadeStart: number | null;
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
  private onGibExplode: GibCallback | null = null;

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

  setGibCallback(cb: GibCallback): void {
    this.onGibExplode = cb;
  }

  // ========================================================================
  // Spawn ragdoll
  // ========================================================================

  /**
   * Throw a dead body. With `facts` from its death event the body may play a
   * death clip in flight first (see `chooseDeathClip`); without them, or with
   * no clip for this death, it goes limp at once.
   */
  spawn(
    model: PlayerModelInstance,
    dirX: number,
    dirY: number,
    dirZ: number,
    facts?: DeathFacts,
  ): RagdollHandle | null {
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

    PhysicsSystem.getInstance().ensureBspCollision();

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

    let active: ActiveRagdoll | null = null;
    try {
      // The clip is chosen against the way the body faced when it died
      const clip = facts ? chooseDeathClip(facts, anchorYaw(model.anchor)) : null;
      const clipAnim = clip ? model.anims.find((anim) => anim.name === clip && anim.animations.length) : undefined;

      // 1. FULLY DISPOSE all animations — they fight with physics
      releaseLocomotionGroups(model);
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

      // 4. Verify all required bones exist
      const missingBones = createBoneConfig().filter((cfg) => !model.skeleton!.bones.some((b) => b.name === cfg.bone));
      if (missingBones.length > 0) {
        console.warn(`[RagdollSystem] Missing bones: ${missingBones.map((b) => b.bone).join(", ")}`);
        this.disposeModel(model);
        return null;
      }

      // Fly along the FULL 3D direction the server sent (already normalized and
      // upward-biased by CombatSystem), scaled to the launch speed. A degenerate
      // direction pops straight up rather than picking a random heading.
      const dirLen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
      const launchVel =
        dirLen > 0.001
          ? new Vector3((dirX / dirLen) * LAUNCH_SPEED, (dirY / dirLen) * LAUNCH_SPEED, (dirZ / dirLen) * LAUNCH_SPEED)
          : new Vector3(0, LAUNCH_SPEED, 0);

      active = {
        model,
        ragdoll: null,
        poseSync: null,
        frame: null,
        throw: null,
        trailFollower: null,
        age: 0,
        disposed: false,
        color: this.modelTint(model),
        restAnchor: null,
        restSeconds: 0,
        fadeStart: null,
        trail: null,
        trailMat: null,
      };

      // 5. Throw the body with its clip playing, or let it go limp now
      if (clip && clipAnim) active.throw = this.startThrow(model, clip, clipAnim.animations, launchVel, dirX, dirZ);
      if (!active.throw) this.activateRagdoll(active, launchVel);

      // 6. Create the speed trail, on the sphere or the hips bone
      try {
        // Extract player color from model's PBR material
        const trailColor = this.extractModelColor(model);
        const trailNode = active.throw?.node ?? active.ragdoll?.getAggregate(0)?.body?.transformNode;
        if (trailNode) {
          const trail = new TrailMesh("ragdoll_trail", trailNode, this.scene!, TRAIL_DIAMETER, TRAIL_LENGTH, true);
          const trailMat = new StandardMaterial("ragdoll_trail_mat", this.scene!);
          trailMat.emissiveColor = trailColor;
          trailMat.diffuseColor = trailColor;
          trailMat.disableLighting = true;
          trailMat.alpha = 0.6;
          trailMat.backFaceCulling = false;
          trail.material = trailMat;
          trail.isPickable = false;
          active.trail = trail;
          active.trailMat = trailMat;
        }
      } catch (e) {
        console.warn("[RagdollSystem] Trail creation failed:", e);
      }

      // 7. Track active ragdoll
      this.ragdolls.push(active);

      const worldPos = model.anchor.getAbsolutePosition();
      devLog(
        `[RagdollSystem] Spawned ${active.throw ? `thrown body (${clip})` : "per-bone ragdoll"} at (${worldPos.x.toFixed(0)}, ${worldPos.y.toFixed(0)}, ${worldPos.z.toFixed(0)}) (${this.ragdolls.length} active)`,
      );

      // Follow handle — lets the death camera trail the body without touching
      // physics internals. Returns null once this ragdoll is disposed.
      const followed = active;
      return {
        getPosition: (): Vector3 | null => this.bodyPosition(followed),
        isAlive: (): boolean => !followed.disposed,
      };
    } catch (e) {
      console.error("[RagdollSystem] Failed to create ragdoll:", e);
      if (active) this.releaseBody(active);
      this.disposeModel(model);
      return null;
    }
  }

  /**
   * Turn the body to the shot and fly it as one sphere along `launchVel`,
   * with the death clip posed frame by frame from `update`. Null when the clip
   * targets nothing on this body.
   */
  private startThrow(
    model: PlayerModelInstance,
    clip: DeathClip,
    animations: PlayerModelInstance["anims"][number]["animations"],
    launchVel: Vector3,
    dirX: number,
    dirZ: number,
  ): DeathThrow | null {
    const scene = this.scene!;
    const group = new AnimationGroup(`death_${model.id}_${clip}`, scene);
    for (const item of animations) {
      if (item.target) group.addTargetedAnimation(item.animation, item.target);
    }
    if (!group.targetedAnimations.length) {
      group.dispose();
      return null;
    }

    // Measured before the turn. The local player's corpse is built this same
    // tick and has never been drawn, so its matrices are brought up to date.
    const anchorPos = worldPositionNow(model.anchor);
    const measured = model.hipsBind ? worldPositionNow(model.hipsBind.node).y - anchorPos.y : Number.NaN;
    const hipsHeight = measured > 5 && measured < 80 ? measured : THROW_HIPS_HEIGHT;

    model.anchor.rotationQuaternion = null;
    model.anchor.rotation.y = deathClipYaw(clip, dirX, dirZ);

    const framesPerSecond = group.targetedAnimations[0].animation.framePerSecond || 60;
    const fromFrame = group.from;
    group.start(false, 1, group.from, group.to);
    group.pause();
    group.goToFrame(fromFrame);
    cancelRootMotion(model);

    const node = new TransformNode(`death_throw_${model.id}`, scene);
    node.position.set(anchorPos.x, anchorPos.y + hipsHeight, anchorPos.z);
    const aggregate = new PhysicsAggregate(
      node,
      PhysicsShapeType.SPHERE,
      { mass: 1, radius: THROW_RADIUS, restitution: 0 },
      scene,
    );
    // The sphere only carries the body's position: it never tumbles
    aggregate.body.setMassProperties({ mass: 1, inertia: Vector3.Zero() });
    aggregate.body.setLinearVelocity(launchVel);
    aggregate.body.setGravityFactor(RAGDOLL_GRAVITY_FACTOR);
    aggregate.body.setCollisionCallbackEnabled(true);

    const thrown: DeathThrow = {
      aggregate,
      node,
      hipsHeight,
      group,
      fromFrame,
      framesPerSecond,
      clipLength: (group.to - group.from) / framesPerSecond,
      clipTime: 0,
      touched: false,
      surface: null,
      observer: null,
    };
    thrown.observer = aggregate.body.getCollisionObservable().add((event) => {
      if (event.type !== PhysicsEventType.COLLISION_FINISHED && thrown.clipTime >= THROW_CONTACT_GRACE) {
        thrown.touched = true;
        if (event.normal) thrown.surface = event.normal.clone();
      }
    });
    return thrown;
  }

  /** Advance a thrown body's clip and carry it along its sphere; hand it to the ragdoll once it lands. */
  private advanceThrow(active: ActiveRagdoll, dt: number): void {
    const thrown = active.throw!;
    // The pose drawn last frame is the one the ragdoll starts from, so the
    // handoff happens before anything moves again
    if (thrown.touched || thrown.clipTime >= thrown.clipLength) {
      this.endThrow(active);
      return;
    }
    thrown.clipTime = Math.min(thrown.clipLength, thrown.clipTime + Math.max(0, dt));
    thrown.group.goToFrame(thrown.fromFrame + thrown.clipTime * thrown.framesPerSecond);
    cancelRootMotion(active.model);
    const p = thrown.node.position;
    active.model.anchor.setAbsolutePosition(new Vector3(p.x, p.y - thrown.hipsHeight, p.z));
  }

  /** Let a thrown body go limp, moving as its sphere was. */
  private endThrow(active: ActiveRagdoll): void {
    const thrown = active.throw!;
    active.throw = null;
    const velocity = thrown.aggregate.body.getLinearVelocity();
    // The ragdoll does not carry on into the surface the body landed on: a
    // limb box driven into a floor or wall at speed passes through it
    if (thrown.surface && thrown.surface.lengthSquared() > 1e-6) {
      const normal = thrown.surface.normalize();
      velocity.subtractInPlace(normal.scale(Vector3.Dot(velocity, normal)));
    }
    this.releaseThrow(thrown, !!active.trail);
    if (active.trail) active.trailFollower = thrown.node;
    try {
      this.activateRagdoll(active, velocity);
    } catch (e) {
      console.error("[RagdollSystem] Failed to create ragdoll after the throw:", e);
      this.disposeRagdoll(active, true);
    }
  }

  /** Stop a throw's clip and remove its sphere; the node stays when the trail still rides it. */
  private releaseThrow(thrown: DeathThrow, keepNode: boolean): void {
    thrown.observer?.remove();
    thrown.observer = null;
    thrown.group.stop();
    thrown.group.dispose();
    try {
      thrown.aggregate.dispose();
    } catch (e) {
      console.warn("[RagdollSystem] Failed to release the throw sphere:", e);
    }
    if (!keepNode) thrown.node.dispose();
  }

  /** Build the per-bone ragdoll from the body's current pose and launch every bone at `velocity`. */
  private activateRagdoll(active: ActiveRagdoll, velocity: Vector3): void {
    const { model } = active;
    const boneConfig = createBoneConfig();

    // The .d.ts type doesn't declare the 'bone' property, but the source code
    // uses it to map config entries to skeleton bones
    devLog(`[RagdollSystem] Creating ragdoll with ${boneConfig.length} bone configs`);
    active.frame = createRagdollFrame(model);
    const ragdollInstance = new Ragdoll(model.skeleton!, active.frame, boneConfig);
    active.ragdoll = ragdollInstance;

    // Raise Havok’s global max velocity so our launch isn’t clamped
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

    // Activate ragdoll mode — Havok Physics takes over bone transforms
    ragdollInstance.ragdoll();
    active.poseSync = BatchedPoseSync.create(
      model.skeleton!,
      active.frame,
      ragdollInstance,
      boneConfig.map((cfg) => cfg.bone),
    );
    devLog("[RagdollSystem] Ragdoll mode activated");

    for (let b = 0; b < boneConfig.length; b++) {
      try {
        const agg = ragdollInstance.getAggregate(b);
        if (agg?.body) {
          agg.body.setLinearVelocity(velocity);
          agg.body.setGravityFactor(RAGDOLL_GRAVITY_FACTOR);
        }
      } catch {
        /* skip */
      }
    }
    devLog(
      `[RagdollSystem] Applied velocity (${velocity.x.toFixed(0)}, ${velocity.y.toFixed(0)}, ${velocity.z.toFixed(0)}) gravity=${RAGDOLL_GRAVITY_FACTOR} to ${boneConfig.length} bones`,
    );
  }

  /** World position of the hips, or of the sphere while thrown; null once disposed. */
  private bodyPosition(active: ActiveRagdoll): Vector3 | null {
    if (active.disposed) return null;
    if (active.throw) return active.throw.node.getAbsolutePosition();
    try {
      return active.ragdoll?.getAggregate(0)?.body?.transformNode?.getAbsolutePosition() ?? null;
    } catch {
      return null;
    }
  }

  // ========================================================================
  // Per-frame update
  // ========================================================================

  /** Age every ragdoll by `dt` seconds: trails fade, then each fades out and bursts. */
  update(dt: number): void {
    if (!this.scene) return;
    // Bodies land on the map, so its collision is built as soon as it is final
    if (this.physicsReady) PhysicsSystem.getInstance().ensureBspCollision();

    for (let i = this.ragdolls.length - 1; i >= 0; i--) {
      const active = this.ragdolls[i];
      if (active.disposed) {
        this.ragdolls.splice(i, 1);
        continue;
      }

      active.age += Math.max(0, dt);
      const age = active.age;

      if (active.throw) {
        this.advanceThrow(active, dt);
        if (active.disposed) {
          this.ragdolls.splice(i, 1);
          continue;
        }
      } else if (active.trailFollower) {
        const hips = this.bodyPosition(active);
        if (hips) active.trailFollower.position.copyFrom(hips);
      }

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
        active.trailFollower?.dispose();
        active.trailFollower = null;
      }

      // Start the fade once the body has come to rest, or at the latest so it
      // is gone by RAGDOLL_LIFETIME.
      if (active.fadeStart === null) {
        if (this.cameToRest(active, dt)) active.fadeStart = age;
        else if (age >= RAGDOLL_LIFETIME - RAGDOLL_FADE) active.fadeStart = RAGDOLL_LIFETIME - RAGDOLL_FADE;
      }

      if (active.fadeStart !== null) {
        const fade = Math.max(0, 1 - (age - active.fadeStart) / RAGDOLL_FADE);
        active.model.mesh.visibility = fade;
        for (const child of active.model.mesh.getChildMeshes()) {
          child.visibility = fade;
        }
        // Faded: gib-explode and dispose
        if (fade <= 0) {
          this.disposeRagdoll(active, true);
          this.ragdolls.splice(i, 1);
        }
      }
    }
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  /** Whether the hips have stayed within REST_RADIUS for REST_SECONDS, advancing that check by `dt`. */
  private cameToRest(active: ActiveRagdoll, dt: number): boolean {
    // A thrown body is still flying
    if (active.age < REST_MIN_AGE || !active.ragdoll) return false;
    const hips = this.bodyPosition(active);
    if (!hips) return false;
    if (active.restAnchor && Vector3.DistanceSquared(hips, active.restAnchor) <= REST_RADIUS * REST_RADIUS) {
      active.restSeconds += Math.max(0, dt);
    } else {
      active.restAnchor = hips.clone();
      active.restSeconds = 0;
    }
    return active.restSeconds >= REST_SECONDS;
  }

  /** The tint the player model was drawn with (its albedo), unclamped; null when it has none. */
  private modelTint(model: PlayerModelInstance): GibColor | null {
    for (const mesh of [model.mesh, ...model.mesh.getChildMeshes()]) {
      const albedo = (mesh.material as PBRMaterial | null)?.albedoColor;
      if (albedo) return { r: albedo.r, g: albedo.g, b: albedo.b };
    }
    return null;
  }

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

    // Gib explosion at the body's current position
    if (gibExplode && this.onGibExplode) {
      const pos = this.bodyPosition(active) ?? active.model.anchor.getAbsolutePosition();
      this.onGibExplode(pos.x, pos.y, pos.z, 0, 0, 0, active.color);
    }
    active.disposed = true;

    this.releaseBody(active);
    // Dispose model
    this.disposeModel(active.model);
    devLog(`[RagdollSystem] Disposed ragdoll for ${active.model.id}`);
  }

  /** Release everything a dead body holds but the model itself: trail, throw, ragdoll and frame. */
  private releaseBody(active: ActiveRagdoll): void {
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
    active.trailFollower?.dispose();
    active.trailFollower = null;

    if (active.throw) {
      this.releaseThrow(active.throw, false);
      active.throw = null;
    }

    // Dispose ragdoll (cleans up physics bodies + joints)
    active.poseSync?.dispose();
    active.poseSync = null;
    try {
      active.ragdoll?.dispose();
    } catch (e) {
      console.warn("[RagdollSystem] Error disposing ragdoll:", e);
    }

    active.frame?.dispose();
    active.frame = null;
  }

  private disposeModel(model: PlayerModelInstance): void {
    // The body goes back to its player's next life (bones linked again, hand
    // weapon to its pool), or is disposed with everything it owns.
    try {
      releasePlayerModel(model);
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
