/**
 * FPSMovementSubsystem - Uses FPSMovementProfile for server-side physics
 * 
 * This ensures physics parity between client and server by using
 * the EXACT same movement code (FPSMovementProfile).
 * 
 * Replaces the simpler CharacterPhysicsSystem.
 */

import { Subsystem, type SubsystemConfig } from '../../../../engine/server/core/Subsystem';
import type { WorldState } from '../../../../engine/server/core/WorldState';
import type { TickNumber } from '../../../../engine/server/ecs/types';
import { EntityType } from '../../../../engine/server/ecs/types';
import { FPSMovementProfile } from '../../simulation/FPSMovementProfile';
import type { MovementInput } from '../../../../engine/network/systems/movement/MovementProfile';
import type { CollisionWorld } from '../../../../engine/network/systems/collision/CollisionWorld';

const CONFIG: SubsystemConfig = {
    name: 'FPSMovement',
    priority: 10,
    tickRate: 125,
};

/**
 * Adapts server InputComponent to FPSMovementProfile's MovementInput
 * 
 * Uses the stored buttons bitmask directly so ALL button flags
 * (including SPRINT) are correctly passed through to simulate().
 */
function adaptInput(input: {
    forward: number;  // World-space Z component (= direction.z from client)
    right: number;    // World-space X component (= direction.x from client)
    pitch: number;
    yaw: number;
    buttons: number;  // Raw button bitmask from client
}): MovementInput {
    // Server receives world-space direction from client:
    // input.forward = command.direction.z
    // input.right = command.direction.x
    // These are ALREADY rotated by yaw on the client, so use them directly
    const wishX = input.right;   // X component of world-space wish direction
    const wishZ = input.forward; // Z component of world-space wish direction

    // Use the stored buttons bitmask directly — preserves SPRINT and all flags
    const buttons = input.buttons;

    return {
        direction: { x: wishX, y: 0, z: wishZ },
        viewAngles: { pitch: input.pitch, yaw: input.yaw },
        buttons,
        isPressed: (button: number) => (buttons & button) !== 0,
    };
}

/** Apply movement simulation result to entity transform and physics */
function applyResult(
    transform: { position: { x: number; y: number; z: number } },
    physics: any,
    result: any
): void {
    transform.position = result.position;
    physics.velocity = result.velocity;
    physics.grounded = result.grounded;
    physics.isSliding = result.isSliding;
    physics.isCrouching = result.isCrouching;
    physics.crouchViewOffset = result.crouchViewOffset ?? 0;
    physics.wallJumpState = result.wallJumpState ?? 'none';
    physics.ledgeGrabState = result.ledgeGrabState ?? 'none';
    physics.actualHorizSpeed = result.actualHorizSpeed ?? 0;
}

export class FPSMovementSubsystem extends Subsystem {
    private collisionWorld: CollisionWorld | null = null;

    // Per-entity movement profiles (each has its own state)
    private movementProfiles: Map<number, FPSMovementProfile> = new Map();

    constructor(collisionWorld?: CollisionWorld) {
        super(CONFIG);
        this.collisionWorld = collisionWorld ?? null;
    }

    /**
     * Set the collision world (e.g., after BSP load)
     */
    setCollisionWorld(world: CollisionWorld | null): void {
        this.collisionWorld = world;
        console.log(`[FPSMovementSubsystem] Collision world set: ${world ? 'yes' : 'no'}`);
    }

    /**
     * Get the current collision world
     */
    getCollisionWorld(): CollisionWorld | null {
        return this.collisionWorld;
    }

    /**
     * Get or create movement profile for an entity
     */
    private getProfile(entityId: number): FPSMovementProfile {
        let profile = this.movementProfiles.get(entityId);
        if (!profile) {
            profile = new FPSMovementProfile();
            this.movementProfiles.set(entityId, profile);
        }
        return profile;
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

            // Get movement profile for this entity
            const profile = this.getProfile(entity.id);

            const queue = input.inputQueue;
            if (queue.length === 0) {
                // No new inputs — simulate with current input state
                // (keeps physics running for gravity/momentum)
                const movementInput = adaptInput(input);
                const result = profile.simulate(
                    transform.position, physics.velocity,
                    movementInput, dt, this.collisionWorld
                );
                applyResult(transform, physics, result);
            } else {
                // Process ALL queued inputs — one simulate() per input
                // This matches client-side prediction which ran one simulate per input
                for (const qi of queue) {
                    // Update current input state from queued input
                    input.forward = qi.forward;
                    input.right = qi.right;
                    input.pitch = qi.pitch;
                    input.yaw = qi.yaw;
                    input.buttons = qi.buttons;
                    input.sequence = qi.sequence;

                    const movementInput = adaptInput(input);
                    const result = profile.simulate(
                        transform.position, physics.velocity,
                        movementInput, dt, this.collisionWorld
                    );
                    applyResult(transform, physics, result);
                }
                // Clear queue after processing
                input.inputQueue = [];
            }
        }
    }

    /**
     * Clean up profiles for disconnected entities
     */
    removeEntity(entityId: number): void {
        this.movementProfiles.delete(entityId);
    }
}

