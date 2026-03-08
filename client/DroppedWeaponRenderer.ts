/**
 * DroppedWeaponRenderer — Thin adapter that creates Pickup instances for dropped weapons.
 *
 * On `weapon_drop` events: creates a Pickup with velocity (toss arc).
 * On pickup/despawn: disposes the Pickup.
 * On each frame: syncs settled pickups to server-authoritative position.
 *
 * All visual, physics, and interaction logic lives in Pickup.
 */

import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Pickup } from '../../../engine/game/Pickup';
import { EntityRegistry } from '../../../shared/entities/EntityRegistry';

/** Lerp factor for converging to server position after settle */
const SERVER_LERP = 0.15;

export class DroppedWeaponRenderer {
    private scene: Scene;
    private weapons: Map<string, Pickup> = new Map();

    constructor(scene: Scene) {
        this.scene = scene;
    }

    // ── Public API ──────────────────────────────────────────────────

    /**
     * Spawn a dropped weapon visual at the given position with toss velocity.
     * Called when a `weapon_drop` event is received from the server.
     */
    spawn(entityId: string, weaponId: string, position: Vector3, velocity: Vector3, ammoCount?: number): void {
        // Don't double-spawn
        if (this.weapons.has(entityId)) return;

        // Look up model path from EntityRegistry
        const registry = EntityRegistry.getInstance();
        const def = registry.get(weaponId) as any;
        const modelPath = def?.modelPath
            || `models/weapons/${weaponId}/${weaponId}.md3`;
        const defScale = def?.scale ?? 1.5;

        // Create a Pickup with velocity (toss arc) and no respawn
        const pickup = new Pickup(`dropped_${entityId}`, this.scene, position, {
            id: weaponId,
            entityId,
            modelPath,
            type: 'weapon',
            value: weaponId,
            scale: defScale,
            velocity, // Toss arc — Havok applies this as initial linear velocity
            respawnTime: 0, // No respawn — server controls removal
            ammoCount, // Carry remaining ammo count from dropping player
        });

        this.weapons.set(entityId, pickup);
        console.log(`[DroppedWeaponRenderer] Spawned ${weaponId} at ${position} via Pickup`);
    }

    /**
     * Remove a dropped weapon (on pickup or despawn).
     */
    remove(entityId: string): void {
        const pickup = this.weapons.get(entityId);
        if (!pickup) return;

        pickup.dispose();
        this.weapons.delete(entityId);
    }

    /**
     * Sync with server entity positions.
     * Called each frame with the set of known item_ entity IDs and positions.
     */
    syncServerEntities(entities: Map<string, { x: number; y: number; z: number }>): void {
        // Remove weapons that server no longer sends (picked up or despawned)
        const toRemove: string[] = [];
        for (const [entityId] of this.weapons) {
            if (!entities.has(entityId)) {
                toRemove.push(entityId);
            }
        }
        for (const entityId of toRemove) {
            this.remove(entityId);
        }

        // Converge settled pickups to server position
        for (const [entityId, pickup] of this.weapons) {
            if (!pickup.settled) continue;

            const serverPos = entities.get(entityId);
            if (!serverPos) continue;

            pickup.lerpToPosition(new Vector3(serverPos.x, serverPos.y, serverPos.z), SERVER_LERP);
        }
    }

    /**
     * Check if a dropped weapon entity is tracked.
     */
    has(entityId: string): boolean {
        return this.weapons.has(entityId);
    }

    /**
     * Get count of active dropped weapons (for debug).
     */
    get count(): number {
        return this.weapons.size;
    }

    /**
     * Dispose all weapons.
     */
    dispose(): void {
        for (const [entityId] of this.weapons) {
            this.remove(entityId);
        }
    }
}
