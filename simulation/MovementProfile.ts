/**
 * MovementProfile — Advanced Quake 3 / Warsow style movement orchestrator
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
 *
 * Feature logic is decomposed into:
 *   Acceleration.ts  — stateless ground/air accel functions
 *   WallJump.ts      — wall jump detection + charging + boost
 *   Slide.ts         — crouchslide + crouch state
 *   LedgeGrab.ts     — ledge detection + grab + pull
 */

import { InputButtons } from "../../../engine/network/components/InputComponent";
import type { Vec3 } from "../../../engine/network/components/TransformComponent";
import type { CollisionWorld } from "../../../engine/network/systems/collision/CollisionWorld";
import type {
  MovementProfile as IMovementProfile,
  MovementInput,
} from "../../../engine/network/systems/movement/MovementProfile";
import {
  CROUCH_MINS_Z,
  CROUCH_VIEWHEIGHT,
  DEFAULT_VIEWHEIGHT,
  PLAYER_MINS_Z,
} from "../../../engine/physics/PlayerPhysicsConstants";
import type { TriggerVolume } from "../../../shared/bsp/TriggerTable";
import { MASK_SOLID } from "../../../shared/collision/CollisionWorld";
import { isSwimming, type WaterLevel } from "../liquid/LiquidTypes";
import { sampleLiquid } from "../liquid/LiquidVolumeSampler";
import {
  airAccelerateForward,
  applyFriction,
  groundAccelerate,
  normalAirAccelerate,
  strafeBunnyAccelerate,
} from "./Acceleration";
import { LedgeGrab } from "./LedgeGrab";
import type { AdvancedMovementResult, MovementConfig } from "./MovementConfig";
import { Slide } from "./Slide";
import {
  applyWaterFriction,
  checkWaterJump,
  DEFAULT_LIQUID_MOVEMENT,
  idleSinkVelocity,
  type LiquidMovementProfile,
  swimIntent,
  wadeSpeedScale,
  waterAccelerate,
} from "./Swim";
import { VEC3_ZERO, vec3Clone, vec3Length, vec3LengthXZ } from "./Vec3Helpers";
import { WallJump } from "./WallJump";

/** Jumppad volume with its ballistic target (launch solved per-fire — see setTriggerVolumes). */
interface JumppadVolume {
  id: number;
  min: Vec3;
  max: Vec3;
  dest: Vec3;
}

/** Authoritative baseline used by simulation and offline bot planning. */
export const DEFAULT_FPS_MOVEMENT_CONFIG: Readonly<MovementConfig> = {
  maxSpeed: 280,
  runSpeed: 400,
  groundAcceleration: 10,
  airAcceleration: 1,
  maxAirSpeed: 30,
  friction: 6,
  stopSpeed: 100,
  gravity: 1000,
  fallingGravityMultiplier: 1.25,
  jumpVelocity: 320,
  crouchMultiplier: 0.5,
  stepHeight: 18,
  topSpeed: 1000,
  airControl: 150,
  airControlPower: 50,
  wallJumpEnabled: true,
  wallJumpHeight: 280,
  wallJumpBounce: 1.2,
  wallJumpReach: 20,
  wallJumpCooldown: 1.0,
  wallJumpMinHeight: 32,
  wallJumpChargeTime: 0.2,
  wallJumpBoost: 1.5,
  ledgeGrabEnabled: true,
  ledgeReach: 32,
  ledgeHeight: 64,
  ledgeMinFall: -50,
  ledgeTimeout: 2.0,
  ledgePullTime: 0.5,
  slideEnabled: true,
  slideDuration: 800,
  slideSpeedMultiplier: 1.4,
  slideDecay: 0.5,
  slideJumpBoost: 1.3,
  slideMinSpeed: 375,
  slideFriction: 0.1,
  slideCooldown: 1500,
  teleportSpeedMode: 1,
  teleportExitSpeed: 400,
};

export class MovementProfile implements IMovementProfile {
  private config: MovementConfig;

  // Player bounds for collision traces (matches local AdvancedCharacterController)
  // Uses Q3-style asymmetric box: origin at waist, -24 to feet, +32 to head
  private static readonly PLAYER_BOUNDS = {
    min: { x: -16, y: -24, z: -16 },
    max: { x: 16, y: 32, z: 16 },
  };
  private static readonly PLAYER_BOUNDS_CROUCHED = {
    min: { x: -16, y: -24, z: -16 },
    max: { x: 16, y: 8, z: 16 },
  };

