/**
 * FPSMovementProfile - Advanced Quake 3 / Warsow style movement
 *
 * Full featured movement profile including:
 * - Ground movement with friction and acceleration
 * - Air acceleration (strafejumping/bunnyhop)
 * - Wall jump with charging
 * - Ledge grabbing
 * - Crouchslide
 *
 * This is a pure-math implementation for server-side simulation,
 * ported from AdvancedCharacterController.
 */

import type { Vec3 } from '../../../engine/network/components/TransformComponent';
import type { CollisionWorld, TraceResult } from '../../../engine/network/systems/collision/CollisionWorld';
import type { MovementProfile, MovementInput, MovementResult } from '../../../engine/network/systems/movement/MovementProfile';
import { InputButtons } from '../../../engine/network/components/InputComponent';

// ================== Vec3 Math Helpers ==================

function vec3Zero(): Vec3 {
  return { x: 0, y: 0, z: 0 };
}

function vec3Clone(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vec3Scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function vec3Length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function vec3LengthXZ(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.z * v.z);
}

function vec3Normalize(v: Vec3): Vec3 {
  const len = vec3Length(v);
  if (len < 0.0001) return vec3Zero();
  return vec3Scale(v, 1 / len);
}

function vec3Dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function vec3DotXZ(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.z * b.z;
}

// ================== Configuration ==================

export interface FPSMovementConfig {
  // Core movement
  maxSpeed: number;
  runSpeed: number;
  groundAcceleration: number;
  airAcceleration: number;
  maxAirSpeed: number;
  friction: number;
  stopSpeed: number;
  gravity: number;
  jumpVelocity: number;
  crouchMultiplier: number;
  stepHeight: number;

  // Top speed limiter
  topSpeed: number;

  // Air control (Warsow style)
  airControl: number;
  airControlPower: number;

  // Wall jump
  wallJumpEnabled: boolean;
  wallJumpHeight: number;
  wallJumpBounce: number;
  wallJumpReach: number;
  wallJumpCooldown: number;
  wallJumpMinHeight: number;
  wallJumpChargeTime: number;
  wallJumpBoost: number;

  // Ledge grab
  ledgeGrabEnabled: boolean;
  ledgeReach: number;
  ledgeHeight: number;
  ledgeMinFall: number;
  ledgeTimeout: number;
  ledgePullTime: number;

  // Crouchslide
  slideEnabled: boolean;
  slideDuration: number;
  slideSpeedMultiplier: number;
  slideDecay: number;
  slideJumpBoost: number;
  slideMinSpeed: number;
  slideFriction: number;
  slideCooldown: number;
}

// ================== Extended Result with Advanced State ==================

export interface AdvancedMovementResult extends MovementResult {
  isSliding: boolean;
  isCrouching: boolean;
  wallJumpState: 'none' | 'available' | 'charging';
  ledgeGrabState: 'none' | 'grabbing' | 'pulling';
  actualHorizSpeed: number;
  crouchViewOffset: number;
}

// ================== Movement Profile Class ==================

export class FPSMovementProfile implements MovementProfile {
  private config: FPSMovementConfig;

  // Player bounds for collision traces (matches local AdvancedCharacterController)
  // Uses Q3-style asymmetric box: origin at waist, -24 to feet, +32 to head
  private static readonly PLAYER_RADIUS = 16;
  private static readonly PLAYER_HEIGHT = 56;
  private static readonly PLAYER_BOUNDS = {
    min: { x: -16, y: -24, z: -16 },  // Bottom/back/left from origin
    max: { x: 16, y: 32, z: 16 }       // Top/front/right from origin
  };

  // Persistent state (carried between frames)
  private isGrounded: boolean = false;
  private wasGroundedLastFrame: boolean = false;
  private jumpConsumed: boolean = false;

  // Crouch/Slide state
  private isCrouching: boolean = false;
  private isSliding: boolean = false;
  private slideStartTime: number = 0;
  private lastSlideEndTime: number = 0;
  private slideVelocity: Vec3 = vec3Zero();
  private crouchViewOffset: number = 0;

  // Wall jump state
  private wallJumpState: 'none' | 'available' | 'charging' = 'none';
  private wallJumpChargeTime: number = 0;
  private wallJumpNormal: Vec3 = vec3Zero();
  private wallJumpPosition: Vec3 = vec3Zero();  // Position when grab started
  private wallJumpPreVelocity: Vec3 = vec3Zero();  // Velocity before charging
  private lastWallJumpTime: number = 0;
  private wallJumpKeyReleased: boolean = true;
  private wallJumpGraceTime: number = 0;  // Grace timer to prevent flicker

  // Ledge grab state
  private ledgeGrabState: 'none' | 'grabbing' | 'pulling' = 'none';
  private ledgeGrabTime: number = 0;
  private ledgeTargetPos: Vec3 = vec3Zero();
  private ledgeStartPos: Vec3 = vec3Zero();
  private ledgeWallNormal: Vec3 = vec3Zero();  // Wall direction for cancel detection
  private ledgeGrabGraceTime: number = 0;  // Grace timer to prevent flicker

  // Detection hysteresis constants
  private static readonly DETECTION_GRACE = 0.1;  // 100ms grace period

  // Speed tracking
  private lastPosX: number = 0;
  private lastPosZ: number = 0;
  private actualHorizSpeed: number = 0;
  private smoothedY: number = 0;

