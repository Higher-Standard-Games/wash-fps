/**
 * WallJump — wall jump detection, charging, and execution
 *
 * Manages its own state (charge time, cooldown, normals, etc.).
 * Called by the MovementProfile orchestrator.
 */

import type { Vec3 } from '../../../engine/network/components/TransformComponent';
import type { CollisionWorld } from '../../../engine/network/systems/collision/CollisionWorld';
import type { MovementInput } from '../../../engine/network/systems/movement/MovementProfile';
import { InputButtons } from '../../../engine/network/components/InputComponent';
import type { MovementConfig } from './MovementConfig';
import type { AdvancedMovementResult } from './MovementConfig';
import { vec3Zero, vec3Clone, vec3LengthXZ, vec3MulAdd, VEC3_ZERO } from './Vec3Helpers';

/** Grace period for detection hysteresis (seconds) */
const DETECTION_GRACE = 0.1;

export class WallJump {
    state: 'none' | 'available' | 'charging' = 'none';
    chargeTime: number = 0;
    normal: Vec3 = vec3Zero();
    position: Vec3 = vec3Zero();       // Position when grab started
    preVelocity: Vec3 = vec3Zero();    // Velocity before charging
    cooldownRemaining: number = 0;     // Countdown timer (ms)
    keyReleased: boolean = true;
    graceTime: number = 0;            // Grace timer to prevent flicker
    groundGrace: number = 0;          // Grace timer for ground proximity check

    // Pre-allocated scratch vectors (avoid per-tick allocations in traces)
    private readonly _scratchTraceEnd: Vec3 = { x: 0, y: 0, z: 0 };
    private readonly _scratchTraceEnd2: Vec3 = { x: 0, y: 0, z: 0 };

    /** Tick down cooldown timer (called by orchestrator) */
    tickCooldown(dtMs: number): void {
        if (this.cooldownRemaining > 0) this.cooldownRemaining -= dtMs;
    }

    /** Reset state for reconciliation */
    reset(): void {
        this.state = 'none';
        this.chargeTime = 0;
        this.keyReleased = true;
        this.graceTime = 0;
        this.groundGrace = 0;
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
        deltaTime: number,
        config: MovementConfig
    ): void {
        if (!collision) return;

        const isJumping = input.isPressed(InputButtons.JUMP);

        // Track key release
        if (!isJumping) {
            this.keyReleased = true;
        }

        // Check cooldown
        const cooldownPassed = this.cooldownRemaining <= 0;
        if (!cooldownPassed) {
            this.state = 'none';
            return;
        }

        // Check minimum height above ground — use grace timer to prevent
        // client/server prediction mismatch oscillation (shaking).
        const feetY = pos.y - 24; // Q3: origin is 24 units above feet
        const groundCheck = collision.trace(pos, { x: pos.x, y: feetY - config.wallJumpMinHeight, z: pos.z });
        const hasGroundClearance = !(groundCheck.hit && groundCheck.fraction < 1);

        if (hasGroundClearance) {
            this.groundGrace = DETECTION_GRACE;
        } else {
            this.groundGrace -= deltaTime;
            if (this.groundGrace <= 0) {
                this.state = 'none';
                return;
            }
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

        // Check multiple directions for walls
        const directions = [
            forward,
            { x: forward.x * 0.707 - forward.z * 0.707, y: 0, z: forward.x * 0.707 + forward.z * 0.707 },
            { x: forward.x * 0.707 + forward.z * 0.707, y: 0, z: -forward.x * 0.707 + forward.z * 0.707 },
            { x: -forward.z, y: 0, z: forward.x },
            { x: forward.z, y: 0, z: -forward.x },
        ];

        let foundWall = false;
        let wallNormal: Vec3 = VEC3_ZERO as Vec3;

        for (const dir of directions) {
            vec3MulAdd(this._scratchTraceEnd, pos, dir, reach);
            const wallCheck = collision.trace(pos, this._scratchTraceEnd);

            if (wallCheck.hit && wallCheck.normal) {
                // Check if wall extends to eye level
                const eyeHeight = 32;
                const eyeCheckStart = { x: pos.x, y: pos.y + eyeHeight - 10, z: pos.z };
                vec3MulAdd(this._scratchTraceEnd2, eyeCheckStart, dir, reach);
                const eyeTrace = collision.trace(eyeCheckStart, this._scratchTraceEnd2);

                if (!eyeTrace.hit) {
                    continue; // Low obstacle, skip
                }

                // Verify we're moving toward the wall
                const velDot = vel.x * wallCheck.normal.x + vel.z * wallCheck.normal.z;
                if (velDot > -10) {
                    continue; // Moving away or parallel
                }

                foundWall = true;
                wallNormal = wallCheck.normal;
                break;
            }
        }

        if (foundWall) {
            this.normal = wallNormal;
            this.state = 'available';
            this.graceTime = DETECTION_GRACE;

            // Execute wall jump on fresh press
            if (isJumping && this.keyReleased) {
                this.keyReleased = false;

                if (config.wallJumpChargeTime > 0) {
                    this.startCharge(pos, vel, wallNormal);
                } else {
                    this.executeInstant(vel, wallNormal, config);
                }
            }
        } else {
            // No wall found - use grace timer to prevent flicker
            this.graceTime -= deltaTime;
            if (this.graceTime <= 0) {
                this.state = 'none';
            }
        }
    }

    /**
     * Handle wall jump charging state - player hangs on wall.
     * Returns the result to use (skipping normal physics).
     */
    handleCharging(
        _position: Vec3,
        input: MovementInput | null,
        deltaTime: number,
        config: MovementConfig,
        slideState: { isSliding: boolean; isCrouching: boolean; crouchViewOffset: number; slidePhase: number },
        ledgeState: { state: 'none' | 'grabbing' | 'pulling'; phase: number },
        actualHorizSpeed: number,
        updateCrouch: (input: MovementInput, deltaTime: number) => void
    ): AdvancedMovementResult {
        // Increment charge time
        this.chargeTime += deltaTime;

        const isJumping = input?.isPressed(InputButtons.JUMP) ?? false;
        const chargeTime = config.wallJumpChargeTime;

        // Check for release or timeout
        if (!isJumping || this.chargeTime >= chargeTime) {
            this.executeBoost(config);

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
            wallJumpState: 'charging',
            ledgeGrabState: ledgeState.state,
            actualHorizSpeed: 0,
            crouchViewOffset: slideState.crouchViewOffset,
            slidePhase: 0,
            ledgeGrabPhase: ledgeState.phase,
        };
    }

    /** Start charging state - grab the wall */
    private startCharge(pos: Vec3, vel: Vec3, normal: Vec3): void {
        this.state = 'charging';
        this.chargeTime = 0;
        this.normal = vec3Clone(normal);
        this.position = vec3Clone(pos);
        this.preVelocity = vec3Clone(vel);
    }

    /** Execute wall jump boost after charging (reflection formula) */
    private executeBoost(config: MovementConfig): void {
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

        this.cooldownRemaining = config.wallJumpCooldown * 1000;
        this.state = 'none';
        this.chargeTime = 0;
    }

    /** Instant wall jump (no charging) — reflection formula */
    private executeInstant(vel: Vec3, normal: Vec3, config: MovementConfig): void {
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

        this.cooldownRemaining = config.wallJumpCooldown * 1000;
        this.state = 'none';
    }
}
