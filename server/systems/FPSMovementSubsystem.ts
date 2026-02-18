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
import type { TickNumber, EntityId } from '../../../../engine/server/ecs/types';
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
    transform: { position: { x: number; y: number; z: number }; rotation?: { x: number; y: number; z: number } },
    physics: any,
    result: any,
    input?: { pitch: number; yaw: number },
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

    // Sync player rotation so remote clients can orient the model
    if (input && transform.rotation) {
        transform.rotation.x = input.pitch;
        transform.rotation.y = input.yaw;
    }
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

    /**
     * Reset grounded state for an entity (called by CombatSystem after knockback
     * so friction doesn't eat the impulse on the next movement tick)
     */
    resetGroundedState(entityId: number, grounded: boolean): void {
        this.getProfile(entityId).resetPhysicsState(grounded);
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
                applyResult(transform, physics, result, input);
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
                    applyResult(transform, physics, result, input);
                }
                // Clear queue after processing
                input.inputQueue = [];
            }
        }

        // After all movement: push overlapping players apart (Q3-style)
        this.separatePlayers(state);
    }

    // ────────────────────────────────────────────────────────────────
    // Player-vs-player collision (post-movement separation)
    // ────────────────────────────────────────────────────────────────

    /** Player cylinder radius for entity-entity blocking */
    private static readonly PLAYER_RADIUS = 16;
    /** Combined radius: two players touching */
    private static readonly SEPARATION_DIST = FPSMovementSubsystem.PLAYER_RADIUS * 2; // 32
    /** Player bounds Y: origin at waist, -24 feet to +32 head */
    private static readonly PLAYER_MIN_Y = -24;
    private static readonly PLAYER_MAX_Y = 32;

    /**
     * Block overlapping players without pushing — Q3-style entity blocking.
     * Each entity is independently pushed back from all others it overlaps.
     * Uses immutable position snapshots so iteration order doesn't matter.
     */
    private separatePlayers(state: WorldState): void {
        const players: { id: EntityId; x: number; y: number; z: number }[] = [];
        for (const entity of state.entitiesByType(EntityType.Player)) {
            if (!entity.transform || entity.health?.dead) continue;
            // Snapshot positions (immutable during resolution)
            players.push({
                id: entity.id,
                x: entity.transform.position.x,
                y: entity.transform.position.y,
                z: entity.transform.position.z,
            });
        }

        const sepDist = FPSMovementSubsystem.SEPARATION_DIST;
        const sepDistSq = sepDist * sepDist;

        // For each entity, resolve against all others independently
        for (let i = 0; i < players.length; i++) {
            const me = players[i];
            let pushX = 0;
            let pushZ = 0;

            for (let j = 0; j < players.length; j++) {
                if (i === j) continue;
                const other = players[j];

                // Y overlap check (cylinder)
                const meBottom = me.y + FPSMovementSubsystem.PLAYER_MIN_Y;
                const meTop = me.y + FPSMovementSubsystem.PLAYER_MAX_Y;
                const otherBottom = other.y + FPSMovementSubsystem.PLAYER_MIN_Y;
                const otherTop = other.y + FPSMovementSubsystem.PLAYER_MAX_Y;
                if (meTop <= otherBottom || otherTop <= meBottom) continue;

                // XZ distance
                const dx = me.x - other.x;
                const dz = me.z - other.z;
                const distSq = dx * dx + dz * dz;
                if (distSq >= sepDistSq) continue;

                const dist = Math.sqrt(distSq);
                const overlap = sepDist - dist;

                if (dist > 0.001) {
                    const nx = dx / dist;
                    const nz = dz / dist;
                    pushX += nx * overlap;
                    pushZ += nz * overlap;
                } else {
                    // Exactly overlapping — push in arbitrary direction
                    pushX += overlap;
                }
            }

            // Apply accumulated push to this entity only
            if (pushX !== 0 || pushZ !== 0) {
                const mut = state.getEntityMut(me.id);
                if (mut?.transform) {
                    mut.transform.position.x += pushX;
                    mut.transform.position.z += pushZ;
                }
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
