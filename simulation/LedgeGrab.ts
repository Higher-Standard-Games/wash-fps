/**
 * LedgeGrab — ledge detection, grab pause, and pull-up state machine
 *
 * Manages its own state (grab/pull position, phase, etc.).
 * Called by the MovementProfile orchestrator.
 */

import { InputButtons } from "../../../engine/network/components/InputComponent";
import type { Vec3 } from "../../../engine/network/components/TransformComponent";
import type { CollisionWorld } from "../../../engine/network/systems/collision/CollisionWorld";
import type { MovementInput } from "../../../engine/network/systems/movement/MovementProfile";
import { PLAYER_MAXS_Z, PLAYER_MINS_Z, PLAYER_RADIUS } from "../../../engine/physics/PlayerPhysicsConstants";
import type { MovementConfig } from "./MovementConfig";
import { vec3Add, vec3Clone, vec3Normalize, vec3Scale, vec3Zero } from "./Vec3Helpers";

const PLAYER_BOUNDS = {
  min: { x: -PLAYER_RADIUS, y: PLAYER_MINS_Z, z: -PLAYER_RADIUS },
  max: { x: PLAYER_RADIUS, y: PLAYER_MAXS_Z, z: PLAYER_RADIUS },
};
const CLEARANCE = 1;
const RETRY_DELAY_MS = 300;

export class LedgeGrab {
  state: "none" | "grabbing" | "pulling" = "none";
  phase: number = 0; // Camera phase (0-1)

  // Absolute sim-clock anchors (ms) — derived from the sequence-based sim
  // clock so reconciliation replays recompute identical elapsed times
  // instead of double-advancing (same fix as Slide/WallJump).
  private stateStartMs: number = 0; // Sim time when grabbing/pulling began
  private cooldownUntilMs: number = 0; // Re-detection lockout deadline
  private targetPos: Vec3 = vec3Zero();
  private startPos: Vec3 = vec3Zero();

  /** Reset state for reconciliation */
  reset(): void {
    this.state = "none";
    this.phase = 0;
    this.stateStartMs = 0;
    this.cooldownUntilMs = 0;
  }

  /** Check if ledge grab is on cooldown (used by orchestrator to suppress wall jump) */
  isOnCooldown(nowMs: number): boolean {
    return nowMs < this.cooldownUntilMs;
  }