  /**
   * Hull for a swimmer who is moving, and therefore lying flat.
   *
   * Short rather than wide, deliberately. The rendered body is 64 units long
   * along the player's yaw, and no axis-aligned box can be long along an
   * arbitrary yaw — every consumer of these bounds (step-slide, hitscan,
   * spawn validation, telefrag, separation) assumes world axes. Widening the
   * footprint to circumscribe the body at any yaw would make a swimmer 64
   * units across and wedge them in the tunnels pools are full of, so the hull
   * keeps its radius and loses its height instead. The player fits under low
   * gaps and presents a flatter target; shots at the rendered head and feet
   * fall outside it, which is the accepted cost.
   */
  private static readonly PLAYER_BOUNDS_SWIMMING = {
    min: { x: -16, y: -14, z: -16 },
    max: { x: 16, y: 14, z: 16 },
  };

  // Persistent state (carried between frames)
  private isGrounded: boolean = false;
  private wasGroundedLastFrame: boolean = false;
  private jumpConsumed: boolean = false;

  /**
   * Water level entering the current step. Re-derived from position and map
   * geometry every step rather than accumulated, so a reconciliation replay
   * recomputes it instead of inheriting a level the corrected position does
   * not support.
   */
  private waterLevel: WaterLevel = 0;

  /**
   * Sim-clock deadline for an assisted climb out of water, or 0.
   *
   * Anchored to the sequence-derived clock like the wall-jump and slide
   * timers, so re-simulating a command lands on the same answer rather than
   * advancing time again.
   */
  private waterJumpUntilMs: number = 0;

  /**
   * The swimmer is lying flat this step, so the hull is the prone one.
   *
   * Paired with the moving swim clip; see updateProneState for why it can be
   * refused a return to standing.
   */
  private proneInWater: boolean = false;

  /** Swim tuning. Ours to set; see Swim.ts for why there is only one profile. */
  private liquid: LiquidMovementProfile = { ...DEFAULT_LIQUID_MOVEMENT };

  /**
   * Sim clock (ms). Derived from the input's sequence number when available
   * (`sequence * dtMs`) — sequences are monotonic and each maps to exactly one
   * fixed-dt step on both client and server, so reconciliation replays that
   * re-simulate old inputs recompute the SAME timestamps instead of advancing
   * time again. Falls back to dt accumulation for inputs without a sequence
   * (offline/bot paths that never replay).
   */
  private simNowMs: number = 0;

  // Speed tracking
  private actualHorizSpeed: number = 0;
  private smoothedY: number = 0;

  // Feature sub-systems
  private wallJump = new WallJump();
  private slide = new Slide();
  private ledgeGrab = new LedgeGrab();

  /** External speed bonus (e.g., +25 for blade weapon). Applied to both walk and run speed. */
  public speedBonus: number = 0;

  /**
   * Static map trigger volumes (set once at map load — identical on server and
   * client, extracted via the shared TriggerTable). Jumppad launch velocities
   * are precomputed here from this profile's gravity. STATELESS at simulate
   * time: evaluation is a pure function of position, so reconciliation replays
   * are idempotent by construction.
   */
  private jumppads: JumppadVolume[] = [];
  /** Teleporter volumes (evaluated before pads; at most one trigger fires per step). */
  private teleporters: TriggerVolume[] = [];

  /**
   * Distance from player origin to feet (24) + 1u clearance: teleporter dest
   * origins sit at floor level, the player origin is at the waist.
   */
  private static readonly TELEPORT_EXIT_LIFT = 25;

