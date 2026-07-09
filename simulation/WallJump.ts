/**
 * WallJump — wall jump detection, charging, and execution
 *
 * Manages its own state (charge time, cooldown, normals, etc.).
 * Called by the MovementProfile orchestrator.
 */

import { InputButtons } from "../../../engine/network/components/InputComponent";
import type { Vec3 } from "../../../engine/network/components/TransformComponent";
import type { CollisionWorld } from "../../../engine/network/systems/collision/CollisionWorld";
import type { MovementInput } from "../../../engine/network/systems/movement/MovementProfile";
import type { AdvancedMovementResult, MovementConfig } from "./MovementConfig";
import { VEC3_ZERO, vec3Clone, vec3LengthXZ, vec3MulAdd, vec3Zero } from "./Vec3Helpers";

/** Grace period for detection hysteresis (ms of sim time) */
const DETECTION_GRACE_MS = 100;

/** Bounding box for wall detection traces — small box catches angled BSP faces
 *  that point rays miss. Q3/Warsow used full player hull for wall detection. */
const WALL_TRACE_BOUNDS = {
  min: { x: -4, y: -16, z: -4 },
  max: { x: 4, y: 16, z: 4 },
};

export class WallJump {
  state: "none" | "available" | "charging" = "none";
  normal: Vec3 = vec3Zero();
  position: Vec3 = vec3Zero(); // Position when grab started
  preVelocity: Vec3 = vec3Zero(); // Velocity before charging
  keyReleased: boolean = true;

  // Absolute sim-clock anchors (ms). Derived deadlines instead of accumulated
  // dt so reconciliation replays (which re-simulate old sequence numbers)
  // recompute identical values instead of double-advancing timers.
  private chargeStartMs: number = 0; // Sim time when charging began
  private cooldownUntilMs: number = 0; // Sim time when next walljump is allowed
  private graceUntilMs: number = 0; // Wall-detection hysteresis deadline
  private groundGraceUntilMs: number = 0; // Ground-clearance hysteresis deadline

  // Pre-allocated scratch vectors (avoid per-tick allocations in traces)
  private readonly _scratchTraceEnd: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly _scratchTraceEnd2: Vec3 = { x: 0, y: 0, z: 0 };

  /** True while the post-walljump cooldown deadline is in the future */
  isOnCooldown(nowMs: number): boolean {
    return nowMs < this.cooldownUntilMs;
  }

  /** Reset state for reconciliation */
  reset(): void {
    this.state = "none";
    this.chargeStartMs = 0;
    // NOTE: Do NOT reset keyReleased here. The prediction's keyReleased state
    // is the best approximation of the server's state. Resetting to true causes
    // accidental walljumps from held space; resetting to false causes prediction
    // snaps when the server has true (player genuinely released jump).
    this.graceUntilMs = 0;
    this.groundGraceUntilMs = 0;
  }