  // Constants
  private static readonly CROUCH_HEIGHT_OFFSET = -24;
  private static readonly CROUCH_TRANSITION_SPEED = 0.2;

  constructor(config?: Partial<FPSMovementConfig>) {
    this.config = {
      // Core movement (defaults from MovementVars)
      maxSpeed: 280,
      runSpeed: 350,
      groundAcceleration: 10,
      airAcceleration: 1,
      maxAirSpeed: 30,
      friction: 6,
      stopSpeed: 100,
      gravity: 1000,
      jumpVelocity: 320,
      crouchMultiplier: 0.5,
      stepHeight: 18,
      topSpeed: 1000,
      airControl: 150,
      airControlPower: 50,

      // Wall jump
      wallJumpEnabled: true,
      wallJumpHeight: 280,
      wallJumpBounce: 0.8,
      wallJumpReach: 20,
      wallJumpCooldown: 1.0,
      wallJumpMinHeight: 32,
      wallJumpChargeTime: 0.2,
      wallJumpBoost: 1.2,

      // Ledge grab
      ledgeGrabEnabled: true,
      ledgeReach: 32,
      ledgeHeight: 64,
      ledgeMinFall: -50,
      ledgeTimeout: 2.0,
      ledgePullTime: 0.35,

      // Crouchslide
      slideEnabled: true,
      slideDuration: 800,
      slideSpeedMultiplier: 1.2,
      slideDecay: 0.5,
      slideJumpBoost: 1.3,
      slideMinSpeed: 375,
      slideFriction: 0.1,
      slideCooldown: 1500,

      ...config,
    };
  }

  getName(): string {
    return 'AdvancedFPSMovement';
  }

  getDefaults() {
    return {
      maxSpeed: this.config.maxSpeed,
      acceleration: this.config.groundAcceleration,
      friction: this.config.friction,
      gravity: this.config.gravity,
      jumpVelocity: this.config.jumpVelocity,
    };
  }

  /**
   * Reset physics state (for reconciliation)
   * Call this when resetting to server-authoritative state to ensure
   * grounded detection matches the server's state.
   */
  resetPhysicsState(grounded: boolean): void {
    this.isGrounded = grounded;
    this.wasGroundedLastFrame = grounded;
    // Reset jump tracking to match grounded state
    if (grounded) {
      this.jumpConsumed = false;
    }
  }

