/**
 * DeathCamera - smoothed corpse/gib follow death view.
 *
 * On local death the game hands this a live getter for the ragdoll hips or gib
 * burst centroid. Each frame we ease the camera to a readable chase position,
 * with guard rails so bad ragdoll physics cannot drag the view under the map.
 *
 * Corpses and fixed points only. Watching a LIVING player is
 * {@link SpectateEyeCamera}'s job: a third-person chase of someone who walks
 * around holds a fixed bearing while they move, so they run at the lens, and
 * the wall clamp below jams the camera into their back in any corridor.
 */

import { Ray } from "@babylonjs/core/Culling/ray";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";

/** Live world position of the follow target, or null once gone. */
export type FollowPositionFn = () => Vector3 | null;

/** Minimal camera surface we drive; structurally satisfied by Babylon cameras. */
export interface DeathCameraTarget {
  position: Vector3;
  setTarget(target: Vector3): void;
  getScene?(): Scene;
}

/** Distance the camera sits behind the corpse/gib burst. */
const BACK_DISTANCE = 150;
/** Height the camera floats above the target. */
const HEIGHT_ABOVE = 110;
/** How far above the target to aim. */
const LOOK_HEIGHT = 25;
/** Position ease rate. */
const POS_SMOOTH = 3.2;
/** Look-at ease rate. */
const LOOK_SMOOTH = 5.0;
/** Follow targets below this relative to death origin are considered escaped. */
const MAX_TARGET_DROP_BELOW_DEATH = 72;
/** Follow targets farther than this from death origin are considered escaped. */
const MAX_TARGET_DISTANCE_FROM_DEATH = 900;
/** Never let the camera itself drop below this offset from the death origin. */
const MIN_CAMERA_HEIGHT_ABOVE_DEATH = 18;
/** Never aim below this offset from the death origin. */
const MIN_LOOK_HEIGHT_ABOVE_DEATH = 8;
/** Pull camera this far in front of hit map geometry. */
const CAMERA_WALL_PADDING = 18;
/** Keep at least this much distance from corpse to camera after wall clamps. */
const MIN_CAMERA_TARGET_DISTANCE = 36;

export class DeathCamera {
  private active = false;
  private getFollowPos: FollowPositionFn | null = null;
  private yaw = 0;
  private readonly deathPos = new Vector3();
  private readonly camPos = new Vector3();
  private readonly lookPos = new Vector3();
  private readonly lastTarget = new Vector3();

  get isActive(): boolean {
    return this.active;
  }

  start(getFollowPos: FollowPositionFn, deathPos: Vector3, yaw: number): void {
    this.active = true;
    this.getFollowPos = getFollowPos;
    this.yaw = yaw;
    this.deathPos.copyFrom(deathPos);
    this.lastTarget.copyFrom(deathPos);

    const back = this.backVector();
    this.camPos.copyFrom(deathPos).addInPlace(back.scaleInPlace(BACK_DISTANCE));
    this.camPos.y = Math.max(this.camPos.y + HEIGHT_ABOVE, this.minCameraY());
    this.lookPos.copyFrom(deathPos);
    this.lookPos.y = Math.max(this.lookPos.y + LOOK_HEIGHT, this.minLookY());
  }

  stop(): void {
    this.active = false;
    this.getFollowPos = null;
  }

  /**
   * Drive the camera toward the target. Returns true if it took over the camera
   * so the caller can skip its own death effects.
   */
  update(dt: number, camera: DeathCameraTarget): boolean {
    if (!this.active) return false;

    const target = this.sanitizeTarget(this.getFollowPos?.() ?? null);
    this.lastTarget.copyFrom(target);

    const desiredLook = new Vector3(target.x, Math.max(target.y + LOOK_HEIGHT, this.minLookY()), target.z);
    const desired = target.add(this.backVector().scaleInPlace(BACK_DISTANCE));
    desired.y = Math.max(desired.y + HEIGHT_ABOVE, this.minCameraY());
    const safeDesired = this.clampCameraToWorld(camera, desiredLook, desired);
    safeDesired.y = Math.max(safeDesired.y, this.minCameraY());

    const kp = 1 - Math.exp(-POS_SMOOTH * dt);
    const kl = 1 - Math.exp(-LOOK_SMOOTH * dt);
    Vector3.LerpToRef(this.camPos, safeDesired, kp, this.camPos);
    Vector3.LerpToRef(this.lookPos, desiredLook, kl, this.lookPos);

    camera.position.copyFrom(this.camPos);
    camera.setTarget(this.lookPos);
    return true;
  }

  private sanitizeTarget(target: Vector3 | null): Vector3 {
    if (!target || !this.isFiniteVector(target)) return this.lastTarget;
    if (target.y < this.deathPos.y - MAX_TARGET_DROP_BELOW_DEATH) return this.lastTarget;
    if (
      Vector3.DistanceSquared(target, this.deathPos) >
      MAX_TARGET_DISTANCE_FROM_DEATH * MAX_TARGET_DISTANCE_FROM_DEATH
    ) {
      return this.lastTarget;
    }
    return target;
  }

  private clampCameraToWorld(camera: DeathCameraTarget, lookTarget: Vector3, desired: Vector3): Vector3 {
    const scene = camera.getScene?.();
    if (!scene) return desired;

    const offset = desired.subtract(lookTarget);
    const distance = offset.length();
    if (distance <= MIN_CAMERA_TARGET_DISTANCE) return desired;

    const dir = offset.scale(1 / distance);
    const hit = scene.pickWithRay(new Ray(lookTarget, dir, distance), (mesh) => this.isMapMesh(mesh));
    if (!hit?.hit || !hit.pickedPoint) return desired;

    const hitDistance = Vector3.Distance(lookTarget, hit.pickedPoint);
    const clampedDistance = Math.max(MIN_CAMERA_TARGET_DISTANCE, hitDistance - CAMERA_WALL_PADDING);
    if (clampedDistance >= distance) return desired;
    return lookTarget.add(dir.scale(clampedDistance));
  }

  private isMapMesh(mesh: AbstractMesh): boolean {
    if (mesh.isPickable === false) return false;
    const metadata = mesh.metadata as { mapOwned?: boolean } | null;
    return (
      metadata?.mapOwned === true || mesh.name.startsWith("bsp_") || mesh.name === "brush" || mesh.name === "patch"
    );
  }

  private isFiniteVector(v: Vector3): boolean {
    return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
  }

  private minCameraY(): number {
    return this.deathPos.y + MIN_CAMERA_HEIGHT_ABOVE_DEATH;
  }

  private minLookY(): number {
    return this.deathPos.y + MIN_LOOK_HEIGHT_ABOVE_DEATH;
  }

  /** Unit vector behind the player for their death yaw. */
  private backVector(): Vector3 {
    return new Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }
}