  /**
   * Update wall jump detection and state machine.
   * Mutates vel in-place for instant wall jumps.
   */
  update(
    pos: Vec3,
    vel: Vec3,
    input: MovementInput,
    collision: CollisionWorld | null,
    nowMs: number,
    config: MovementConfig,
  ): void {
    if (!collision) return;

    const isJumping = input.isPressed(InputButtons.JUMP);

    // Track key release
    if (!isJumping) {
      this.keyReleased = true;
    }

    // Check cooldown
    if (this.isOnCooldown(nowMs)) {
      this.state = "none";
      return;
    }

    // Check minimum height above ground — use grace deadline to prevent
    // client/server prediction mismatch oscillation (shaking).
    const feetY = pos.y - 24; // Q3: origin is 24 units above feet
    const groundCheck = collision.trace(pos, { x: pos.x, y: feetY - config.wallJumpMinHeight, z: pos.z });
    const hasGroundClearance = !(groundCheck.hit && groundCheck.fraction < 1);

    if (hasGroundClearance) {
      this.groundGraceUntilMs = nowMs + DETECTION_GRACE_MS;
    } else if (nowMs >= this.groundGraceUntilMs) {
      this.state = "none";
      return;
    }

    // Check for wall in multiple directions
    const reach = config.wallJumpReach;

    // Get forward direction from input or velocity
    let forward: Vec3;
    const inputLen = vec3LengthXZ(input.direction);
    if (inputLen > 0.1) {
      forward = { x: input.direction.x / inputLen, y: 0, z: input.direction.z / inputLen };
    } else {
      const velLen = vec3LengthXZ(vel);
      if (velLen > 1) {
        forward = { x: vel.x / velLen, y: 0, z: vel.z / velLen };
      } else {
        const yaw = input.viewAngles.yaw;
        forward = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
      }
    }

    // Check 8 directions for walls (full rose — catches 45° walls reliably)
    const directions = [
      forward, // Forward
      { x: forward.x * 0.924 - forward.z * 0.383, y: 0, z: forward.x * 0.383 + forward.z * 0.924 }, // +22.5°
      { x: forward.x * 0.924 + forward.z * 0.383, y: 0, z: -forward.x * 0.383 + forward.z * 0.924 }, // -22.5°
      { x: forward.x * 0.707 - forward.z * 0.707, y: 0, z: forward.x * 0.707 + forward.z * 0.707 }, // +45°
      { x: forward.x * 0.707 + forward.z * 0.707, y: 0, z: -forward.x * 0.707 + forward.z * 0.707 }, // -45°
      { x: -forward.z, y: 0, z: forward.x }, // +90° (left)
      { x: forward.z, y: 0, z: -forward.x }, // -90° (right)
      { x: -forward.x, y: 0, z: -forward.z }, // Backward
    ];

    let foundWall = false;
    let wallNormal: Vec3 = VEC3_ZERO as Vec3;

    for (const dir of directions) {
      vec3MulAdd(this._scratchTraceEnd, pos, dir, reach);
      const wallCheck = collision.trace(pos, this._scratchTraceEnd, WALL_TRACE_BOUNDS);

      if (wallCheck.hit && wallCheck.normal) {
        // Skip slopes and ramps — only near-vertical surfaces count as walls
        // Q3/Warsow: wall jump only on surfaces where normal.y < 0.3 (~73°+)
        if (Math.abs(wallCheck.normal.y) > 0.3) {
          continue;
        }

        // Check if wall extends to eye level
        const eyeHeight = 32;
        const eyeCheckStart = { x: pos.x, y: pos.y + eyeHeight - 10, z: pos.z };
        vec3MulAdd(this._scratchTraceEnd2, eyeCheckStart, dir, reach);
        const eyeTrace = collision.trace(eyeCheckStart, this._scratchTraceEnd2, WALL_TRACE_BOUNDS);

        if (!eyeTrace.hit) {
          continue; // Low obstacle, skip
        }

        // Verify we're not moving strongly away from the wall
        // Relaxed threshold to support 45° wall approaches (Warsow-style)
        const velDot = vel.x * wallCheck.normal.x + vel.z * wallCheck.normal.z;
        if (velDot > 5) {
          continue; // Moving away from wall
        }

        foundWall = true;
        wallNormal = wallCheck.normal;
        break;
      }
    }

    if (foundWall) {
      this.normal = wallNormal;
      this.state = "available";
      this.graceUntilMs = nowMs + DETECTION_GRACE_MS;

      // Execute wall jump on fresh press
      if (isJumping && this.keyReleased) {
        this.keyReleased = false;

        if (config.wallJumpChargeTime > 0) {
          this.startCharge(pos, vel, wallNormal, nowMs);
        } else {
          this.executeInstant(vel, wallNormal, config, nowMs);
        }
      }
    } else if (nowMs >= this.graceUntilMs) {
      // No wall found and grace deadline passed — clear (prevents flicker)
      this.state = "none";
    }
  }

