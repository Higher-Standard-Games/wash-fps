/**
 * Dropped Weapon System
 * 
 * Manages weapons dropped by players (on swap or death).
 * Dropped weapons are EntityType.Item entities with position + metadata.
 * They can be picked up by other players and despawn after a timeout.
 * 
 * Physics: Server runs a simple ballistic arc (gravity + velocity).
 * Clients use Havok for visual physics but converge to server position.
 */

import type { EntityId, TickNumber } from '@shared/server/simulation/types';
import { entityId } from '@shared/server/simulation/types';
import type { WorldState } from '@engine/server/core/WorldState';
import type { SubsystemConfig } from '@engine/server/core/Subsystem';
import { Subsystem } from '@engine/server/core/Subsystem';
import { createDroppedWeaponEntity } from '@engine/server/ecs/Entity';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

/** Metadata for a dropped weapon entity */
interface DroppedWeaponMeta {
    entityId: EntityId;
    weaponId: string;
    ammo: number;
    spawnTick: number;
    /** Current velocity (zeroed once settled) */
    velocity: { x: number; y: number; z: number };
    /** Whether the weapon has landed and stopped moving */
    settled: boolean;
    /** Floor Y for this weapon (derived from spawn position) */
    floorY: number;
}

/** Request to spawn a dropped weapon */
export interface WeaponDropRequest {
    weaponId: string;
    ammo: number;
    position: { x: number; y: number; z: number };
    velocity?: { x: number; y: number; z: number };
}

/** Event emitted when a weapon is dropped (for client broadcast) */
export interface WeaponDropEvent {
    entityId: string;      // Network entity ID (e.g. 'item_50001')
    weaponId: string;
    x: number;
    y: number;
    z: number;
    velX: number;
    velY: number;
    velZ: number;
}

const CONFIG: SubsystemConfig = {
    name: 'DroppedWeapon',
    priority: 12,    // Before PickupSystem (15) so drops are visible for pickup same tick
    tickRate: 125,
};

/** Despawn time in seconds */
const DESPAWN_TIME = 15;

/** Server gravity for ballistic arc (units/s²) — matches game gravity */
const DROP_GRAVITY = 800;

/** Offset from player origin Y to estimate the floor Y (Q3: origin is 24 above feet) */
const PLAYER_ORIGIN_HEIGHT = 24;

/** Velocity magnitude below which we consider it settled */
const SETTLE_SPEED = 5;

/** Bounce coefficient (energy retained per bounce) */
const BOUNCE_COEFF = 0.3;

// ═══════════════════════════════════════════════════════════════════
// DROPPED WEAPON SYSTEM
// ═══════════════════════════════════════════════════════════════════

export class DroppedWeaponSystem extends Subsystem {
    /** Metadata for each dropped weapon entity */
    private droppedWeapons: Map<EntityId, DroppedWeaponMeta> = new Map();

    /** Pending drop requests (queued by WeaponSystem, consumed on tick) */
    private pendingDrops: WeaponDropRequest[] = [];

    /** Pending events for client broadcast */
    private pendingDropEvents: WeaponDropEvent[] = [];

    /** Next entity ID for dropped weapons */
    private nextDropId: number = 50001;

    /** Despawn time in ticks (computed from tick rate) */
    private despawnTicks: number;

    /** Seconds per tick */
    private dt: number;

    constructor() {
        super(CONFIG);
        this.despawnTicks = DESPAWN_TIME * CONFIG.tickRate;
        this.dt = 1 / CONFIG.tickRate;
    }

    // ────────────────────────────────────────────────────────────────
    // Public API
    // ────────────────────────────────────────────────────────────────

    /**
     * Queue a weapon drop (called by WeaponSystem when a weapon is swapped out or on death)
     */
    queueDrop(request: WeaponDropRequest): void {
        this.pendingDrops.push(request);
    }

    /**
     * Get pending drop events (consumed by GameServer for broadcast)
     */
    getPendingDropEvents(): WeaponDropEvent[] {
        const events = this.pendingDropEvents;
        this.pendingDropEvents = [];
        return events;
    }