  /**
   * Install the map's trigger volumes (from TriggerTable.extractTriggerVolumes).
   *
   * Jumppad launch is solved Q3 AimAtTarget-style, but from the PLAYER's
   * current position each fire (not the pad center like Q3):
   *   time = sqrt(height / (0.5·g));  v_xy = Δxz/time;  v_y = g·time
   * Q3 precomputes a fixed velocity and suppresses re-fires with per-pad
   * contact state (`ps->jumppadEnt`); state like that is a replay hazard here
   * (a stale contact flag on the first reconciliation-replay step would
   * suppress or double a launch). Per-position solving is stateless AND
   * re-fire-safe: every fire re-aims at the target, so the last tick inside
   * the volume wins and the player lands ON dest instead of overshooting by
   * the re-fire accumulation. Deviation from Q3 documented in
   * docs/research/triggerbrushes-and-targets.md §3.4.
   *
   * Pads whose target is not above the pad are invalid and dropped (warn).
   */
  setTriggerVolumes(volumes: TriggerVolume[]): void {
    this.jumppads = [];
    this.teleporters = [];

    for (const v of volumes) {
      if (v.type === "teleport") {
        this.teleporters.push(v);
        continue;
      }

      const centerY = (v.min.y + v.max.y) / 2;
      if (v.dest.y - centerY <= 0) {
        console.warn(
          `[MovementProfile] jumppad ${v.id}: target not above pad (height ${(v.dest.y - centerY).toFixed(1)}) — dropped`,
        );
        continue;
      }

      this.jumppads.push({
        id: v.id,
        min: { ...v.min },
        max: { ...v.max },
        dest: { ...v.dest },
      });
    }
  }

  constructor(config?: Partial<MovementConfig>) {
    this.config = {
      ...DEFAULT_FPS_MOVEMENT_CONFIG,
      ...config,
    };
  }

