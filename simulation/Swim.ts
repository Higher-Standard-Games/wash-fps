/**
 * Swimming — the deep-water movement branch and the wading rules above it.
 *
 * Stateless functions over a tuning struct, in the same shape as
 * `Acceleration.ts`: the profile owns state, this owns physics.
 *
 * The values are ours. Quake 3 and Warsow agree on the model and differ in
 * three numbers, and reproducing both would buy a per-profile test matrix
 * across every special move for a distinction no map depends on. These are
 * seeded from the Q3 column — the one verifiable from published source — and
 * are meant to be tuned by feel.
 *
 * Everything here works on FULL 3-D velocity. The ground and air families in
 * `Acceleration.ts` operate on XZ only, because a runner's vertical motion
 * belongs to gravity; a swimmer's belongs to the player.
 */

import type { Vec3 } from "../../../engine/network/components/TransformComponent";
import type { WaterLevel } from "../liquid/LiquidTypes";

export interface LiquidMovementProfile {
  /** Swim speed as a fraction of base speed. */
  swimScale: number;
  /** Acceleration toward the wish velocity while swimming. */
  waterAcceleration: number;
  /** Friction coefficient, scaled by water level. */
  waterFriction: number;
  /** Lowest water level at which friction applies. 1 means wading drags too. */
  frictionStartsAtLevel: 1 | 2;
  /** Downward speed a swimmer settles to with no input, in units/sec. */
  idleSinkSpeed: number;
  /** Forward impulse of an assisted climb out of water. */
  waterJumpForward: number;
  /** Upward impulse of an assisted climb out of water. */
  waterJumpUp: number;
  /** How long the assisted climb keeps control away from the player, in ms. */
  waterJumpDurationMs: number;
}

export const DEFAULT_LIQUID_MOVEMENT: Readonly<LiquidMovementProfile> = Object.freeze({
  swimScale: 0.5,
  waterAcceleration: 4,
  waterFriction: 1,
  frictionStartsAtLevel: 1,
  idleSinkSpeed: 60,
  waterJumpForward: 200,
  waterJumpUp: 350,
  waterJumpDurationMs: 2000,
});

/**
 * Drag, applied to all three axes and scaled by how submerged the player is.
 *
 * Ankle-deep drags a third as hard as fully submerged, which is what makes
 * wading through shallows feel different from running through them.
 */
export function applyWaterFriction(
  vel: Vec3,
  level: WaterLevel,
  profile: LiquidMovementProfile,
  stopSpeed: number,
  deltaTime: number,
): void {
  if (level < profile.frictionStartsAtLevel) return;

  const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
  if (speed < 1) {
    vel.x = 0;
    vel.y = 0;
    vel.z = 0;
    return;
  }

  const control = speed < stopSpeed ? stopSpeed : speed;
  const drop = control * profile.waterFriction * level * deltaTime;
  const newSpeed = Math.max(0, speed - drop);
  const scale = newSpeed / speed;

  vel.x *= scale;
  vel.y *= scale;
  vel.z *= scale;
}

/** Accelerate toward a wish direction in three dimensions. */
export function waterAccelerate(
  vel: Vec3,
  wishDir: Vec3,
  wishSpeed: number,
  acceleration: number,
  deltaTime: number,
): void {
  const currentSpeed = vel.x * wishDir.x + vel.y * wishDir.y + vel.z * wishDir.z;
  const addSpeed = wishSpeed - currentSpeed;
  if (addSpeed <= 0) return;

  let accelSpeed = acceleration * deltaTime * wishSpeed;
  if (accelSpeed > addSpeed) accelSpeed = addSpeed;

  vel.x += wishDir.x * accelSpeed;
  vel.y += wishDir.y * accelSpeed;
  vel.z += wishDir.z * accelSpeed;
}

/**
 * How much of the base speed a wading player keeps.
 *
 * Interpolates from full speed toward the swim cap by depth, so walking into
 * a pool slows you continuously instead of at a threshold.
 */