  /**
   * Update ledge grab state machine.
   * Returns true if ledge grab is active (consuming movement).
   * Mutates pos and vel in-place.
   *
   * @param nowMs Absolute sim time (sequence-derived; replay-idempotent)
   */
  update(
    pos: Vec3,
    vel: Vec3,
    input: MovementInput,
    collision: CollisionWorld | null,
    nowMs: number,
    config: MovementConfig,
    isGrounded: boolean,
  ): boolean {
    if (!config.ledgeGrabEnabled) return false;

    // === STATE: GRABBING (pause at ledge) ===
    if (this.state === "grabbing") {
      const grabElapsedSec = (nowMs - this.stateStartMs) / 1000;

      if (!collision || collision.trace(pos, this.startPos, PLAYER_BOUNDS).hit) return this.abort(vel, nowMs);

      // Freeze position
      pos.x = this.startPos.x;
      pos.y = this.startPos.y;
      pos.z = this.startPos.z;
      vel.x = 0;
      vel.y = 0;
      vel.z = 0;

      // Compute ledge grab phase (0→0.3 during grab pause)
      const grabPauseTime = 0.12;
      this.phase = Math.min(0.3, (grabElapsedSec / grabPauseTime) * 0.3);

      // Only allow cancel after minimum grab time (only crouch cancels)
      const minGrabTime = 0.05;
      if (grabElapsedSec > minGrabTime) {
        if (input.isPressed(InputButtons.CROUCH)) {
          return this.abort(vel, nowMs);
        }
      }

      // Auto-climb after brief pause
      if (grabElapsedSec >= grabPauseTime) {
        this.state = "pulling";
        this.stateStartMs = nowMs;
      }

      return true;
    }

    // === STATE: PULLING (climbing animation) ===
    if (this.state === "pulling") {
      const pullElapsedSec = (nowMs - this.stateStartMs) / 1000;
      const pullTime = config.ledgePullTime;
      const progress = Math.min(1.0, pullElapsedSec / pullTime);

      // Ease in-out
      const t = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;

      // Compute ledge grab phase (0.3→1 during pull)
      this.phase = 0.3 + t * 0.7;

      // Lift clear of the lip before moving inward, sweeping both legs.
      // A diagonal interpolation would drive the feet through the wall.
      const rise = this.targetPos.y - this.startPos.y;
      const across = Math.hypot(this.targetPos.x - this.startPos.x, this.targetPos.z - this.startPos.z);
      const travel = t * (rise + across);
      const next =
        travel <= rise
          ? { x: this.startPos.x, y: this.startPos.y + travel, z: this.startPos.z }
          : {
              x:
                this.startPos.x +
                (this.targetPos.x - this.startPos.x) * Math.min(1, (travel - rise) / Math.max(across, 1e-9)),
              y: this.targetPos.y,
              z:
                this.startPos.z +
                (this.targetPos.z - this.startPos.z) * Math.min(1, (travel - rise) / Math.max(across, 1e-9)),
            };
      if (!collision) return this.abort(vel, nowMs);
      if (pos.y < this.targetPos.y && travel > rise) {
        const raised = { x: pos.x, y: this.targetPos.y, z: pos.z };
        if (collision.trace(pos, raised, PLAYER_BOUNDS).hit) return this.abort(vel, nowMs);
        pos.y = raised.y;
      }
      if (collision.trace(pos, next, PLAYER_BOUNDS).hit) return this.abort(vel, nowMs);
      pos.x = next.x;
      pos.y = next.y;
      pos.z = next.z;
      vel.x = 0;
      vel.y = 0;
      vel.z = 0;

      if (progress >= 1.0) {
        // Done climbing — cooldown prevents re-detection
        this.state = "none";
        this.phase = 0;
        this.cooldownUntilMs = nowMs + RETRY_DELAY_MS;
        const forward = vec3Normalize(input.direction);
        vel.x = forward.x * 50;
        vel.y = 0; // No upward boost — targetPos already has Y clearance
        vel.z = forward.z * 50;
      }

      return true;
    }

    // === STATE: DETECTION ===
    if (this.isOnCooldown(nowMs)) return false;
    if (!collision) return false;
    if (isGrounded) return false;
    if (vel.y > 200) return false;

    const reach = config.ledgeReach;
    const climbHeight = config.ledgeHeight;

    // Forward direction from view angles
    const yaw = input.viewAngles.yaw;
    const forwardDir = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };

    // Must be pressing forward OR moving forward with velocity
    const isPressingForward = input.isPressed(InputButtons.FORWARD);
    const velForwardDot = vel.x * forwardDir.x + vel.z * forwardDir.z;
    const hasForwardIntent = isPressingForward || velForwardDot > 50;

    if (!hasForwardIntent) return false;

    // Eye position (physics origin + 24)
    const eyeY = pos.y + 24;

    // === MULTI-DIRECTION WALL PROBE ===
    // Fan out ±30° and ±60° from forward to catch angled ledges (45° walls etc.)
    const cos30 = 0.866,
      sin30 = 0.5;
    const cos60 = 0.5,
      sin60 = 0.866;
    const probeDirections = [
      forwardDir,
      { x: forwardDir.x * cos30 - forwardDir.z * sin30, y: 0, z: forwardDir.x * sin30 + forwardDir.z * cos30 },
      { x: forwardDir.x * cos30 + forwardDir.z * sin30, y: 0, z: -forwardDir.x * sin30 + forwardDir.z * cos30 },
      { x: forwardDir.x * cos60 - forwardDir.z * sin60, y: 0, z: forwardDir.x * sin60 + forwardDir.z * cos60 },
      { x: forwardDir.x * cos60 + forwardDir.z * sin60, y: 0, z: -forwardDir.x * sin60 + forwardDir.z * cos60 },
    ];