  getName(): string {
    return "AdvancedFPSMovement";
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
   * Stable serialization of every movement rule consumed by deterministic
   * offline analyzers and versioned caches. Keep callers from duplicating a
   * partial list of defaults that silently misses a physics-affecting field.
   */
  getDeterminismFingerprint(): string {
    return Object.entries(this.config)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
  }

  /**
   * Reset physics state (for reconciliation)
   */
  resetPhysicsState(grounded: boolean): void {
    this.isGrounded = grounded;
    this.wasGroundedLastFrame = grounded;
    if (grounded) {
      this.jumpConsumed = false;
    }
    this.wallJump.reset();
    // NOTE: Do NOT reset slide here. Resetting it during reconciliation kills the
    // slide and camera animation because the replay cannot reliably reconstruct it
    // (server grounded may disagree with client → slide re-entry fails). Since all
    // slide timers are sequence-derived absolute timestamps (see simNowMs), replays
    // re-simulating old inputs recompute identical timelines anyway — surviving
    // reconciliation is safe by construction.

    // NOTE: Do NOT reset ledge grab here either. Ledge grab is a client-side cosmetic
    // state machine (server doesn't simulate it). Resetting during reconciliation
    // forces the replay to re-detect the grab at a slightly different sub-unit position
    // (FP drift through air-accel → slideMove → clip from different server start pos),
    // causing 2-3 frame camera shake when the startPos differs between predictions.
  }

  /**
   * Main simulation entry point
   */
  /**
   * Simulate one step, then report how deep the player ended up in liquid.
   *
   * The sampling is deliberately wrapped around the whole step rather than
   * placed at one of its exits: `simulateCore` returns from several branches
   * (wall-jump charging, ledge grab, teleport) and a liquid state attached to
   * only some of them would be a state that vanishes whenever the player does
   * something interesting.
   *
   * Sampling is a pure function of position and map geometry, so the server and
   * the predicted client compute the same answer for the same command, and a
   * reconciliation replay recomputes it rather than inheriting it.
   *
   * Phase 1: the sample is reported, and nothing reads it yet. Movement is
   * unchanged.
   */
  simulate(
    position: Vec3,
    velocity: Vec3,
    input: MovementInput | null,
    deltaTime: number,
    collision: CollisionWorld | null,
  ): AdvancedMovementResult {
    // Sample BEFORE the step to choose the movement branch, exactly as Q3 sets
    // water level at the top of its move. Using the post-step sample instead
    // would decide this step's physics from where the step ended up.
    this.waterLevel = this.sampleAt(collision, position).level;

    const result = this.simulateCore(position, velocity, input, deltaTime, collision);

    // Sample again at the resulting position: this is the state the rest of the
    // game reads, and the input to the next step's branch choice.
    const liquid = this.sampleAt(collision, result.position);
    this.waterLevel = liquid.level;

    result.waterLevel = liquid.level;
    result.liquidContents = liquid.rawContents;
    result.liquidKind = liquid.kind;
    return result;
  }

  /** Three-point sample using whichever hull the player currently occupies. */
  private sampleAt(collision: CollisionWorld | null, origin: Vec3) {
    const crouched = this.slide.isCrouching || this.slide.isSliding;
    return sampleLiquid(collision, origin, {
      minsY: crouched ? CROUCH_MINS_Z : PLAYER_MINS_Z,
      viewHeight: crouched ? CROUCH_VIEWHEIGHT : DEFAULT_VIEWHEIGHT,
    });
  }

  private simulateCore(
    position: Vec3,
    velocity: Vec3,
    input: MovementInput | null,
    deltaTime: number,
    collision: CollisionWorld | null,
  ): AdvancedMovementResult {
    const newPos = vec3Clone(position);
    const newVel = vec3Clone(velocity);
    const dtMs = deltaTime * 1000;

    // Advance the sim clock (sequence-derived when available — see field doc)
    if (input?.sequence !== undefined && input.sequence > 0) {
      this.simNowMs = input.sequence * dtMs;
    } else {
      this.simNowMs += dtMs;
    }
    const nowMs = this.simNowMs;

    const justLanded = !this.wasGroundedLastFrame && this.isGrounded;

    // === DEEP WATER CLEARS THE SPECIAL MOVES ===
    // Wall jump, ledge grab and crouchslide all describe a body against solid
    // geometry. Deciding their underwater behaviour by call order would be an
    // accident; deciding it here is a choice. Whether a submerged dash should
    // ever be possible is a design question for play, not a compatibility one.
    if (isSwimming(this.waterLevel)) {
      if (this.wallJump.state !== "none") this.wallJump.reset();
      if (this.ledgeGrab.state !== "none") this.ledgeGrab.reset();
      if (this.slide.isSliding) this.slide.exit(velocity, nowMs, this.config);
    }

    // === WALL JUMP CHARGING STATE ===
    if (this.wallJump.state === "charging") {
      return this.wallJump.handleCharging(
        position,
        input,
        nowMs,
        deltaTime,
        this.config,
        {
          isSliding: this.slide.isSliding,
          isCrouching: this.slide.isCrouching,
          crouchViewOffset: this.slide.crouchViewOffset,
          slidePhase: this.slide.slidePhase,
        },
        { state: this.ledgeGrab.state, phase: this.ledgeGrab.phase },
        this.actualHorizSpeed,
        (inp: MovementInput, t: number) => this.slide.updateCrouch(inp, t),
      );
    }

    // === LEDGE GRAB ===
    if (this.config.ledgeGrabEnabled && input && !isSwimming(this.waterLevel)) {
      if (this.ledgeGrab.update(newPos, newVel, input, collision, nowMs, this.config, this.isGrounded)) {
        return {
          position: newPos,
          velocity: newVel,
          grounded: false,
          isSliding: false,
          isCrouching: this.slide.isCrouching,
          wallJumpState: "none",
          ledgeGrabState: this.ledgeGrab.state,
          actualHorizSpeed: 0,
          crouchViewOffset: this.slide.crouchViewOffset,
          slidePhase: 0,
          ledgeGrabPhase: this.ledgeGrab.phase,
        };
      }
    }

    const swimming = isSwimming(this.waterLevel);
    const waterJumping = this.waterJumpUntilMs > nowMs;

    // Leaving the water always stands the player back up. This has to happen
    // outside the swim branch, because that branch is exactly what stops
    // running once the player is out — a prone flag cleared only from inside
    // it would strand a shrunken hull on someone walking around on land.
    if (!swimming) this.proneInWater = false;

    // === GRAVITY (asymmetric: stronger when falling) ===
    // A swimmer is held up by the water, not by the ground, so gravity is off
    // entirely — the idle sink below is what makes them settle. An assisted
    // climb is a ballistic arc and keeps gravity so it lands.
    if (swimming && !waterJumping) {
      // no gravity while swimming
    } else if (!this.isGrounded) {
      const gravScale = newVel.y < 0 ? this.config.fallingGravityMultiplier : 1.0;
      newVel.y -= this.config.gravity * gravScale * deltaTime;
    } else if (newVel.y < 0) {
      newVel.y = 0;
    }

    // === INPUT PROCESSING ===
    if (input) {
      const isAiming = input.isPressed(InputButtons.ALT_FIRE);
      const isFiring = input.isPressed(InputButtons.FIRE);
      const isCrouching = input.isPressed(InputButtons.CROUCH);
      const isJumping = input.isPressed(InputButtons.JUMP);
      const canRun = !isAiming && !isFiring && !isCrouching;
      const isSprinting =
        canRun &&
        input.isPressed(InputButtons.SPRINT) &&
        input.isPressed(InputButtons.FORWARD) &&
        !input.isPressed(InputButtons.BACK);

      // Sprint only applies to pure forward movement — strafe, back, and diagonal use walk speed
      const forwardOnly =
        input.isPressed(InputButtons.FORWARD) &&
        !input.isPressed(InputButtons.BACK) &&
        !input.isPressed(InputButtons.LEFT) &&
        !input.isPressed(InputButtons.RIGHT);
      let wishspeed =
        isSprinting && forwardOnly ? this.config.runSpeed + this.speedBonus : this.config.maxSpeed + this.speedBonus;

      // Crouch speed reduction (if not sliding)
      if (isCrouching && !this.slide.isSliding) {
        const horizSpeed = vec3LengthXZ(newVel);
        const cooldownPassed = !this.slide.isOnCooldown(nowMs);

        if (horizSpeed < this.config.slideMinSpeed || !cooldownPassed) {
          wishspeed *= this.config.crouchMultiplier;
        }
      }

      // === JUMP ===
      if (!isJumping) {
        this.jumpConsumed = false;
      }

      const autohop = true;
      const canJump = !this.jumpConsumed || (autohop && justLanded);

      // Jump is ascend while swimming, handled in the swim branch. Standing on
      // the bottom of a deep pool still counts as grounded, so without this a
      // submerged player could jump normally.
      if (isJumping && this.isGrounded && canJump && !swimming) {
        // Check slope angle — don't allow jumping on steep ramps (Warsow behavior)
        // Only allow jumping on surfaces flatter than ~32° (normal.y > 0.85)
        let canJumpOnSlope = true;
        if (collision) {
          const jumpGroundTrace = collision.trace(
            newPos,
            { x: newPos.x, y: newPos.y - 2, z: newPos.z },
            this.getCurrentBounds(),
          );
          if (jumpGroundTrace.hit && jumpGroundTrace.normal && jumpGroundTrace.normal.y < 0.85) {
            canJumpOnSlope = false;
          }
        }

        if (canJumpOnSlope) {
          newVel.y = this.config.jumpVelocity;
          this.jumpConsumed = true;
          this.isGrounded = false;

          // Consume walljump key state — walljump requires its own
          // fresh press, not a held space from bunny hopping
          this.wallJump.keyReleased = false;

          if (this.slide.isSliding) {
            this.slide.exit(newVel, nowMs, this.config);
          }
        }
      }

      // === MOVEMENT DIRECTION ===
      const wishDir = input.direction;
      const wishLen = vec3LengthXZ(wishDir);
      const hasInput = wishLen > 0.001;

      const normalizedWish = hasInput ? { x: wishDir.x / wishLen, y: 0, z: wishDir.z / wishLen } : VEC3_ZERO;

      if (waterJumping) {
        // === ASSISTED CLIMB OUT OF WATER ===
        // The launch already set velocity; the player gets no say until they
        // land or start falling back. Cancelling on a downward velocity stops
        // a failed climb from freezing control the whole two seconds.
        if (this.isGrounded || newVel.y < 0) {
          this.waterJumpUntilMs = 0;
        }
      } else if (swimming) {
        // === SWIMMING ===
        // Moving lays the body flat and shrinks the hull with it; treading
        // stands it back up, but only where there is room. `hasInput` is the
        // same signal the renderer uses to choose between the two clips.
        this.updateProneState(newPos, hasInput || isJumping !== isCrouching, collision);
        this.swimMove(newPos, newVel, input, wishDir, deltaTime, collision);
      } else if (this.isGrounded) {
        // === GROUND MOVEMENT ===
        const friction = this.slide.isSliding ? this.config.slideFriction : this.config.friction;
        applyFriction(newVel, friction, this.config.stopSpeed, deltaTime);
        // Wading drags as well, on all three axes and scaled by depth. Q3
        // applies water friction "even if just wading", and it is what makes
        // shallows feel like shallows rather than like carpet.
        applyWaterFriction(newVel, this.waterLevel, this.liquid, this.config.stopSpeed, deltaTime);

        if (hasInput) {
          // Wading also caps speed, interpolating toward the swim cap by depth
          // so entering a pool slows you continuously rather than at a step.
          const waded = wishspeed * wadeSpeedScale(this.waterLevel, this.liquid);
          groundAccelerate(newVel, normalizedWish, waded, this.config.groundAcceleration, deltaTime);
        }
      } else {
        // === AIR MOVEMENT ===
        const holdingForward = input.isPressed(InputButtons.FORWARD) || input.isPressed(InputButtons.BACK);
        const holdingStrafe = input.isPressed(InputButtons.LEFT) || input.isPressed(InputButtons.RIGHT);
        const velocityDotWish = newVel.x * normalizedWish.x + newVel.z * normalizedWish.z;
        const isAccelerating = velocityDotWish > 0;

        if (hasInput) {
          if (holdingForward && !holdingStrafe && isAccelerating) {
            airAccelerateForward(newVel, normalizedWish, wishspeed, this.config, deltaTime);
          } else if (holdingStrafe && !holdingForward) {
            strafeBunnyAccelerate(newVel, normalizedWish, wishspeed, this.config, deltaTime);
          } else {
            normalAirAccelerate(newVel, normalizedWish, wishspeed, this.config, deltaTime);
          }
        }

        // === WALL JUMP (in air, not during/after ledge grab) ===
        if (
          this.config.wallJumpEnabled &&
          !this.slide.isSliding &&
          this.ledgeGrab.state === "none" &&
          !this.ledgeGrab.isOnCooldown(nowMs)
        ) {
          this.wallJump.update(newPos, newVel, input, collision, nowMs, this.config);
        }
      }

      // === CROUCHSLIDE ===
      // Crouch is descend input while swimming; letting the slide system see it
      // would leave a stale sliding flag on a player who never touched a floor.
      if (this.config.slideEnabled && !swimming) {
        this.slide.update(newVel, input, this.isGrounded, nowMs, deltaTime, this.config);
      }

      // === CROUCH STATE (sim-clock anchored — replay-idempotent) ===
      this.slide.updateCrouch(input, nowMs);
    }

    // === APPLY VELOCITY USING STEP-SLIDE MOVE ===
    if (collision) {
      // Q3-style ground plane clipping + slope physics
      if (this.isGrounded) {
        const groundTrace = collision.trace(
          newPos,
          { x: newPos.x, y: newPos.y - 2, z: newPos.z },
          this.getCurrentBounds(),
        );
        if (groundTrace.hit && groundTrace.normal) {
          const n = groundTrace.normal;
          // MIN_WALK_NORMAL = 0.7 — matches Q3/Warsow (45° ramps are walkable)
          if (n.y > 0.7 && n.y < 0.99) {
            // Walkable slope — clip velocity to slope surface
            const dot = newVel.x * n.x + newVel.y * n.y + newVel.z * n.z;
            const OVERCLIP = 1.001;
            newVel.x -= n.x * dot * OVERCLIP;
            newVel.y -= n.y * dot * OVERCLIP;
            newVel.z -= n.z * dot * OVERCLIP;
          } else if (n.y > 0 && n.y <= 0.7) {
            // Non-walkable steep slope (includes 45°) — slide physics
            // Player slides down/along the slope instead of stopping
            this.isGrounded = false; // Treat as airborne (no friction)
            const gravSlope = this.config.gravity * deltaTime;
            // Project (0, -gravSlope, 0) onto the slope plane
            const gravDot = -gravSlope * n.y;
            newVel.x -= n.x * gravDot;
            newVel.y -= gravSlope - n.y * gravDot;
            newVel.z -= n.z * gravDot;
          }
        }
      }

      const result = collision.stepSlideMove(newPos, newVel, deltaTime, this.getCurrentBounds());

      newPos.x = result.endPos.x;
      newPos.y = result.endPos.y;
      newPos.z = result.endPos.z;

      newVel.x = result.velocity.x;
      newVel.y = result.velocity.y;
      newVel.z = result.velocity.z;

      this.wasGroundedLastFrame = this.isGrounded;
      this.isGrounded = result.grounded;
    } else {
      newPos.x += newVel.x * deltaTime;
      newPos.y += newVel.y * deltaTime;
      newPos.z += newVel.z * deltaTime;

      this.wasGroundedLastFrame = this.isGrounded;
      if (newPos.y < 0) {
        newPos.y = 0;
        newVel.y = 0;
        this.isGrounded = true;
      } else {
        this.isGrounded = false;
      }
    }

    // === MAP TRIGGERS (trigger_teleport / trigger_push) ===
    // Evaluated at the end-of-step position: touched this tick → effect takes
    // hold next tick (1 fixed-dt staging, same on both sides). Stateless pure
    // functions of position — replay-safe. AT MOST ONE trigger fires per step
    // (teleporters first), so a dest inside another trigger chains one step at
    // a time instead of looping inside a single tick.
    let jumppadLaunch = false;
    let teleported = false;
    let teleportYaw: number | undefined;
    let firedTriggerId: number | undefined;
    // Speed tracking measures actual MOVEMENT — sample before a teleport can
    // relocate the origin (a teleport is not a 50k-ups animation frame).
    const preTriggerX = newPos.x;
    const preTriggerZ = newPos.z;
    const bounds = this.getCurrentBounds();
    const overlaps = (vMin: Vec3, vMax: Vec3): boolean =>
      newPos.x + bounds.min.x <= vMax.x &&
      newPos.x + bounds.max.x >= vMin.x &&
      newPos.y + bounds.min.y <= vMax.y &&
      newPos.y + bounds.max.y >= vMin.y &&
      newPos.z + bounds.min.z <= vMax.z &&
      newPos.z + bounds.max.z >= vMin.z;

    let teleportFrom: Vec3 | undefined;
    for (const tele of this.teleporters) {
      if (!overlaps(tele.min, tele.max)) continue;

      // Entry position (for exit/entry VFX), then exit at the destination,
      // origin lifted to waist height (+1u clearance).
      teleportFrom = { x: newPos.x, y: newPos.y, z: newPos.z };
      newPos.x = tele.dest.x;
      newPos.y = tele.dest.y + MovementProfile.TELEPORT_EXIT_LIFT;
      newPos.z = tele.dest.z;

      // Exit velocity along the destination yaw (see MovementConfig.teleportSpeedMode).
      // Mode 1 redirects the FULL 3D momentum magnitude (Warsow): falling into
      // a tele converts drop speed into exit speed. Horizontal-only turned out
      // to dead-stop players on wdm2's drop-in teles (entry velocity is nearly
      // all vertical) — browser-test feedback 2026-07-10.
      const yaw = tele.destYaw ?? 0;
      const speed = this.config.teleportSpeedMode === 0 ? this.config.teleportExitSpeed : vec3Length(newVel);
      newVel.x = Math.sin(yaw) * speed;
      newVel.y = 0;
      newVel.z = Math.cos(yaw) * speed;

      this.isGrounded = false;
      teleported = true;
      teleportYaw = yaw;
      firedTriggerId = tele.id;
      break; // one trigger per step
    }

    if (!teleported && this.jumppads.length > 0) {
      // Jumppad velocity is REPLACED (Q3) with a per-position AimAtTarget
      // solve (see setTriggerVolumes), so re-touching while still inside the
      // volume just re-aims at the target — no per-pad state.
      for (const pad of this.jumppads) {
        if (!overlaps(pad.min, pad.max)) continue;

        const height = pad.dest.y - newPos.y;
        if (height <= 0) break; // above the target — nothing sane to solve

        const time = Math.sqrt(height / (0.5 * this.config.gravity));
        newVel.x = (pad.dest.x - newPos.x) / time;
        newVel.y = this.config.gravity * time;
        newVel.z = (pad.dest.z - newPos.z) / time;
        this.isGrounded = false;
        jumppadLaunch = true;
        firedTriggerId = pad.id;
        break; // one pad per step
      }
    }

    // === UPDATE SPEED TRACKING (pre-teleport position — see above) ===
    const dx = preTriggerX - position.x;
    const dz = preTriggerZ - position.z;
    const posDeltaSpeed = Math.sqrt(dx * dx + dz * dz) / deltaTime;
    this.actualHorizSpeed = posDeltaSpeed;

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
      isSliding: this.slide.isSliding,
      isCrouching: this.slide.isCrouching,
      wallJumpState: this.wallJump.state,
      ledgeGrabState: this.ledgeGrab.state,
      actualHorizSpeed: this.actualHorizSpeed,
      crouchViewOffset: this.slide.crouchViewOffset,
      slidePhase: this.slide.slidePhase,
      ledgeGrabPhase: this.ledgeGrab.phase,
      jumppadLaunch,
      teleported,
      teleportYaw,
      teleportFrom,
      triggerId: firedTriggerId,
    };
  }