  /**
   * Main simulation entry point
   */
  simulate(
    position: Vec3,
    velocity: Vec3,
    input: MovementInput | null,
    deltaTime: number,
    collision: CollisionWorld | null
  ): AdvancedMovementResult {
    const newPos = vec3Clone(position);
    const newVel = vec3Clone(velocity);
    const now = Date.now();

    // NOTE: Do NOT set wasGroundedLastFrame here!
    // It's set AFTER stepSlideMove, BEFORE updating isGrounded (like local checkGrounded does).
    // justLanded uses values from PREVIOUS frame's end state.
    const justLanded = !this.wasGroundedLastFrame && this.isGrounded;

    // === WALL JUMP CHARGING STATE ===
    // If charging, we freeze physics - player hangs on wall
    if (this.wallJumpState === 'charging') {
      return this.handleWallJumpCharging(position, input, deltaTime, now);
    }

    // === LEDGE GRAB ===
    // Check BEFORE gravity to freeze physics when grabbing
    if (this.config.ledgeGrabEnabled && input) {
      if (this.updateLedgeGrab(newPos, newVel, input, collision, deltaTime)) {
        // Ledge grab is active - return frozen state
        return {
          position: newPos,
          velocity: newVel,
          grounded: false,
          isSliding: false,
          isCrouching: this.isCrouching,
          wallJumpState: 'none',
          ledgeGrabState: this.ledgeGrabState,
          actualHorizSpeed: 0,
          crouchViewOffset: this.crouchViewOffset,
        };
      }
    }

    // === GRAVITY ===
    if (!this.isGrounded) {
      newVel.y -= this.config.gravity * deltaTime;
    } else if (newVel.y < 0) {
      newVel.y = 0;
    }

    // === INPUT PROCESSING ===
    if (input) {
      // Determine wishspeed
      const isSprinting = input.isPressed(InputButtons.SPRINT);
      const isCrouching = input.isPressed(InputButtons.CROUCH);
      const isJumping = input.isPressed(InputButtons.JUMP);

      let wishspeed = isSprinting ? this.config.runSpeed : this.config.maxSpeed;

      // Crouch speed reduction (if not sliding)
      if (isCrouching && !this.isSliding) {
        const horizSpeed = vec3LengthXZ(newVel);
        const cooldownPassed = (now - this.lastSlideEndTime) >= this.config.slideCooldown;

        if (horizSpeed < this.config.slideMinSpeed || !cooldownPassed) {
          wishspeed *= this.config.crouchMultiplier;
        }
      }

      // === JUMP ===
      if (!isJumping) {
        this.jumpConsumed = false;
      }

      const autohop = true; // Could be config
      const willAutohop = autohop && justLanded && isJumping;
      const canJump = !this.jumpConsumed || (autohop && justLanded);

      if (isJumping && this.isGrounded && canJump) {
        newVel.y = this.config.jumpVelocity;
        this.jumpConsumed = true;
        this.isGrounded = false;

        // Exit slide on jump
        if (this.isSliding) {
          this.exitSlide(newVel, now);
        }
      }

      // === MOVEMENT DIRECTION ===
      const wishDir = input.direction;
      const wishLen = vec3LengthXZ(wishDir);
      const hasInput = wishLen > 0.001;

      const normalizedWish = hasInput
        ? { x: wishDir.x / wishLen, y: 0, z: wishDir.z / wishLen }
        : vec3Zero();

      if (this.isGrounded) {
        // === GROUND MOVEMENT ===
        const friction = this.isSliding ? this.config.slideFriction : this.config.friction;
        this.applyFriction(newVel, friction, deltaTime);

        if (hasInput) {
          this.groundAccelerate(newVel, normalizedWish, wishspeed, deltaTime);
        }
      } else {
        // === AIR MOVEMENT ===
        // Detect button states for mode selection (matching local AdvancedCharacterController)
        const holdingForward = input.isPressed(InputButtons.FORWARD) || input.isPressed(InputButtons.BACK);
        const holdingStrafe = input.isPressed(InputButtons.LEFT) || input.isPressed(InputButtons.RIGHT);

        // Calculate velocity dot wish for acceleration detection
        const velocityDotWish = newVel.x * normalizedWish.x + newVel.z * normalizedWish.z;
        const isAccelerating = velocityDotWish > 0;

        if (hasInput) {
          if (holdingForward && !holdingStrafe && isAccelerating) {
            // Mode 1: Air Accelerate (W only, accelerating forward - Warsow style)
            this.airAccelerateForward(newVel, normalizedWish, wishspeed, deltaTime);
          } else if (holdingStrafe && !holdingForward) {
            // Mode 2: Strafe Bunny (A/D only - CPMA/Q2 strafe jumping)
            this.strafeBunnyAccelerate(newVel, normalizedWish, wishspeed, deltaTime);
          } else {
            // Mode 3: Normal Air Control (default)
            this.normalAirAccelerate(newVel, normalizedWish, wishspeed, deltaTime);
          }
        }

        // === WALL JUMP (in air) ===
        if (this.config.wallJumpEnabled && !this.isSliding) {
          this.updateWallJump(newPos, newVel, input, collision, deltaTime, now);
        }
      }

      // === CROUCHSLIDE ===
      if (this.config.slideEnabled) {
        this.updateSlide(newVel, input, deltaTime, now);
      }

      // === CROUCH STATE ===
      this.updateCrouch(input, deltaTime);
    }

    // === APPLY VELOCITY USING STEP-SLIDE MOVE ===
    // Uses same collision as local AdvancedCharacterController
    if (collision) {
      // Use Q3-style stepSlideMove for proper collision handling
      const result = collision.stepSlideMove(
        newPos,
        newVel,
        deltaTime,
        FPSMovementProfile.PLAYER_BOUNDS
      );

      // Apply results (CRITICAL: update BOTH position AND velocity!)
      newPos.x = result.endPos.x;
      newPos.y = result.endPos.y;
      newPos.z = result.endPos.z;

      // CRITICAL: Apply clipped velocity from collision
      // stepSlideMove clips velocity when hitting surfaces - we MUST use it
      newVel.x = result.velocity.x;
      newVel.y = result.velocity.y;
      newVel.z = result.velocity.z;

      // Save previous grounded state BEFORE updating
      this.wasGroundedLastFrame = this.isGrounded;
      this.isGrounded = result.grounded;
    } else {
      // No collision world - simple move
      newPos.x += newVel.x * deltaTime;
      newPos.y += newVel.y * deltaTime;
      newPos.z += newVel.z * deltaTime;

      // Simple ground clamp at y=0
      this.wasGroundedLastFrame = this.isGrounded;
      if (newPos.y < 0) {
        newPos.y = 0;
        newVel.y = 0;
        this.isGrounded = true;
      } else {
        this.isGrounded = false;
      }
    }

    // === UPDATE SPEED TRACKING ===
    if (deltaTime > 0) {
      const dx = newPos.x - this.lastPosX;
      const dz = newPos.z - this.lastPosZ;
      this.actualHorizSpeed = Math.sqrt(dx * dx + dz * dz) / deltaTime;
    }
    this.lastPosX = newPos.x;
    this.lastPosZ = newPos.z;

    // === SMOOTHED Y ===
    const heightDiff = Math.abs(newPos.y - this.smoothedY);
    if (heightDiff > this.config.stepHeight * 2) {
      this.smoothedY = newPos.y;
    } else {
      this.smoothedY += (newPos.y - this.smoothedY) * 0.15;
    }

    return {
      position: newPos,
      velocity: newVel,
      grounded: this.isGrounded,
      isSliding: this.isSliding,
      isCrouching: this.isCrouching,
      wallJumpState: this.wallJumpState,
      ledgeGrabState: this.ledgeGrabState,
      actualHorizSpeed: this.actualHorizSpeed,
      crouchViewOffset: this.crouchViewOffset,
    };
  }

  // ================== Ground Check ==================