    // Try each wall contact independently: a blocked corner must not hide a
    // reachable ledge detected by another probe direction.
    let targetPos: Vec3 | null = null;
    let bestFraction = 1;
    for (const probeDir of probeDirections) {
      const waistStart = { x: pos.x, y: eyeY - 16, z: pos.z };
      const waistEnd = vec3Add(waistStart, vec3Scale(probeDir, reach));
      const wall = collision.trace(waistStart, waistEnd);
      if (!wall.hit || wall.fraction >= bestFraction || !wall.normal) continue;
      const headStart = { x: pos.x, y: eyeY + 8, z: pos.z };
      const head = collision.trace(headStart, vec3Add(headStart, vec3Scale(probeDir, reach)));
      if (head.hit && head.fraction < 0.9) continue;
      const contact = wall.hitPoint ?? {
        x: waistStart.x + (waistEnd.x - waistStart.x) * wall.fraction,
        y: waistStart.y,
        z: waistStart.z + (waistEnd.z - waistStart.z) * wall.fraction,
      };
      const candidate = this.findTarget(pos, contact, wall.normal, collision, eyeY, climbHeight);
      if (candidate) {
        targetPos = candidate;
        bestFraction = wall.fraction;
      }
    }
    if (!targetPos) return false;

    // === SUCCESS: Start grabbing! ===
    this.startGrab(targetPos, pos, nowMs);

    // Immediately freeze position and velocity on detection tick
    // (grab handler freezes on subsequent ticks, but we need frame 0 clean too)
    vel.x = 0;
    vel.y = 0;
    vel.z = 0;

    return true;
  }

  /** Find a supported full-hull destination and an unobstructed lift/across route. */
  private findTarget(
    pos: Vec3,
    contact: Vec3,
    wallNormal: Vec3,
    collision: CollisionWorld,
    eyeY: number,
    climbHeight: number,
  ): Vec3 | null {
    const length = Math.hypot(wallNormal.x, wallNormal.z);
    if (length < 1e-6) return null;
    const nx = wallNormal.x / length,
      nz = wallNormal.z / length;
    // A square hull reaches farther from its center at a diagonal wall.
    const inset = PLAYER_RADIUS * (Math.abs(nx) + Math.abs(nz)) + CLEARANCE;
    const above = { x: contact.x - nx * inset, y: eyeY + climbHeight, z: contact.z - nz * inset };
    const surface = collision.trace(above, { ...above, y: eyeY - 48 });
    if (!surface.hit || !surface.normal || surface.normal.y < 0.7) return null;
    const surfaceY = above.y + (eyeY - 48 - above.y) * surface.fraction;
    if (surfaceY - eyeY < -16 || surfaceY - eyeY > climbHeight) return null;

    // Resolve support with the same standing hull used by movement, rather
    // than assuming the point sample describes every corner under the feet.
    const supportStart = { ...above, y: above.y - PLAYER_MINS_Z + CLEARANCE };
    const supportEnd = { ...above, y: surfaceY - PLAYER_MINS_Z - 2 };
    const support = collision.trace(supportStart, supportEnd, PLAYER_BOUNDS);
    if (!support.hit || !support.normal || support.normal.y < 0.7) return null;
    const target = {
      x: above.x,
      y: supportStart.y + (supportEnd.y - supportStart.y) * support.fraction + CLEARANCE,
      z: above.z,
    };
    const standingSurfaceY = target.y + PLAYER_MINS_Z - CLEARANCE;
    if (standingSurfaceY - eyeY < -16 || standingSurfaceY - eyeY > climbHeight) return null;
    if (collision.trace(target, target, PLAYER_BOUNDS).hit) return null;
    const raised = { x: pos.x, y: target.y, z: pos.z };
    if (collision.trace(pos, raised, PLAYER_BOUNDS).hit) return null;
    if (collision.trace(raised, target, PLAYER_BOUNDS).hit) return null;
    return target;
  }

  private abort(vel: Vec3, nowMs: number): false {
    this.state = "none";
    this.phase = 0;
    this.cooldownUntilMs = nowMs + RETRY_DELAY_MS;
    vel.y = Math.min(vel.y, -100);
    return false;
  }

  /** Start the grab state */
  private startGrab(targetPos: Vec3, currentPos: Vec3, nowMs: number): void {
    this.state = "grabbing";
    this.stateStartMs = nowMs;
    this.startPos = vec3Clone(currentPos);
    this.targetPos = vec3Clone(targetPos);
  }
}
