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

import type { Vec3 } from '../../../engine/network/components/TransformComponent';
import type { CollisionWorld } from '../../../engine/network/systems/collision/CollisionWorld';
import type { MovementProfile as IMovementProfile, MovementInput } from '../../../engine/network/systems/movement/MovementProfile';
import { InputButtons } from '../../../engine/network/components/InputComponent';

import type { MovementConfig, AdvancedMovementResult } from './MovementConfig';
import { vec3Clone, vec3LengthXZ, VEC3_ZERO } from './Vec3Helpers';
import { applyFriction, groundAccelerate, airAccelerateForward, strafeBunnyAccelerate, normalAirAccelerate } from './Acceleration';
import { WallJump } from './WallJump';
import { Slide } from './Slide';
import { LedgeGrab } from './LedgeGrab';

export class MovementProfile implements IMovementProfile {
    private config: MovementConfig;

    // Player bounds for collision traces (matches local AdvancedCharacterController)
    // Uses Q3-style asymmetric box: origin at waist, -24 to feet, +32 to head
    private static readonly PLAYER_BOUNDS = {
        min: { x: -16, y: -24, z: -16 },
        max: { x: 16, y: 32, z: 16 }
    };
    private static readonly PLAYER_BOUNDS_CROUCHED = {
        min: { x: -16, y: -24, z: -16 },
        max: { x: 16, y: 8, z: 16 }
    };

    // Persistent state (carried between frames)
    private isGrounded: boolean = false;
    private wasGroundedLastFrame: boolean = false;
    private jumpConsumed: boolean = false;

    // Speed tracking
    private actualHorizSpeed: number = 0;
    private smoothedY: number = 0;

    // Feature sub-systems
    private wallJump = new WallJump();
    private slide = new Slide();
    private ledgeGrab = new LedgeGrab();