  /**
   * Check if standing on ground and snap to ground surface if close.
   * This prevents falling through floors by detecting and correcting position.
   */
  private checkGrounded(pos: Vec3, vel: Vec3, collision: CollisionWorld | null): boolean {
    if (!collision) {
      if (pos.y <= 0.1) {
        pos.y = 0;
        return true;
      }
      return false;
    }

    // Trace down to find ground (use stepHeight distance to catch it early)
    const traceDistance = this.config.stepHeight; // 18 units
    const groundTrace = collision.trace(
      pos,
      { x: pos.x, y: pos.y - traceDistance, z: pos.z }
    );

    if (!groundTrace.hit) {
      return false;
    }

    // Calculate actual distance to ground
    const distanceToGround = traceDistance * groundTrace.fraction;

    // If very close (within 2 units) and moving down or stationary, snap to ground
    if (distanceToGround < 2 && vel.y <= 0) {
      // Snap position to be exactly on the ground
      pos.y -= distanceToGround;
      vel.y = 0;
      return true;
    }

    // If fraction is 0, we're INSIDE the ground - push up!
    if (groundTrace.fraction === 0) {
      // We're stuck in the ground, trace UP to find the surface
      const upTrace = collision.trace(
        pos,
        { x: pos.x, y: pos.y + traceDistance, z: pos.z }
      );

      if (upTrace.hit && upTrace.fraction > 0) {
        // Move up to where we hit the ceiling/surface
        pos.y += traceDistance * upTrace.fraction;
      } else {
        // No obstacle above, just push up
        pos.y += 5;
      }
      vel.y = Math.max(0, vel.y);
      return true;
    }

    // Close enough to consider grounded (within step height) but not snapping
    return distanceToGround < 2;
  }

  // ================== Friction ==================

  private applyFriction(vel: Vec3, friction: number, deltaTime: number): void {
    const speed = vec3LengthXZ(vel);

    if (speed < 1) {
      vel.x = 0;
      vel.z = 0;
      return;
    }

    const control = speed < this.config.stopSpeed ? this.config.stopSpeed : speed;
    const drop = control * friction * deltaTime;
    let newSpeed = speed - drop;

    if (newSpeed < 0) newSpeed = 0;

    const scale = newSpeed / speed;
    vel.x *= scale;
    vel.z *= scale;
  }

  // ================== Ground Acceleration ==================

  private groundAccelerate(vel: Vec3, wishDir: Vec3, wishSpeed: number, deltaTime: number): void {
    const currentSpeed = vec3DotXZ(vel, wishDir);
    const addSpeed = wishSpeed - currentSpeed;

    if (addSpeed <= 0) return;

    let accelSpeed = this.config.groundAcceleration * deltaTime * wishSpeed;
    if (accelSpeed > addSpeed) accelSpeed = addSpeed;

    vel.x += wishDir.x * accelSpeed;
    vel.z += wishDir.z * accelSpeed;
  }

  // ================== Air Acceleration ==================

