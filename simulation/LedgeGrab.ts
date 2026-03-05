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
import { vec3Zero, vec3Clone, vec3Add, vec3Scale, vec3Normalize } from './Vec3Helpers';

export class LedgeGrab {
    state: 'none' | 'grabbing' | 'pulling' = 'none';
    phase: number = 0;  // Camera phase (0-1)

    private grabTime: number = 0;
    private cooldownRemaining: number = 0;
    private targetPos: Vec3 = vec3Zero();
    private startPos: Vec3 = vec3Zero();

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

            // Only allow cancel after minimum grab time (only crouch cancels)
            const minGrabTime = 0.05;
            if (this.grabTime > minGrabTime) {
                if (input.isPressed(InputButtons.CROUCH)) {
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
                vel.x = forward.x * 50;
                vel.y = 0;   // No upward boost — targetPos already has Y clearance
                vel.z = forward.z * 50;
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

        // === MULTI-DIRECTION WALL PROBE ===
        // Fan out ±30° and ±60° from forward to catch angled ledges (45° walls etc.)
        const cos30 = 0.866, sin30 = 0.5;
        const cos60 = 0.5, sin60 = 0.866;
        const probeDirections = [
            forwardDir,
            { x: forwardDir.x * cos30 - forwardDir.z * sin30, y: 0, z: forwardDir.x * sin30 + forwardDir.z * cos30 },
            { x: forwardDir.x * cos30 + forwardDir.z * sin30, y: 0, z: -forwardDir.x * sin30 + forwardDir.z * cos30 },
            { x: forwardDir.x * cos60 - forwardDir.z * sin60, y: 0, z: forwardDir.x * sin60 + forwardDir.z * cos60 },
            { x: forwardDir.x * cos60 + forwardDir.z * sin60, y: 0, z: -forwardDir.x * sin60 + forwardDir.z * cos60 },
        ];

        // Find the closest wall across all probe directions
        let bestWaistTrace: ReturnType<typeof collision.trace> | null = null;
        let bestProbeDir = forwardDir;
        let bestFraction = 1.0;

        for (const probeDir of probeDirections) {
            // === TRACE 1: Check for wall at waist level ===
            const waistStart = { x: pos.x, y: eyeY - 16, z: pos.z };
            const waistEnd = vec3Add(waistStart, vec3Scale(probeDir, reach));
            const waistTrace = collision.trace(waistStart, waistEnd);

            if (waistTrace.hit && waistTrace.fraction < 1.0 && waistTrace.fraction < bestFraction) {
                // === TRACE 2: Check if space is clear above eye level ===
                const headStart = { x: pos.x, y: eyeY + 8, z: pos.z };
                const headEnd = vec3Add(headStart, vec3Scale(probeDir, reach));
                const headTrace = collision.trace(headStart, headEnd);

                if (!headTrace.hit || headTrace.fraction >= 0.9) {
                    bestWaistTrace = waistTrace;
                    bestProbeDir = probeDir;
                    bestFraction = waistTrace.fraction;
                }
            }
        }

        if (!bestWaistTrace) {
            return false;
        }

        // === TRACE 3: Find ledge surface by tracing down from above ===
        // Use the best probe direction (may be angled for 45° walls)
        const aboveLedgeStart = vec3Add({ x: pos.x, y: eyeY, z: pos.z }, vec3Scale(bestProbeDir, reach * 0.7));
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
        // IMPORTANT: Use the wall normal to offset the target X,Z AWAY from the wall face.
        // Previously, targetPos used aboveLedgeStart.x/z which pushes the player
        // forward into/past the wall → player gets stuck inside geometry after pull.
        const wallNormal = bestWaistTrace.normal || { x: -bestProbeDir.x, y: 0, z: -bestProbeDir.z };
        const targetPos = {
            x: pos.x + bestProbeDir.x * (reach * 0.3) + wallNormal.x * 2,
            y: ledgeSurfaceY + 24 + 8,
            z: pos.z + bestProbeDir.z * (reach * 0.3) + wallNormal.z * 2,
        };

        // === TRACE 4: Verify player hull fits at target position ===
        // Use full player bounding box — point traces miss corners where the
        // center is clear but the 32×64 hull clips adjacent walls.
        const playerBounds = {
            min: { x: -16, y: -24, z: -16 },
            max: { x: 16, y: 32, z: 16 },
        };
        const solidCheck = collision.trace(targetPos, targetPos, playerBounds);
        if (solidCheck.hit && solidCheck.fraction < 1.0) {
            return false;
        }

        // === TRACE 5: Verify vertical clearance for pull-up path ===
        // Trace full player hull upward from current position to target height.
        // Prevents climbing through ceilings or into tight overhangs.
        const ceilingStart = { x: pos.x, y: pos.y, z: pos.z };
        const ceilingEnd = { x: pos.x, y: targetPos.y + 16, z: pos.z };
        const ceilingTrace = collision.trace(ceilingStart, ceilingEnd, playerBounds);

        if (ceilingTrace.hit && ceilingTrace.fraction < 0.9) {
            return false;
        }

        // === TRACE 6: Verify standing room above target with full hull ===
        const standStart = { x: targetPos.x, y: targetPos.y, z: targetPos.z };
        const standEnd = { x: targetPos.x, y: targetPos.y + 32, z: targetPos.z };
        const standTrace = collision.trace(standStart, standEnd, playerBounds);

        if (standTrace.hit && standTrace.fraction < 0.8) {
            return false;
        }

        // === SUCCESS: Start grabbing! ===
        this.startGrab(targetPos, pos);

        // Immediately freeze position and velocity on detection tick
        // (grab handler freezes on subsequent ticks, but we need frame 0 clean too)
        vel.x = 0;
        vel.y = 0;
        vel.z = 0;

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