    /**
     * Get metadata for a dropped weapon entity (used by PickupSystem)
     */
    getDroppedWeaponMeta(eId: EntityId): DroppedWeaponMeta | undefined {
        return this.droppedWeapons.get(eId);
    }

    /**
     * Remove a dropped weapon after it's been picked up
     */
    removeDroppedWeapon(eId: EntityId): void {
        this.droppedWeapons.delete(eId);
    }

    // ────────────────────────────────────────────────────────────────
    // Subsystem update
    // ────────────────────────────────────────────────────────────────

    update(state: WorldState, _dt: number, tick: TickNumber): void {
        const tickNum = tick as number;

        // 1. Process pending drops → spawn entities
        for (const drop of this.pendingDrops) {
            const vel = drop.velocity || { x: 0, y: 150, z: 0 };
            const id = entityId(this.nextDropId++);
            const entity = createDroppedWeaponEntity(id, drop.position, vel);
            state.addEntity(entity);

            // Use spawn position Y minus player origin height as floor reference
            // (since we don't have BSP collision on server, this ensures weapons settle
            // near where the player dropped them, not at Y=-500)
            const floorY = drop.position.y - PLAYER_ORIGIN_HEIGHT;
            const meta: DroppedWeaponMeta = {
                entityId: id,
                weaponId: drop.weaponId,
                ammo: drop.ammo,
                spawnTick: tickNum,
                velocity: { ...vel },
                settled: false,
                floorY,
            };
            this.droppedWeapons.set(id, meta);

            // Emit event for client (includes velocity for Havok toss)
            this.pendingDropEvents.push({
                entityId: `item_${id}`,
                weaponId: drop.weaponId,
                x: drop.position.x,
                y: drop.position.y,
                z: drop.position.z,
                velX: vel.x,
                velY: vel.y,
                velZ: vel.z,
            });

            console.log(`[DroppedWeaponSystem] Spawned ${drop.weaponId} at (${drop.position.x.toFixed(1)}, ${drop.position.y.toFixed(1)}, ${drop.position.z.toFixed(1)}) vel=(${vel.x.toFixed(0)}, ${vel.y.toFixed(0)}, ${vel.z.toFixed(0)})`);
        }
        this.pendingDrops = [];

        // 2. Tick ballistic arc for unsettled weapons
        for (const [eId, meta] of this.droppedWeapons) {
            if (meta.settled) continue;

            const entity = state.getEntity(eId);
            if (!entity?.transform) continue;

            const pos = entity.transform.position;
            const vel = meta.velocity;

            // Apply gravity
            vel.y -= DROP_GRAVITY * this.dt;

            // Move
            pos.x += vel.x * this.dt;
            pos.y += vel.y * this.dt;
            pos.z += vel.z * this.dt;

            // Simple floor collision — bounce or settle
            // TODO: use BSP collision for accurate floor detection
            if (pos.y <= meta.floorY) {
                pos.y = meta.floorY;
                if (Math.abs(vel.y) < SETTLE_SPEED * 3) {
                    // Settle
                    vel.x = 0; vel.y = 0; vel.z = 0;
                    meta.settled = true;
                } else {
                    // Bounce
                    vel.y = -vel.y * BOUNCE_COEFF;
                    vel.x *= BOUNCE_COEFF;
                    vel.z *= BOUNCE_COEFF;
                }
            }

            // Speed check — settle if moving very slowly
            const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
            if (speed < SETTLE_SPEED && pos.y <= meta.floorY + 1) {
                vel.x = 0; vel.y = 0; vel.z = 0;
                meta.settled = true;
            }

            // Update entity physics velocity for serialization
            if (entity.physics) {
                entity.physics.velocity = { ...vel };
            }
        }

        // 3. Despawn expired drops
        const entitiesToRemove: EntityId[] = [];
        for (const [eId, meta] of this.droppedWeapons) {
            if (tickNum - meta.spawnTick >= this.despawnTicks) {
                entitiesToRemove.push(eId);
            }
        }
        for (const eId of entitiesToRemove) {
            state.removeEntity(eId);
            this.droppedWeapons.delete(eId);
            console.log(`[DroppedWeaponSystem] Despawned entity ${eId} (timeout)`);
        }
    }
}