  /**
   * Handle wall jump charging state - player hangs on wall.
   * Returns the result to use (skipping normal physics).
   */
  handleCharging(
    _position: Vec3,
    input: MovementInput | null,
    nowMs: number,
    deltaTime: number,
    config: MovementConfig,
    slideState: { isSliding: boolean; isCrouching: boolean; crouchViewOffset: number; slidePhase: number },
    ledgeState: { state: "none" | "grabbing" | "pulling"; phase: number },
    actualHorizSpeed: number,
    updateCrouch: (input: MovementInput, deltaTime: number) => void,
  ): AdvancedMovementResult {
    // Charge time derives from the sim clock (replay-idempotent)
    const chargeElapsedMs = nowMs - this.chargeStartMs;

    const isJumping = input?.isPressed(InputButtons.JUMP) ?? false;
    const chargeTimeMs = config.wallJumpChargeTime * 1000;

    // Check for release or timeout
    if (!isJumping || chargeElapsedMs >= chargeTimeMs) {
      this.executeBoost(config, nowMs);

      return {
        position: vec3Clone(this.position),
        velocity: vec3Clone(this.preVelocity),
        grounded: false,
        isSliding: slideState.isSliding,
        isCrouching: slideState.isCrouching,
        wallJumpState: this.state,
        ledgeGrabState: ledgeState.state,
        actualHorizSpeed: actualHorizSpeed,
        crouchViewOffset: slideState.crouchViewOffset,
        slidePhase: slideState.slidePhase,
        ledgeGrabPhase: ledgeState.phase,
      };
    }

    // Still charging - freeze position and velocity
    const frozenPos = vec3Clone(this.position);
    const frozenVel = vec3Zero();

    // Update crouch visuals even while charging
    if (input) {
      updateCrouch(input, deltaTime);
    }

    return {
      position: frozenPos,
      velocity: frozenVel,
      grounded: false,
      isSliding: false,
      isCrouching: slideState.isCrouching,
      wallJumpState: "charging",
      ledgeGrabState: ledgeState.state,
      actualHorizSpeed: 0,
      crouchViewOffset: slideState.crouchViewOffset,
      slidePhase: 0,
      ledgeGrabPhase: ledgeState.phase,
    };
  }

  /** Start charging state - grab the wall */
  private startCharge(pos: Vec3, vel: Vec3, normal: Vec3, nowMs: number): void {
    this.state = "charging";
    this.chargeStartMs = nowMs;
    this.normal = vec3Clone(normal);
    this.position = vec3Clone(pos);
    this.preVelocity = vec3Clone(vel);
  }

  /** Execute wall jump boost after charging (reflection formula) */
  private executeBoost(config: MovementConfig, nowMs: number): void {
    const baseVel = this.preVelocity;
    const normal = this.normal;
    const bounce = config.wallJumpBounce;
    const boost = config.wallJumpBoost;

    // R = V - 2(V.N)N
    const dot = baseVel.x * normal.x + baseVel.z * normal.z;
    const reflectedX = baseVel.x - 2 * dot * normal.x;
    const reflectedZ = baseVel.z - 2 * dot * normal.z;

    baseVel.x = reflectedX * bounce;
    baseVel.z = reflectedZ * bounce;

    const speed = vec3LengthXZ(baseVel);
    if (speed < 100) {
      baseVel.x += normal.x * 200 * boost;
      baseVel.z += normal.z * 200 * boost;
    }

    baseVel.y = config.wallJumpHeight * boost;

    this.cooldownUntilMs = nowMs + config.wallJumpCooldown * 1000;
    this.state = "none";
    this.chargeStartMs = 0;
  }

  /** Instant wall jump (no charging) — reflection formula */
  private executeInstant(vel: Vec3, normal: Vec3, config: MovementConfig, nowMs: number): void {
    const bounce = config.wallJumpBounce;

    const dot = vel.x * normal.x + vel.z * normal.z;
    const reflectedX = vel.x - 2 * dot * normal.x;
    const reflectedZ = vel.z - 2 * dot * normal.z;

    vel.x = reflectedX * bounce;
    vel.z = reflectedZ * bounce;

    const speed = vec3LengthXZ(vel);
    if (speed < 100) {
      vel.x += normal.x * 200;
      vel.z += normal.z * 200;
    }

    vel.y = config.wallJumpHeight;

    this.cooldownUntilMs = nowMs + config.wallJumpCooldown * 1000;
    this.state = "none";
  }
}
