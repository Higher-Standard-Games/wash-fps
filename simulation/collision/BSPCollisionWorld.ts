/**
 * BSPCollisionWorld - CollisionWorld implementation for BSP maps
 *
 * This adapter wraps the existing CollisionManager to provide collision
 * for the network simulation. Uses pure Vec3 interface (no Babylon deps in API).
 *
 * For client-side: Wraps CollisionManager singleton
 * For server-side: Could work with BspCollision directly (future)
 */

import type { Vec3 } from '../../../../engine/network/components/TransformComponent';
import type { CollisionWorld, TraceResult, AABB, StepSlideMoveResult } from '../../../../engine/network/systems/collision/CollisionWorld';
import { Contents } from '../../../../engine/network/systems/collision/CollisionWorld';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { getCollisionManager } from '../../../../engine/physics/CollisionManager';

/**
 * Convert network Vec3 to Babylon Vector3
 */
function toBabylon(v: Vec3): Vector3 {
    return new Vector3(v.x, v.y, v.z);
}

/**
 * Convert Babylon Vector3 to network Vec3
 */
function fromBabylon(v: Vector3): Vec3 {
    return { x: v.x, y: v.y, z: v.z };
}

/**
 * BSP-based collision world for FPS game
 *
 * Wraps the existing CollisionManager to provide collision detection
 * for the network simulation layer.
 */
export class BSPCollisionWorld implements CollisionWorld {
    // Player dimensions matching local physics constants
    private static readonly PLAYER_RADIUS = 16;
    private static readonly PLAYER_HEIGHT = 56;

    /**
     * Trace a ray from start to end
     */
    trace(start: Vec3, end: Vec3, bounds?: AABB): TraceResult {
        const cm = getCollisionManager();

        if (!cm.isInitialized()) {
            // No collision - return no hit
            return { hit: false, fraction: 1 };
        }

        const startV = toBabylon(start);
        const endV = toBabylon(end);

        // Use box trace if bounds provided, otherwise point trace
        const options = bounds
            ? {
                radius: (bounds.max.x - bounds.min.x) / 2,
                height: bounds.max.y - bounds.min.y,
            }
            : { radius: 0, height: 0 };

        const result = cm.trace(startV, endV, options);

        // Convert to network TraceResult
        return {
            hit: result.fraction < 1,
            fraction: result.fraction,
            hitPoint: result.endPos ? fromBabylon(result.endPos) : undefined,
            normal: result.normal ? fromBabylon(result.normal) : undefined,
            contents: result.contents ?? 0,
        };
    }

    /**
     * Q3-style step-slide move with full collision resolution.
     * Uses the same backend as local AdvancedCharacterController for consistent behavior.
     */
    stepSlideMove(start: Vec3, velocity: Vec3, deltaTime: number, _bounds: AABB): StepSlideMoveResult {
        const cm = getCollisionManager();

        if (!cm.isInitialized()) {
            // No collision - just apply velocity directly
            if (Math.random() < 0.01) {
                console.warn(`[BSPCollisionWorld] stepSlideMove: CollisionManager NOT initialized!`);
            }
            return {
                endPos: {
                    x: start.x + velocity.x * deltaTime,
                    y: start.y + velocity.y * deltaTime,
                    z: start.z + velocity.z * deltaTime
                },
                velocity: { ...velocity },
                grounded: false
            };
        }

        // Calculate movement vector (same as local: velocity.scale(deltaTime))
        const movement = toBabylon(velocity).scale(deltaTime);
        const startPos = toBabylon(start);

        // Get the Q3 backend (same as local AdvancedCharacterController)
        const backend = (cm as any).backends?.get('q3');

        if (backend && typeof backend.stepSlideMove === 'function') {
            // Use exact same call as local: backend.stepSlideMove(position, movement, traceOpts)
            const traceOpts = {
                radius: BSPCollisionWorld.PLAYER_RADIUS,
                height: BSPCollisionWorld.PLAYER_HEIGHT
            };
            const result = backend.stepSlideMove(startPos.clone(), movement, traceOpts);

            // Check if grounded after move (same as local checkGrounded)
            const groundCheckEnd = result.endPos.add(new Vector3(0, -2, 0));
            const groundTrace = backend.trace(result.endPos.clone(), groundCheckEnd, traceOpts);
            const grounded = groundTrace.fraction < 1.0;

            // CRITICAL: Backend returns clipped MOVEMENT delta, not velocity!
            // Convert back to velocity (units/sec) by dividing by deltaTime.
            // This matches HeadlessBSPCollisionWorld (server) behavior exactly.
            const clippedVelocity = deltaTime > 0
                ? fromBabylon(result.velocity.scale(1 / deltaTime))
                : { x: 0, y: 0, z: 0 };

            return {
                endPos: fromBabylon(result.endPos),
                velocity: clippedVelocity, // Properly clipped velocity from collision
                grounded
            };
        }

        // Fallback: simple move without collision
        if (Math.random() < 0.01) {
            console.warn(`[BSPCollisionWorld] stepSlideMove: Q3 backend NOT available! Falling back to no-collision move. backends=${(cm as any).backends ? 'exists' : 'undefined'}`);
        }
        return {
            endPos: {
                x: start.x + velocity.x * deltaTime,
                y: start.y + velocity.y * deltaTime,
                z: start.z + velocity.z * deltaTime
            },
            velocity: { ...velocity },
            grounded: false
        };
    }

    /**
     * Check contents at a point
     */
    pointContents(point: Vec3): number {
        const cm = getCollisionManager();

        if (!cm.isInitialized()) {
            return Contents.EMPTY;
        }

        const pointV = toBabylon(point);
        return cm.pointContents(pointV);
    }

    /**
     * Find entities in radius (not implemented yet)
     */
    findEntitiesInRadius(_center: Vec3, _radius: number): string[] {
        // TODO: Implement entity query
        // For now, entities are managed separately from BSP
        return [];
    }

    /**
     * Get world bounds
     */
    getWorldBounds(): AABB {
        // TODO: Get from BSP file bounds
        return {
            min: { x: -8192, y: -8192, z: -8192 },
            max: { x: 8192, y: 8192, z: 8192 },
        };
    }
}
