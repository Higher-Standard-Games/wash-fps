/**
 * Ladders — the climbing movement branch.
 *
 * Stateless functions over a tuning struct, in the same shape as `Swim.ts`:
 * the profile owns state, this owns physics.
 *
 * A ladder is a nonsolid brush volume tagged SURF_LADDER, not a wall you press
 * against. Mappers bolt it flat to the wall so it reaches about a hull radius
 * into the room, and the engine climbs whenever the player's body overlaps it.
 * That is why nothing here takes a surface normal: there is no face being
 * touched, only a volume being occupied, so "away from the ladder" is not a
 * direction this code can know. Detaching is handled by a cooldown instead —
 * see {@link LadderMovementProfile.detachCooldownMs}.
 *
 * Everything here works on FULL 3-D velocity, like swimming and unlike the
 * ground and air families in `Acceleration.ts`: a climber's vertical motion
 * belongs to the player, not to gravity.
 */

import type { Vec3 } from "../../../engine/network/components/TransformComponent";

export interface LadderMovementProfile {
  /**
   * Climb speed in units/sec, up or down.
   *
   * Well under running pace: a ladder is a deliberate, exposed way to change
   * height, and climbing one at run speed makes it a shortcut instead.
   */
  climbSpeed: number;
  /**
   * Acceleration toward the climb wish velocity.
   *
   * Must stay at or above {@link friction}: the two reach equilibrium at
   * `acceleration * climbSpeed / friction`, so a climber under a profile with
   * more drag than push never reaches {@link climbSpeed} at all.
   */
  acceleration: number;
  /**
   * Drag applied while attached, so releasing the keys stops you on the rung.
   *
   * Sets the coast distance directly — roughly `climbSpeed / friction` units —
   * which is the number that decides whether a ladder feels precise or floaty.
   */
  friction: number;
  /**
   * How much of {@link climbSpeed} sideways movement gets.
   *
   * Shuffling along a ladder should be possible but should not be a way to
   * travel, so this is well under 1.
   */
  lateralScale: number;
  /** Upward impulse when jumping off a ladder. */
  detachUp: number;
  /**
   * How long after jumping off a ladder the player cannot reattach, in ms.
   *
   * Without this, a jump that starts inside the volume reattaches on the very
   * next step and the player is welded to the ladder. It has to outlast the
   * time it takes to clear the brush, not just one frame.
   */
  detachCooldownMs: number;
}

export const DEFAULT_LADDER_MOVEMENT: Readonly<LadderMovementProfile> = Object.freeze({
  climbSpeed: 168,
  // 30/20 puts equilibrium at 252, well clear of the 168 cap, while holding
  // the coast to about eight units — an eighth of a body height.
  acceleration: 30,
  friction: 20,
  lateralScale: 0.4,
  detachUp: 270,
  detachCooldownMs: 400,
});

/**
 * Drag on all three axes while attached.
 *
 * Stronger than water, because a climber who lets go of the keys should stop
 * on the ladder rather than drift up it.
 */
export function applyLadderFriction(vel: Vec3, profile: LadderMovementProfile, deltaTime: number): void {
  const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
  if (speed < 1) {
    vel.x = 0;
    vel.y = 0;
    vel.z = 0;
    return;
  }

  const drop = speed * profile.friction * deltaTime;
  const scale = Math.max(0, speed - drop) / speed;

  vel.x *= scale;
  vel.y *= scale;
  vel.z *= scale;
}

export interface LadderIntent {
  /** Unit direction to climb in, or null when the player is asking for nothing. */
  dir: Vec3 | null;
  /** Desired speed along `dir`, already capped. */
  speed: number;
}

/**
 * Turn a command into a climb direction.
 *
 * Forward is the FULL pitched view vector, so looking up and holding forward
 * climbs, and looking down and holding forward descends — the same control a
 * swimmer gets, and the one every Quake-family player reaches for. Jump and
 * crouch also carry an explicit vertical intent, so a player who is looking
 * sideways along a corridor can still go up.
 *
 * Sideways input is deliberately flattened and scaled down: it shuffles you
 * along the rungs without becoming a way to move horizontally at climb speed.
 *
 * The world-space wish is decomposed back into forward/side scalars using the
 * command's own yaw, exactly as `swimIntent` does, so a climber and a runner
 * respond to the same replicated number.
 */
export function ladderIntent(
  worldWish: Vec3,
  viewAngles: { pitch: number; yaw: number },
  verticalIntent: number,
  profile: LadderMovementProfile,
): LadderIntent {
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
    x: (forward.x * forwardMove + right.x * sideMove) * profile.lateralScale,
    y: forward.y * forwardMove + verticalIntent,
    z: (forward.z * forwardMove + right.z * sideMove) * profile.lateralScale,
  };

  const length = Math.sqrt(wish.x * wish.x + wish.y * wish.y + wish.z * wish.z);
  if (length < 0.001) return { dir: null, speed: 0 };

  return {
    dir: { x: wish.x / length, y: wish.y / length, z: wish.z / length },
    // The command's own magnitude scales the request, then the climb cap bounds
    // it. Diagonal input cannot exceed a straight line.
    speed: Math.min(length, 1) * profile.climbSpeed,
  };
}

/** Accelerate toward a wish direction in three dimensions. */
export function ladderAccelerate(
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
 * Climb progress, for driving the hand-over-hand animation.
 *
 * Returned as a signed vertical delta rather than a clip time so the renderer
 * can advance the climb clip by distance travelled. Tying the animation to
 * displacement instead of wall-clock keeps the hands locked to the movement
 * through prediction and reconciliation, where a free-running clip would drift.
 */
export function ladderClimbDelta(previousY: number, currentY: number): number {
  return currentY - previousY;
}
