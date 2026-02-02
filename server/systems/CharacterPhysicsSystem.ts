/**
 * Character Physics System
 * Q3/Warsow style movement - works for FPS & 3rd person
 * 
 * Supports optional CollisionWorld for BSP collision.
 * Without collision, uses simple velocity integration.
 */

import { Subsystem, type SubsystemConfig } from '@engine/server/core/Subsystem';
import type { WorldState } from '@engine/server/core/WorldState';
import type { TickNumber } from '@engine/server/ecs/types';
import { EntityType } from '@engine/server/ecs/types';
import {
    moveGround,
    moveAir,
    applyGravity,
    applyJump,
    calculateWishDir,
} from '@shared/server/simulation/physics/movement';
import { MAX_GROUND_SPEED } from '@shared/server/simulation/physics/constants';
import type { CollisionWorld, AABB } from '../../../../engine/network/systems/collision/CollisionWorld';

const CONFIG: SubsystemConfig = {
    name: 'CharacterPhysics',
    priority: 10,
    tickRate: 125,
};

// Default player bounds (Q3-style: origin at waist, 24 units above feet)
// CRITICAL: Must match FPSMovementProfile.PLAYER_BOUNDS exactly!
// Total height = 56 units: 24 below origin (to feet) + 32 above (to head)
const PLAYER_BOUNDS: AABB = {
    min: { x: -16, y: -24, z: -16 },  // Feet 24 units BELOW origin
    max: { x: 16, y: 32, z: 16 },     // Head 32 units ABOVE origin
};

export class CharacterPhysicsSystem extends Subsystem {
    private collisionWorld: CollisionWorld | null = null;

    constructor(collisionWorld?: CollisionWorld) {
        super(CONFIG);
        this.collisionWorld = collisionWorld ?? null;
    }

    /**
     * Set the collision world (e.g., after BSP load)
     */
    setCollisionWorld(world: CollisionWorld | null): void {
        this.collisionWorld = world;
    }

    update(state: WorldState, dt: number, _tick: TickNumber): void {
        // Process all player entities
        for (const entity of state.entitiesByType(EntityType.Player)) {
            if (!entity.transform || !entity.physics || !entity.input) continue;
            if (entity.health?.dead) continue;

            // Get mutable entity (COW)
            const mutable = state.getEntityMut(entity.id);
            if (!mutable || !mutable.transform || !mutable.physics || !mutable.input) continue;

            const input = mutable.input;
            const physics = mutable.physics;
            const transform = mutable.transform;

            // Calculate wish direction from input
            const wishDir = calculateWishDir(input.forward, input.right, input.yaw);
            const wishSpeed = MAX_GROUND_SPEED;

            // Apply movement based on ground state
            if (physics.grounded) {
                // Jump check
                if (input.jump && !physics.jumping) {
                    physics.velocity = applyJump(physics.velocity);
                    physics.grounded = false;
                    physics.jumping = true;
                } else {
                    physics.velocity = moveGround(physics.velocity, wishDir, wishSpeed, dt);
                }
            } else {
                // Air movement
                physics.velocity = moveAir(physics.velocity, wishDir, wishSpeed, dt);
                physics.velocity = applyGravity(physics.velocity, dt);
            }

            // Reset jumping flag when jump released
            if (!input.jump) {
                physics.jumping = false;
            }

            // Apply velocity to position with collision
            if (this.collisionWorld) {
                // Use proper Q3-style stepSlideMove
                const result = this.collisionWorld.stepSlideMove(
                    transform.position,
                    physics.velocity,
                    dt,
                    PLAYER_BOUNDS
                );

                transform.position = result.endPos;
                physics.velocity = result.velocity;
                physics.grounded = result.grounded;
            } else {
                // No collision - simple integration (for testing)
                transform.position = {
                    x: transform.position.x + physics.velocity.x * dt,
                    y: transform.position.y + physics.velocity.y * dt,
                    z: transform.position.z + physics.velocity.z * dt,
                };

                // Simple floor at Y=0 for testing
                if (transform.position.y < 0) {
                    transform.position.y = 0;
                    if (physics.velocity.y < 0) physics.velocity.y = 0;
                    physics.grounded = true;
                }
            }
        }
    }
}
