/**
 * LedgeGrab — ledge detection, grab pause, and pull-up state machine
 *
 * Manages its own state (grab/pull position, phase, etc.).
 * Called by the MovementProfile orchestrator.
 */

import type { Vec3 } from '../../../engine/network/components/TransformComponent';
import type { CollisionWorld } from '../../../engine/network/systems/collision/CollisionWorld';
import type { MovementInput } from '../../../engine/network/systems/movement/MovementProfile';
import { InputButtons } from '../../../engine/network/components/InputComponent';
import type { MovementConfig } from './MovementConfig';
import { vec3Zero, vec3Clone, vec3Add, vec3Scale, vec3Normalize, vec3Dot, vec3LengthXZ } from './Vec3Helpers';

export class LedgeGrab {
    state: 'none' | 'grabbing' | 'pulling' = 'none';
    phase: number = 0;  // Camera phase (0-1)

    private grabTime: number = 0;
    private cooldownRemaining: number = 0;
    private targetPos: Vec3 = vec3Zero();
    private startPos: Vec3 = vec3Zero();
    private wallNormal: Vec3 = vec3Zero();

    /** Reset state for reconciliation */
    reset(): void {
        this.state = 'none';
        this.phase = 0;
        this.cooldownRemaining = 0;
    }

    /** Check if ledge grab is on cooldown (used by orchestrator to suppress wall jump) */
    isOnCooldown(): boolean {
        return this.cooldownRemaining > 0;
    }

    /**
     * Update ledge grab state machine.
     * Returns true if ledge grab is active (consuming movement).
     * Mutates pos and vel in-place.
     */
    update(
        pos: Vec3,
        vel: Vec3,
        input: MovementInput,
        collision: CollisionWorld | null,
        deltaTime: number,
        config: MovementConfig,
        isGrounded: boolean
    ): boolean {
        if (!config.ledgeGrabEnabled) return false;

        // Tick down post-pull cooldown
        if (this.cooldownRemaining > 0) {
            this.cooldownRemaining -= deltaTime;
            if (this.state === 'none') return false;
        }

        // === STATE: GRABBING (pause at ledge) ===
        if (this.state === 'grabbing') {
            this.grabTime += deltaTime;

            // Freeze position
            pos.x = this.startPos.x;
            pos.y = this.startPos.y;
            pos.z = this.startPos.z;
            vel.x = 0;
            vel.y = 0;
            vel.z = 0;

            // Compute ledge grab phase (0→0.3 during grab pause)
            const grabPauseTime = 0.12;
            this.phase = Math.min(0.3, (this.grabTime / grabPauseTime) * 0.3);

            // Only allow cancel after minimum grab time
            const minGrabTime = 0.05;
            if (this.grabTime > minGrabTime) {
                const wishDir = vec3Normalize(input.direction);
                const pushingAway = vec3Dot(wishDir, this.wallNormal) > 0.5 && vec3LengthXZ(wishDir) > 0.1;

                if (input.isPressed(InputButtons.CROUCH) || input.isPressed(InputButtons.SPRINT) || pushingAway) {
                    this.state = 'none';
                    this.phase = 0;
                    vel.y = -100;
                    return false;
                }
            }

            // Auto-climb after brief pause
            if (this.grabTime >= grabPauseTime) {
                this.state = 'pulling';
                this.grabTime = 0;
            }

            return true;
        }

        // === STATE: PULLING (climbing animation) ===
        if (this.state === 'pulling') {
            this.grabTime += deltaTime;
            const pullTime = config.ledgePullTime;
            const progress = Math.min(1.0, this.grabTime / pullTime);

            // Ease in-out
            const t = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;

            // Compute ledge grab phase (0.3→1 during pull)
            this.phase = 0.3 + t * 0.7;

            // Interpolate position
            pos.x = this.startPos.x + (this.targetPos.x - this.startPos.x) * t;
            pos.y = this.startPos.y + (this.targetPos.y - this.startPos.y) * t;
            pos.z = this.startPos.z + (this.targetPos.z - this.startPos.z) * t;
            vel.x = 0;
            vel.y = 0;
            vel.z = 0;

            if (progress >= 1.0) {
                // Done climbing — cooldown prevents re-detection
                this.state = 'none';
                this.phase = 0;
                this.cooldownRemaining = 0.3;
                const forward = vec3Normalize(input.direction);
                vel.x = forward.x * 100;
                vel.y = 50;  // Small upward boost to clear ledge surface
                vel.z = forward.z * 100;
            }

            return true;
        }

        // === STATE: DETECTION ===
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

        // === TRACE 1: Check for wall at waist level ===
        const waistStart = { x: pos.x, y: eyeY - 16, z: pos.z };
        const waistEnd = vec3Add(waistStart, vec3Scale(forwardDir, reach));
        const waistTrace = collision.trace(waistStart, waistEnd);

        if (!waistTrace.hit || waistTrace.fraction >= 1.0) {
            return false;
        }

        // Store wall normal for cancel detection
        if (waistTrace.normal) {
            this.wallNormal = vec3Clone(waistTrace.normal);
        } else {
            this.wallNormal = { x: -forwardDir.x, y: 0, z: -forwardDir.z };
        }

        // === TRACE 2: Check if space is clear above eye level ===
        const headStart = { x: pos.x, y: eyeY + 8, z: pos.z };
        const headEnd = vec3Add(headStart, vec3Scale(forwardDir, reach));
        const headTrace = collision.trace(headStart, headEnd);

        if (headTrace.hit && headTrace.fraction < 0.9) {
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

        if (!ledgeTrace.normal || ledgeTrace.normal.y < 0.7) {
            return false;
        }

        // Calculate ledge surface Y position
        const ledgeSurfaceY = aboveLedgeStart.y - (aboveLedgeStart.y - aboveLedgeEnd.y) * ledgeTrace.fraction;
        const eyeToLedge = ledgeSurfaceY - eyeY;

        if (eyeToLedge < -16) return false;
        if (eyeToLedge > climbHeight) return false;

        // === TRACE 4: Verify room to stand on ledge ===
        const targetPos = {
            x: aboveLedgeStart.x,
            y: ledgeSurfaceY + 24 + 4,
            z: aboveLedgeStart.z
        };

        const standStart = { x: targetPos.x, y: targetPos.y, z: targetPos.z };
        const standEnd = { x: targetPos.x, y: targetPos.y + 32, z: targetPos.z };
        const standTrace = collision.trace(standStart, standEnd);

        if (standTrace.hit && standTrace.fraction < 0.8) {
            return false;
        }

        // === SUCCESS: Start grabbing! ===
        this.startGrab(targetPos, pos);
        return true;
    }

    /** Start the grab state */
    private startGrab(targetPos: Vec3, currentPos: Vec3): void {
        this.state = 'grabbing';
        this.grabTime = 0;
        this.startPos = vec3Clone(currentPos);
        this.targetPos = vec3Clone(targetPos);
    }
}