  /**
   * One step of swimming.
   *
   * Order matters and follows Q3: check for a way out first, then drag, then
   * the player's intention. Doing the climb check after acceleration would let
   * a frame of swim velocity fight the launch.
   */
  private swimMove(
    newPos: Vec3,
    newVel: Vec3,
    input: MovementInput,
    wishDir: Vec3,
    deltaTime: number,
    collision: CollisionWorld | null,
  ): void {
    // A ledge in front of a treading player is a way out, and old maps have
    // plenty of pool lips that cannot be swum over.
    if (
      collision &&
      checkWaterJump(
        newPos,
        input.viewAngles,
        this.waterLevel,
        (point) => (collision.pointContents(point) & MASK_SOLID) !== 0,
      )
    ) {
      const yaw = input.viewAngles.yaw;
      newVel.x = Math.sin(yaw) * this.liquid.waterJumpForward;
      newVel.z = Math.cos(yaw) * this.liquid.waterJumpForward;
      newVel.y = this.liquid.waterJumpUp;
      this.waterJumpUntilMs = this.simNowMs + this.liquid.waterJumpDurationMs;
      this.isGrounded = false;
      return;
    }

    applyWaterFriction(newVel, this.waterLevel, this.liquid, this.config.stopSpeed, deltaTime);

    // Space ascends, Ctrl descends — independent of view direction, so
    // surfacing never requires aiming at the ceiling.
    const up = input.isPressed(InputButtons.JUMP) ? 1 : 0;
    const down = input.isPressed(InputButtons.CROUCH) ? 1 : 0;
    const intent = swimIntent(
      wishDir,
      input.viewAngles,
      up - down,
      this.config.maxSpeed + this.speedBonus,
      this.liquid,
    );

    if (!intent.dir) {
      // Asking for nothing means sinking, not hovering.
      const sink = idleSinkVelocity(this.liquid);
      waterAccelerate(newVel, { x: 0, y: -1, z: 0 }, -sink.y, this.liquid.waterAcceleration, deltaTime);
      return;
    }

    waterAccelerate(newVel, intent.dir, intent.speed, this.liquid.waterAcceleration, deltaTime);
  }