  /**
   * Mode 1: Air Accelerate Forward (W only, accelerating - Warsow style)
   * Complex forward acceleration with bunny hop mechanics
   */
  private airAccelerateForward(vel: Vec3, wishDir: Vec3, wishSpeed: number, deltaTime: number): void {
    const maxPlayerSpeed = this.config.maxSpeed;
    const topspeed = this.config.topSpeed;
    const runSpeed = this.config.runSpeed;
    const radicalSpeed = 600;

    const airforwardaccel = 1.00001;
    const bunnyaccel = 0.1593;
    const turnaccel = 4.0;
    const backtosideratio = 0.8;

    const curvelX = vel.x;
    const curvelZ = vel.z;
    const curspeed = Math.sqrt(curvelX * curvelX + curvelZ * curvelZ);

    // Calculate accel falloff at high speeds
    let accelFalloff = 1.0;
    if (curspeed > runSpeed) {
      if (curspeed < radicalSpeed) {
        const ratio = (curspeed - runSpeed) / (radicalSpeed - runSpeed);
        accelFalloff = 1 - ratio * 0.5;
      } else {
        const ratio = (curspeed - radicalSpeed) / (topspeed - radicalSpeed);
        accelFalloff = Math.max(0, 0.5 * (1 - ratio * ratio * ratio));
      }
    }

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

  /**
   * Mode 2: Strafe Bunny Accelerate (A/D only - CPMA/Q2 strafe jumping)
   * The core strafe jumping mechanic
   */
  private strafeBunnyAccelerate(vel: Vec3, wishDir: Vec3, wishSpeed: number, deltaTime: number): void {
    const baseStrafeBunnyAccel = 50;
    const strafeWishspeed = Math.min(wishSpeed, this.config.maxAirSpeed);
    const curSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    const runSpeed = this.config.runSpeed;
    const radicalSpeed = 600;
    const topspeed = this.config.topSpeed;

    // Calculate accel falloff at high speeds
    let accelFalloff = 1.0;
    if (curSpeed > runSpeed) {
      if (curSpeed < radicalSpeed) {
        const ratio = (curSpeed - runSpeed) / (radicalSpeed - runSpeed);
        accelFalloff = 1 - ratio * 0.5;
      } else {
        const ratio = (curSpeed - radicalSpeed) / (topspeed - radicalSpeed);
        accelFalloff = Math.max(0, 0.5 * (1 - ratio * ratio * ratio));
      }
    }

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
  private normalAirAccelerate(vel: Vec3, wishDir: Vec3, wishSpeed: number, deltaTime: number): void {
    const curSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    const runSpeed = this.config.runSpeed;
    const radicalSpeed = 600;
    const topspeed = this.config.topSpeed;
    const airaccelerate = this.config.airAcceleration;

    // Calculate accel falloff at high speeds
    let accelFalloff = 1.0;
    if (curSpeed > runSpeed) {
      if (curSpeed < radicalSpeed) {
        const ratio = (curSpeed - runSpeed) / (radicalSpeed - runSpeed);
        accelFalloff = 1 - ratio * 0.5;
      } else {
        const ratio = (curSpeed - radicalSpeed) / (topspeed - radicalSpeed);
        accelFalloff = Math.max(0, 0.5 * (1 - ratio * ratio * ratio));
      }
    }

    const currentspeed = vel.x * wishDir.x + vel.z * wishDir.z;
    const addspeed = wishSpeed - currentspeed;

    if (addspeed > 0 && accelFalloff > 0.01) {
      let accelspeed = airaccelerate * deltaTime * wishSpeed * accelFalloff;
      if (accelspeed > addspeed) accelspeed = addspeed;
      vel.x += accelspeed * wishDir.x;
      vel.z += accelspeed * wishDir.z;
    }
  }

  // Note: Original simple airAccelerate kept for reference but unused
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private airAccelerate(_vel: Vec3, _wishDir: Vec3, _wishSpeed: number, _deltaTime: number): void {
    // Replaced by the three mode-specific methods above
  }

  // ================== Wall Jump ==================

  private updateWallJump(
    pos: Vec3,
    vel: Vec3,
    input: MovementInput,
    collision: CollisionWorld | null,
    deltaTime: number,
    now: number
  ): void {
    if (!collision) return;

    const isJumping = input.isPressed(InputButtons.JUMP);

    // Track key release
    if (!isJumping) {
      this.wallJumpKeyReleased = true;
    }

    // Check cooldown
    const cooldownPassed = (now - this.lastWallJumpTime) >= this.config.wallJumpCooldown * 1000;
    if (!cooldownPassed) {
      this.wallJumpState = 'none';
      return;
    }

    // Check minimum height above ground
    const groundCheck = collision.trace(pos, { x: pos.x, y: pos.y - this.config.wallJumpMinHeight, z: pos.z });
    if (groundCheck.hit && groundCheck.fraction < 1) {
      this.wallJumpState = 'none';
      return;
    }

    // Check for wall in multiple directions (like local implementation)
    const reach = this.config.wallJumpReach;

    // Get forward direction from input (should be camera-aligned)
    // If no input, use velocity direction
    let forward: Vec3;
    const inputLen = vec3LengthXZ(input.direction);
    if (inputLen > 0.1) {
      forward = { x: input.direction.x / inputLen, y: 0, z: input.direction.z / inputLen };
    } else {
      const velLen = vec3LengthXZ(vel);
      if (velLen > 1) {
        forward = { x: vel.x / velLen, y: 0, z: vel.z / velLen };
      } else {
        // Use yaw to compute forward
        const yaw = input.viewAngles.yaw;
        forward = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
      }
    }

    // Check multiple directions for walls (forward, forward-right, forward-left, right, left)
    const directions = [
      forward,
      { x: forward.x * 0.707 - forward.z * 0.707, y: 0, z: forward.x * 0.707 + forward.z * 0.707 }, // Forward-Right
      { x: forward.x * 0.707 + forward.z * 0.707, y: 0, z: -forward.x * 0.707 + forward.z * 0.707 }, // Forward-Left
      { x: -forward.z, y: 0, z: forward.x }, // Right
      { x: forward.z, y: 0, z: -forward.x }, // Left
    ];

    let foundWall = false;
    let wallNormal: Vec3 = vec3Zero();

    for (const dir of directions) {
      const wallCheck = collision.trace(pos, vec3Add(pos, vec3Scale(dir, reach)));

      if (wallCheck.hit && wallCheck.normal) {
        // Found a wall - check if wall extends to eye level
        const eyeHeight = 32;
        const eyeCheckStart = { x: pos.x, y: pos.y + eyeHeight - 10, z: pos.z };
        const eyeCheckEnd = vec3Add(eyeCheckStart, vec3Scale(dir, reach));
        const eyeTrace = collision.trace(eyeCheckStart, eyeCheckEnd);

        if (!eyeTrace.hit) {
          // No wall at eye level - low obstacle, skip
          continue;
        }

        // Verify we're moving toward the wall (not away)
        const velDot = vel.x * wallCheck.normal.x + vel.z * wallCheck.normal.z;
        if (velDot > -10) {
          // Moving away or parallel - skip this direction
          continue;
        }

        foundWall = true;
        wallNormal = wallCheck.normal;
        break;
      }
    }

    if (foundWall) {
      this.wallJumpNormal = wallNormal;
      this.wallJumpState = 'available';
      this.wallJumpGraceTime = FPSMovementProfile.DETECTION_GRACE; // Reset grace timer

      // Execute wall jump on fresh press
      if (isJumping && this.wallJumpKeyReleased) {
        this.wallJumpKeyReleased = false;

        // Check if we use charging or instant bounce
        if (this.config.wallJumpChargeTime > 0) {
          // Start charging (grab the wall)
          this.startWallJumpCharge(pos, vel, wallNormal);
        } else {
          // Instant bounce (no grab)
          this.executeWallJump(vel, wallNormal, now);
        }
      }
    } else {
      // No wall found - use grace timer to prevent flicker
      this.wallJumpGraceTime -= deltaTime;
      if (this.wallJumpGraceTime <= 0) {
        this.wallJumpState = 'none';
      }
      // Keep 'available' state during grace period to prevent shaking
    }
  }

  /**
   * Handle wall jump charging state - player hangs on wall
   * Returns early result, skipping normal physics
   */
  private handleWallJumpCharging(
    position: Vec3,
    input: MovementInput | null,
    deltaTime: number,
    now: number
  ): AdvancedMovementResult {
    // Increment charge time
    this.wallJumpChargeTime += deltaTime;

    const isJumping = input?.isPressed(InputButtons.JUMP) ?? false;
    const chargeTime = this.config.wallJumpChargeTime;

    // Check for release or timeout
    if (!isJumping || this.wallJumpChargeTime >= chargeTime) {
      // Execute the boost push
      this.executeWallJumpBoost(now);

      // Return with the new velocity after boost
      return {
        position: vec3Clone(this.wallJumpPosition),
        velocity: vec3Clone(this.wallJumpPreVelocity), // Will be modified by executeWallJumpBoost
        grounded: false,
        isSliding: this.isSliding,
        isCrouching: this.isCrouching,
        wallJumpState: this.wallJumpState,
        ledgeGrabState: this.ledgeGrabState,
        actualHorizSpeed: this.actualHorizSpeed,
        crouchViewOffset: this.crouchViewOffset,
      };
    }

    // Still charging - freeze position and velocity
    // Player hangs on the wall
    const frozenPos = vec3Clone(this.wallJumpPosition);
    const frozenVel = vec3Zero();

    // Update crouch visuals even while charging
    if (input) {
      this.updateCrouch(input, deltaTime);
    }

    return {
      position: frozenPos,
      velocity: frozenVel,
      grounded: false,
      isSliding: false,
      isCrouching: this.isCrouching,
      wallJumpState: 'charging',
      ledgeGrabState: this.ledgeGrabState,
      actualHorizSpeed: 0,
      crouchViewOffset: this.crouchViewOffset,
    };
  }

  /**
   * Execute wall jump boost after charging
   * Uses reflection formula to preserve momentum direction: R = V - 2(V.N)N
   */
  private executeWallJumpBoost(now: number): void {
    const baseVel = this.wallJumpPreVelocity;
    const normal = this.wallJumpNormal;
    const bounce = this.config.wallJumpBounce;
    const boost = this.config.wallJumpBoost;

    // Calculate reflection: R = V - 2(V.N)N
    const dot = baseVel.x * normal.x + baseVel.z * normal.z;
    const reflectedX = baseVel.x - 2 * dot * normal.x;
    const reflectedZ = baseVel.z - 2 * dot * normal.z;

    // Apply bounce factor to reflected velocity
    baseVel.x = reflectedX * bounce;
    baseVel.z = reflectedZ * bounce;

    // If we're moving too slowly after reflection, add outward push
    const speed = vec3LengthXZ(baseVel);
    if (speed < 100) {
      baseVel.x += normal.x * 200 * boost;
      baseVel.z += normal.z * 200 * boost;
    }

    // Apply vertical jump with boost multiplier
    baseVel.y = this.config.wallJumpHeight * boost;

    this.lastWallJumpTime = now;
    this.wallJumpState = 'none';
    this.wallJumpChargeTime = 0;
  }

  /**
   * Start charging state - grab the wall
   */
  private startWallJumpCharge(pos: Vec3, vel: Vec3, normal: Vec3): void {
    this.wallJumpState = 'charging';
    this.wallJumpChargeTime = 0;
    this.wallJumpNormal = vec3Clone(normal);
    this.wallJumpPosition = vec3Clone(pos);
    this.wallJumpPreVelocity = vec3Clone(vel);
  }

  /**
   * Instant wall jump (no charging)
   * Uses reflection formula to preserve momentum direction: R = V - 2(V.N)N
   */
  private executeWallJump(vel: Vec3, normal: Vec3, now: number): void {
    const bounce = this.config.wallJumpBounce;

    // Calculate reflection: R = V - 2(V.N)N
    const dot = vel.x * normal.x + vel.z * normal.z;
    const reflectedX = vel.x - 2 * dot * normal.x;
    const reflectedZ = vel.z - 2 * dot * normal.z;

    // Apply bounce factor to reflected velocity
    vel.x = reflectedX * bounce;
    vel.z = reflectedZ * bounce;

    // Ensure minimum outward speed
    const speed = vec3LengthXZ(vel);
    if (speed < 100) {
      vel.x += normal.x * 200;
      vel.z += normal.z * 200;
    }

    vel.y = this.config.wallJumpHeight;

    this.lastWallJumpTime = now;
    this.wallJumpState = 'none';
  }

  // ================== Crouchslide ==================

  private updateSlide(vel: Vec3, input: MovementInput, deltaTime: number, now: number): void {
    const isCrouching = input.isPressed(InputButtons.CROUCH);
    const isJumping = input.isPressed(InputButtons.JUMP);
    const horizSpeed = vec3LengthXZ(vel);

    if (!this.isSliding) {
      // Check if we should enter slide
      const canSlide = this.isGrounded
        && isCrouching
        && horizSpeed >= this.config.slideMinSpeed
        && (now - this.lastSlideEndTime) >= this.config.slideCooldown;

      if (canSlide) {
        this.isSliding = true;
        this.slideStartTime = now;
        this.slideVelocity = vec3Clone(vel);

        // Boost on entry
        const boost = this.config.slideSpeedMultiplier;
        vel.x *= boost;
        vel.z *= boost;
      }
    } else {
      // Currently sliding
      const slideElapsed = now - this.slideStartTime;
      const slideDuration = this.config.slideDuration;

      // Exit conditions
      const slideExpired = slideElapsed >= slideDuration;
      const tooSlow = horizSpeed < 50;
      const releasedCrouch = !isCrouching;
      const jumpCancel = isJumping && slideElapsed > 100; // Grace period

      if (slideExpired || tooSlow || releasedCrouch || jumpCancel) {
        this.exitSlide(vel, now);

        // Jump boost on cancel
        if (jumpCancel) {
          vel.y = this.config.jumpVelocity;
          const boost = this.config.slideJumpBoost;
          vel.x *= boost;
          vel.z *= boost;
        }
      } else {
        // Apply slide decay
        const decay = this.config.slideDecay * deltaTime;
        const currentSpeed = vec3LengthXZ(vel);
        const newSpeed = Math.max(50, currentSpeed - decay);
        const scale = newSpeed / currentSpeed;
        vel.x *= scale;
        vel.z *= scale;
      }
    }
  }

  private exitSlide(vel: Vec3, now: number): void {
    this.isSliding = false;
    this.lastSlideEndTime = now;
  }

  // ================== Crouch ==================

  private updateCrouch(input: MovementInput, deltaTime: number): void {
    const wantsCrouch = input.isPressed(InputButtons.CROUCH) || this.isSliding;
    this.isCrouching = wantsCrouch;

    const targetOffset = this.isCrouching ? FPSMovementProfile.CROUCH_HEIGHT_OFFSET : 0;
    this.crouchViewOffset += (targetOffset - this.crouchViewOffset) * FPSMovementProfile.CROUCH_TRANSITION_SPEED;
  }

  // ================== Ledge Grab ==================

  /**
   * Update ledge grab state machine
   * Returns true if ledge grab is active (consuming movement)
   */
  private updateLedgeGrab(
    pos: Vec3,
    vel: Vec3,
    input: MovementInput,
    collision: CollisionWorld | null,
    deltaTime: number
  ): boolean {
    if (!this.config.ledgeGrabEnabled) return false;

    // === STATE: GRABBING (pause at ledge) ===
    if (this.ledgeGrabState === 'grabbing') {
      this.ledgeGrabTime += deltaTime;

      // Freeze position
      pos.x = this.ledgeStartPos.x;
      pos.y = this.ledgeStartPos.y;
      pos.z = this.ledgeStartPos.z;
      vel.x = 0;
      vel.y = 0;
      vel.z = 0;

      // Only allow cancel after minimum grab time (prevents flicker from brief input glitches)
      const minGrabTime = 0.05; // 50ms minimum before cancel allowed
      if (this.ledgeGrabTime > minGrabTime) {
        // Cancel on crouch, sprint, or pushing away from wall
        const wishDir = vec3Normalize(input.direction);
        const pushingAway = vec3Dot(wishDir, this.ledgeWallNormal) > 0.5 && vec3LengthXZ(wishDir) > 0.1;

        if (input.isPressed(InputButtons.CROUCH) || input.isPressed(InputButtons.SPRINT) || pushingAway) {
          this.ledgeGrabState = 'none';
          vel.y = -100; // Drop
          return false;
        }
      }

      // Auto-climb after brief pause
      const grabPauseTime = 0.12;
      if (this.ledgeGrabTime >= grabPauseTime) {
        this.ledgeGrabState = 'pulling';
        this.ledgeGrabTime = 0;
      }

      return true;
    }

    // === STATE: PULLING (climbing animation) ===
    if (this.ledgeGrabState === 'pulling') {
      this.ledgeGrabTime += deltaTime;
      const pullTime = this.config.ledgePullTime;
      const progress = Math.min(1.0, this.ledgeGrabTime / pullTime);

      // Ease in-out
      const t = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;

      // Interpolate position
      pos.x = this.ledgeStartPos.x + (this.ledgeTargetPos.x - this.ledgeStartPos.x) * t;
      pos.y = this.ledgeStartPos.y + (this.ledgeTargetPos.y - this.ledgeStartPos.y) * t;
      pos.z = this.ledgeStartPos.z + (this.ledgeTargetPos.z - this.ledgeStartPos.z) * t;
      vel.x = 0;
      vel.y = 0;
      vel.z = 0;

      if (progress >= 1.0) {
        // Done climbing
        this.ledgeGrabState = 'none';
        // Small forward momentum
        const forward = vec3Normalize(input.direction);
        vel.x = forward.x * 100;
        vel.z = forward.z * 100;
      }

      return true;
    }

    // === STATE: DETECTION ===
    // Skip detection if no collision world
    if (!collision) return false;

    // Don't detect while grounded (use stair stepping instead)
    if (this.isGrounded) return false;

    // Block during fast upward motion (initial jump burst)
    if (vel.y > 200) return false;

    // Configuration
    const reach = this.config.ledgeReach;
    const climbHeight = this.config.ledgeHeight;

    // Forward direction from view angles (camera yaw)
    const yaw = input.viewAngles.yaw;
    const forwardDir = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };

    // Must be pressing forward OR moving forward with velocity
    const isPressingForward = input.isPressed(InputButtons.FORWARD);
    const velForwardDot = vel.x * forwardDir.x + vel.z * forwardDir.z;
    const hasForwardIntent = isPressingForward || velForwardDot > 50;

    if (!hasForwardIntent) return false;

    // Eye position (physics origin + 24)
    const eyeY = pos.y + 24;

    // === TRACE 1: Check for wall at waist level ===
    // Waist is ~16 below eye level
    const waistStart = { x: pos.x, y: eyeY - 16, z: pos.z };
    const waistEnd = vec3Add(waistStart, vec3Scale(forwardDir, reach));
    const waistTrace = collision.trace(waistStart, waistEnd);

    if (!waistTrace.hit || waistTrace.fraction >= 1.0) {
      return false;
    }

    // Store wall normal for cancel detection
    if (waistTrace.normal) {
      this.ledgeWallNormal = vec3Clone(waistTrace.normal);
    } else {
      this.ledgeWallNormal = { x: -forwardDir.x, y: 0, z: -forwardDir.z };
    }

    // === TRACE 2: Check if space is clear above eye level ===
    const headStart = { x: pos.x, y: eyeY + 8, z: pos.z };
    const headEnd = vec3Add(headStart, vec3Scale(forwardDir, reach));
    const headTrace = collision.trace(headStart, headEnd);

    if (headTrace.hit && headTrace.fraction < 0.9) {
      // Wall above eye level - no ledge, just a wall
      return false;
    }

    // === TRACE 3: Find ledge surface by tracing down from above ===
    const aboveLedgeStart = vec3Add({ x: pos.x, y: eyeY, z: pos.z }, vec3Scale(forwardDir, reach * 0.7));
    aboveLedgeStart.y += climbHeight;

    const aboveLedgeEnd = { x: aboveLedgeStart.x, y: aboveLedgeStart.y - climbHeight - 48, z: aboveLedgeStart.z };
    const ledgeTrace = collision.trace(aboveLedgeStart, aboveLedgeEnd);

    if (!ledgeTrace.hit || ledgeTrace.fraction >= 1.0) {
      return false;
    }

    // Check if it's a valid floor (normal pointing up)
    if (!ledgeTrace.normal || ledgeTrace.normal.y < 0.7) {
      return false;
    }

    // Calculate ledge surface Y position
    const ledgeSurfaceY = aboveLedgeStart.y - (aboveLedgeStart.y - aboveLedgeEnd.y) * ledgeTrace.fraction;

    // Check eye-to-ledge distance (matching local implementation)
    const eyeToLedge = ledgeSurfaceY - eyeY;

    // If eye is already above ledge, skip (we're past it)
    if (eyeToLedge < -16) {
      return false;
    }

    // If eye is too far below ledge, skip (can't reach)
    if (eyeToLedge > climbHeight) {
      return false;
    }

    // === TRACE 4: Verify room to stand on ledge ===
    const targetPos = {
      x: aboveLedgeStart.x,
      y: ledgeSurfaceY + 24 + 4, // Stand on ledge (origin height + small buffer)
      z: aboveLedgeStart.z
    };

    const standStart = { x: targetPos.x, y: targetPos.y, z: targetPos.z };
    const standEnd = { x: targetPos.x, y: targetPos.y + 32, z: targetPos.z };
    const standTrace = collision.trace(standStart, standEnd);

    if (standTrace.hit && standTrace.fraction < 0.8) {
      return false;
    }

    // === SUCCESS: Start grabbing! ===
    this.startLedgeGrab(targetPos, pos);
    return true;
  }

  private startLedgeGrab(targetPos: Vec3, currentPos: Vec3): void {
    this.ledgeGrabState = 'grabbing';
    this.ledgeGrabTime = 0;
    this.ledgeStartPos = vec3Clone(currentPos);
    this.ledgeTargetPos = vec3Clone(targetPos);
  }

  // ================== Collision Movement ==================

  private moveWithCollision(pos: Vec3, vel: Vec3, move: Vec3, collision: CollisionWorld): void {
    const endPos = vec3Add(pos, move);
    const trace = collision.trace(pos, endPos);

    if (!trace.hit) {
      // No collision - apply full movement
      pos.x = endPos.x;
      pos.y = endPos.y;
      pos.z = endPos.z;
    } else if (trace.fraction > 0) {
      // Partial collision - move up to hit point
      pos.x += move.x * trace.fraction;
      pos.y += move.y * trace.fraction;
      pos.z += move.z * trace.fraction;

      // Clip velocity against surface
      if (trace.normal) {
        const dot = vec3Dot(vel, trace.normal);
        vel.x -= trace.normal.x * dot;
        vel.y -= trace.normal.y * dot;
        vel.z -= trace.normal.z * dot;
      }
    } else {
      // fraction=0 means we started inside solid!
      // Push player UP to escape (anti-stuck)
      if (trace.normal && trace.normal.y > 0.7) {
        // It's a floor - push up
        pos.y += 1; // Nudge up by 1 unit
        vel.y = Math.max(0, vel.y); // Don't go through floor
      } else if (trace.normal) {
        // Wall - push away from normal
        pos.x += trace.normal.x * 1;
        pos.z += trace.normal.z * 1;
        vel.x = 0;
        vel.z = 0;
      } else {
        // Unknown - just nudge up
        pos.y += 5;
        vel.y = 0;
      }
    }

    // Re-check grounded after collision
    const groundTrace = collision.trace(pos, { x: pos.x, y: pos.y - 2, z: pos.z });
    if (groundTrace.hit && groundTrace.fraction < 1) {
      this.isGrounded = true;
      // Snap to ground if close
      if (groundTrace.fraction < 0.1 && vel.y <= 0) {
        pos.y -= groundTrace.fraction * 2;
        vel.y = 0;
      }
    }
  }
}