    constructor(config?: Partial<MovementConfig>) {
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
            fallingGravityMultiplier: 1.25,
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
            ledgePullTime: 0.5,

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
     */
    resetPhysicsState(grounded: boolean): void {
        this.isGrounded = grounded;
        this.wasGroundedLastFrame = grounded;
        if (grounded) {
            this.jumpConsumed = false;
        }
        this.wallJump.reset();
        // NOTE: Do NOT reset slide here. Slide state (isSliding, slidePhase) is purely
        // cosmetic (camera tilt) and is maintained by the client's 125Hz simulation.
        // Resetting it during reconciliation (~60Hz) kills the slide and camera animation
        // because the replay cannot reliably reconstruct it (elapsedTime resets,
        // server grounded may disagree with client → slide re-entry fails).

        // NOTE: Do NOT reset ledge grab here either. Ledge grab is a client-side cosmetic
        // state machine (server doesn't simulate it). Resetting during reconciliation
        // forces the replay to re-detect the grab at a slightly different sub-unit position
        // (FP drift through air-accel → slideMove → clip from different server start pos),
        // causing 2-3 frame camera shake when the startPos differs between predictions.
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
        const dtMs = deltaTime * 1000;

        // Tick down cooldown timers
        this.slide.tickCooldown(dtMs);
        this.wallJump.tickCooldown(dtMs);

        const justLanded = !this.wasGroundedLastFrame && this.isGrounded;

        // === WALL JUMP CHARGING STATE ===
        if (this.wallJump.state === 'charging') {
            return this.wallJump.handleCharging(
                position, input, deltaTime, this.config,
                { isSliding: this.slide.isSliding, isCrouching: this.slide.isCrouching, crouchViewOffset: this.slide.crouchViewOffset, slidePhase: this.slide.slidePhase },
                { state: this.ledgeGrab.state, phase: this.ledgeGrab.phase },
                this.actualHorizSpeed,
                (inp: MovementInput, dt: number) => this.slide.updateCrouch(inp, dt)
            );
        }

        // === LEDGE GRAB ===
        if (this.config.ledgeGrabEnabled && input) {
            if (this.ledgeGrab.update(newPos, newVel, input, collision, deltaTime, this.config, this.isGrounded)) {
                return {
                    position: newPos,
                    velocity: newVel,
                    grounded: false,
                    isSliding: false,
                    isCrouching: this.slide.isCrouching,
                    wallJumpState: 'none',
                    ledgeGrabState: this.ledgeGrab.state,
                    actualHorizSpeed: 0,
                    crouchViewOffset: this.slide.crouchViewOffset,
                    slidePhase: 0,
                    ledgeGrabPhase: this.ledgeGrab.phase,
                };
            }
        }

        // === GRAVITY (asymmetric: stronger when falling) ===
        if (!this.isGrounded) {
            const gravScale = newVel.y < 0 ? this.config.fallingGravityMultiplier : 1.0;
            newVel.y -= this.config.gravity * gravScale * deltaTime;
        } else if (newVel.y < 0) {
            newVel.y = 0;
        }

        // === INPUT PROCESSING ===
        if (input) {
            const isAiming = input.isPressed(InputButtons.ALT_FIRE);
            const isCrouching = input.isPressed(InputButtons.CROUCH);
            const isJumping = input.isPressed(InputButtons.JUMP);
            const canRun = !isAiming && !isCrouching;
            const isSprinting = canRun && input.isPressed(InputButtons.SPRINT);

            let wishspeed = isSprinting ? this.config.runSpeed : this.config.maxSpeed;

            // Crouch speed reduction (if not sliding)
            if (isCrouching && !this.slide.isSliding) {
                const horizSpeed = vec3LengthXZ(newVel);
                const cooldownPassed = this.slide.cooldownRemaining <= 0;

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

            if (isJumping && this.isGrounded && canJump) {
                // Check slope angle — don't allow jumping on steep ramps (Warsow behavior)
                // Only allow jumping on surfaces flatter than ~32° (normal.y > 0.85)
                let canJumpOnSlope = true;
                if (collision) {
                    const jumpGroundTrace = collision.trace(
                        newPos,
                        { x: newPos.x, y: newPos.y - 2, z: newPos.z },
                        this.getCurrentBounds()
                    );
                    if (jumpGroundTrace.hit && jumpGroundTrace.normal && jumpGroundTrace.normal.y < 0.85) {
                        canJumpOnSlope = false;
                    }
                }

                if (canJumpOnSlope) {
                    newVel.y = this.config.jumpVelocity;
                    this.jumpConsumed = true;
                    this.isGrounded = false;

                    if (this.slide.isSliding) {
                        this.slide.exit(newVel, this.config);
                    }
                }
            }

            // === MOVEMENT DIRECTION ===
            const wishDir = input.direction;
            const wishLen = vec3LengthXZ(wishDir);
            const hasInput = wishLen > 0.001;

            const normalizedWish = hasInput
                ? { x: wishDir.x / wishLen, y: 0, z: wishDir.z / wishLen }
                : VEC3_ZERO;

            if (this.isGrounded) {
                // === GROUND MOVEMENT ===
                const friction = this.slide.isSliding ? this.config.slideFriction : this.config.friction;
                applyFriction(newVel, friction, this.config.stopSpeed, deltaTime);

                if (hasInput) {
                    groundAccelerate(newVel, normalizedWish, wishspeed, this.config.groundAcceleration, deltaTime);
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
                if (this.config.wallJumpEnabled && !this.slide.isSliding
                    && this.ledgeGrab.state === 'none' && !this.ledgeGrab.isOnCooldown()) {
                    this.wallJump.update(newPos, newVel, input, collision, deltaTime, this.config);
                }
            }

            // === CROUCHSLIDE ===
            if (this.config.slideEnabled) {
                this.slide.update(newVel, input, this.isGrounded, deltaTime, this.config);
            }

            // === CROUCH STATE ===
            this.slide.updateCrouch(input, deltaTime);
        }

        // === APPLY VELOCITY USING STEP-SLIDE MOVE ===
        if (collision) {
            // Q3-style ground plane clipping + slope physics
            if (this.isGrounded) {
                const groundTrace = collision.trace(
                    newPos,
                    { x: newPos.x, y: newPos.y - 2, z: newPos.z },
                    this.getCurrentBounds()
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

            const result = collision.stepSlideMove(
                newPos,
                newVel,
                deltaTime,
                this.getCurrentBounds()
            );

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

        // === UPDATE SPEED TRACKING ===
        const dx = newPos.x - position.x;
        const dz = newPos.z - position.z;
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
        };
    }

    /** Get current player bounds based on crouch state */
    private getCurrentBounds() {
        return (this.slide.isCrouching || this.slide.isSliding)
            ? MovementProfile.PLAYER_BOUNDS_CROUCHED
            : MovementProfile.PLAYER_BOUNDS;
    }
}