export function wadeSpeedScale(level: WaterLevel, profile: LiquidMovementProfile): number {
  if (level === 0) return 1;
  return 1 - (1 - profile.swimScale) * (level / 3);
}

export interface SwimIntent {
  /** Unit direction to swim in, or null when the player is asking for nothing. */
  dir: Vec3 | null;
  /** Desired speed along `dir`, already capped. */
  speed: number;
}

/**
 * Turn a command into a swim direction.
 *
 * Two things distinguish this from ground movement. Forward is the FULL pitched
 * view vector, so looking up and holding forward swims upward — the control
 * every Quake-family swimmer expects. And jump/crouch add an explicit vertical
 * intent that does not depend on where the player is looking, so surfacing
 * never requires aiming at the ceiling.
 *
 * The world-space wish direction is decomposed back into forward/side scalars
 * using the command's own yaw, rather than re-deriving them from button bits.
 * Both are replicated, but `direction` is the one the ground branch already
 * trusts, and using it keeps a swimmer and a runner responding to the same
 * number.
 */
export function swimIntent(
  worldWish: Vec3,
  viewAngles: { pitch: number; yaw: number },
  verticalIntent: number,
  maxSpeed: number,
  profile: LiquidMovementProfile,
): SwimIntent {
  const { pitch, yaw } = viewAngles;

  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);

  // Decompose the (already yaw-rotated, flattened) wish into local axes.
  const forwardMove = worldWish.x * sinYaw + worldWish.z * cosYaw;
  const sideMove = worldWish.x * cosYaw - worldWish.z * sinYaw;

  const cosPitch = Math.cos(pitch);
  const forward: Vec3 = { x: sinYaw * cosPitch, y: -Math.sin(pitch), z: cosYaw * cosPitch };
  const right: Vec3 = { x: cosYaw, y: 0, z: -sinYaw };

  const wish: Vec3 = {
    x: forward.x * forwardMove + right.x * sideMove,
    y: forward.y * forwardMove + verticalIntent,
    z: forward.z * forwardMove + right.z * sideMove,
  };

  const length = Math.sqrt(wish.x * wish.x + wish.y * wish.y + wish.z * wish.z);
  if (length < 0.001) return { dir: null, speed: 0 };

  return {
    dir: { x: wish.x / length, y: wish.y / length, z: wish.z / length },
    // The command's own magnitude scales the request, then the swim cap bounds
    // it. Diagonal input cannot exceed a straight line.
    speed: Math.min(length, 1) * maxSpeed * profile.swimScale,
  };
}

/** With no input at all, a swimmer sinks rather than hovering. */
export function idleSinkVelocity(profile: LiquidMovementProfile): Vec3 {
  return { x: 0, y: -profile.idleSinkSpeed, z: 0 };
}

/**
 * Q3's assisted climb out of water.
 *
 * Old maps routinely have pool lips a swimmer cannot clear, so treading at the
 * edge with forward held launches you over it. Probing requires a solid surface
 * ahead at chest height and clear air above it — the shape of a ledge, rather
 * than of a wall.
 *
 * Only at level 2. A fully submerged player is not at the edge of anything, and
 * a wading one can just walk.
 */
export function checkWaterJump(
  origin: Vec3,
  viewAngles: { pitch: number; yaw: number },
  level: WaterLevel,
  isSolidAt: (point: Vec3) => boolean,
): boolean {
  if (level !== 2) return false;

  // Flattened forward: this is about the ledge in front of you, not where you
  // happen to be looking vertically.
  const flatForward = { x: Math.sin(viewAngles.yaw), z: Math.cos(viewAngles.yaw) };

  const ahead: Vec3 = {
    x: origin.x + flatForward.x * 30,
    y: origin.y + 4,
    z: origin.z + flatForward.z * 30,
  };
  if (!isSolidAt(ahead)) return false;

  const above: Vec3 = { x: ahead.x, y: ahead.y + 16, z: ahead.z };
  return !isSolidAt(above);
}