  /** Get current player bounds based on crouch state */
  private getCurrentBounds() {
    if (this.proneInWater) return MovementProfile.PLAYER_BOUNDS_SWIMMING;
    return this.slide.isCrouching || this.slide.isSliding
      ? MovementProfile.PLAYER_BOUNDS_CROUCHED
      : MovementProfile.PLAYER_BOUNDS;
  }

  /**
   * Decide whether the swimmer is lying flat this step.
   *
   * The hull follows the animation: the moving clip lays the body down, the
   * treading clip keeps it upright. Going prone is always allowed — the hull
   * only shrinks. Standing back up is not, because the hull grows, and growing
   * inside geometry is how a player ends up embedded in a ceiling. So the same
   * clearance trace that lets a crouched player stand applies here, and when
   * there is no room the player stays prone AND stays in the moving clip.
   * Hull and animation never disagree, which is the only reason to give the
   * swimmer a different hull at all.
   */
  private updateProneState(position: Vec3, moving: boolean, collision: CollisionWorld | null): void {
    if (!isSwimming(this.waterLevel)) {
      this.proneInWater = false;
      return;
    }

    if (moving) {
      this.proneInWater = true;
      return;
    }

    if (!this.proneInWater) return;

    // Treading again: only rise if the standing hull fits where we are.
    if (!collision) {
      this.proneInWater = false;
      return;
    }

    const upright = this.slide.isCrouching ? MovementProfile.PLAYER_BOUNDS_CROUCHED : MovementProfile.PLAYER_BOUNDS;
    const probe = collision.trace(position, position, upright);
    this.proneInWater = probe.hit;
  }
}
