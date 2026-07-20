/**
 * Acceleration — stateless ground/air physics functions
 *
 * Q3/Warsow-style friction, ground acceleration, and air acceleration.
 * All functions mutate `vel` in-place (no allocations).
 */

import type { Vec3 } from "../../../engine/network/components/TransformComponent";
import type { MovementConfig } from "./MovementConfig";
import { vec3DotXZ } from "./Vec3Helpers";

// ================== Friction ==================

export function applyFriction(vel: Vec3, friction: number, stopSpeed: number, deltaTime: number): void {
  const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);

  if (speed < 1) {
    vel.x = 0;
    vel.z = 0;
    return;
  }

  const control = speed < stopSpeed ? stopSpeed : speed;
  const drop = control * friction * deltaTime;
  let newSpeed = speed - drop;

  if (newSpeed < 0) newSpeed = 0;

  const scale = newSpeed / speed;
  vel.x *= scale;
  vel.z *= scale;
}

// ================== Ground Acceleration ==================

export function groundAccelerate(
  vel: Vec3,
  wishDir: Vec3,
  wishSpeed: number,
  groundAccel: number,
  deltaTime: number,
): void {
  const currentSpeed = vec3DotXZ(vel, wishDir);
  const addSpeed = wishSpeed - currentSpeed;

  if (addSpeed <= 0) return;

  let accelSpeed = groundAccel * deltaTime * wishSpeed;
  if (accelSpeed > addSpeed) accelSpeed = addSpeed;

  vel.x += wishDir.x * accelSpeed;
  vel.z += wishDir.z * accelSpeed;
}

// ================== Air Acceleration ==================

/**
 * Calculate acceleration falloff at high speeds.
 * Shared by all air acceleration modes.
 */
export function calcAccelFalloff(curSpeed: number, runSpeed: number, radicalSpeed: number, topSpeed: number): number {
  if (curSpeed <= runSpeed) return 1.0;
  if (curSpeed < radicalSpeed) {
    const ratio = (curSpeed - runSpeed) / (radicalSpeed - runSpeed);
    return 1 - ratio * 0.5;
  }
  const ratio = (curSpeed - radicalSpeed) / (topSpeed - radicalSpeed);
  return Math.max(0, 0.5 * (1 - ratio * ratio * ratio));
}

/**
 * Mode 1: Air Accelerate Forward (W only, accelerating - Warsow style)
 * Complex forward acceleration with bunny hop mechanics
 */
export function airAccelerateForward(
  vel: Vec3,
  wishDir: Vec3,
  wishSpeed: number,
  config: MovementConfig,
  deltaTime: number,
): void {
  const maxPlayerSpeed = config.maxSpeed;
  const topspeed = config.topSpeed;
  const runSpeed = config.runSpeed;
  const radicalSpeed = 600;

  const airforwardaccel = 1.00001;
  const bunnyaccel = 0.1593;
  const turnaccel = 4.0;
  const backtosideratio = 0.8;

  const curvelX = vel.x;
  const curvelZ = vel.z;
  const curspeed = Math.sqrt(curvelX * curvelX + curvelZ * curvelZ);

  const accelFalloff = calcAccelFalloff(curspeed, runSpeed, radicalSpeed, topspeed);

  let targetWishspeed: number;
  if (wishSpeed > curspeed * 1.01) {
    const accelspeed = curspeed + airforwardaccel * maxPlayerSpeed * deltaTime * accelFalloff;
    targetWishspeed = Math.min(wishSpeed, accelspeed);
  } else {
    const f = Math.max(0, (topspeed - curspeed) / (topspeed - maxPlayerSpeed));
    targetWishspeed = Math.max(curspeed, maxPlayerSpeed) + bunnyaccel * f * accelFalloff * maxPlayerSpeed * deltaTime;
  }

  const wishvelX = wishDir.x * targetWishspeed;
  const wishvelZ = wishDir.z * targetWishspeed;
  let accelDirX = wishvelX - curvelX;
  let accelDirZ = wishvelZ - curvelZ;

  const accelDirLen = Math.sqrt(accelDirX * accelDirX + accelDirZ * accelDirZ);
  if (accelDirLen < 0.001) return;

  accelDirX /= accelDirLen;
  accelDirZ /= accelDirLen;
  const addspeed = accelDirLen;

  let accelspeed = turnaccel * maxPlayerSpeed * deltaTime;
  if (accelspeed > addspeed) accelspeed = addspeed;

  if (backtosideratio < 1.0 && curspeed > 0.001) {
    const curDirX = curvelX / curspeed;
    const curDirZ = curvelZ / curspeed;
    const dot = accelDirX * curDirX + accelDirZ * curDirZ;
    if (dot < 0) {
      accelDirX -= (1.0 - backtosideratio) * dot * curDirX;
      accelDirZ -= (1.0 - backtosideratio) * dot * curDirZ;
    }
  }

  vel.x += accelspeed * accelDirX;
  vel.z += accelspeed * accelDirZ;
}

export const STRAFE_BUNNY_ACCEL = 50;

/**
 * Mode 2: Strafe Bunny Accelerate (A/D only - CPMA/Q2 strafe jumping)
 * The core strafe jumping mechanic
 */
export function strafeBunnyAccelerate(
  vel: Vec3,
  wishDir: Vec3,
  wishSpeed: number,
  config: MovementConfig,
  deltaTime: number,
): void {
  const baseStrafeBunnyAccel = STRAFE_BUNNY_ACCEL;
  const strafeWishspeed = Math.min(wishSpeed, config.maxAirSpeed);
  const curSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  const runSpeed = config.runSpeed;
  const radicalSpeed = 600;
  const topspeed = config.topSpeed;

  const accelFalloff = calcAccelFalloff(curSpeed, runSpeed, radicalSpeed, topspeed);

  const strafeBunnyAccel = baseStrafeBunnyAccel * accelFalloff;
  const currentspeed = vel.x * wishDir.x + vel.z * wishDir.z;
  const addspeed = strafeWishspeed - currentspeed;

  if (addspeed > 0 && accelFalloff > 0.01) {
    let accelspeed = strafeBunnyAccel * deltaTime * strafeWishspeed;
    if (accelspeed > addspeed) accelspeed = addspeed;
    vel.x += accelspeed * wishDir.x;
    vel.z += accelspeed * wishDir.z;
  }
}

/**
 * Mode 3: Normal Air Accelerate (Default - Q3 style)
 * Basic air control with falloff
 */
export function normalAirAccelerate(
  vel: Vec3,
  wishDir: Vec3,
  wishSpeed: number,
  config: MovementConfig,
  deltaTime: number,
): void {
  const curSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  const runSpeed = config.runSpeed;
  const radicalSpeed = 600;
  const topspeed = config.topSpeed;
  const airaccelerate = config.airAcceleration;

  const accelFalloff = calcAccelFalloff(curSpeed, runSpeed, radicalSpeed, topspeed);

  const currentspeed = vel.x * wishDir.x + vel.z * wishDir.z;
  const addspeed = wishSpeed - currentspeed;

  if (addspeed > 0 && accelFalloff > 0.01) {
    let accelspeed = airaccelerate * deltaTime * wishSpeed * accelFalloff;
    if (accelspeed > addspeed) accelspeed = addspeed;
    vel.x += accelspeed * wishDir.x;
    vel.z += accelspeed * wishDir.z;
  }
}
