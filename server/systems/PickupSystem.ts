/**
 * Pickup System
 * 
 * Server-authoritative item/weapon pickup system.
 * Detects player proximity to pickup items and handles acquisition.
 * 
 * Design:
 *   - Reads weapon entity positions from BSP data
 *   - Each tick, checks if any player is near an active pickup
 *   - When player presses USE (F key) near a weapon pickup, adds it to inventory
 *   - Handles respawn timers (pickup reappears after N seconds)
 *   - Emits pickup events for client-side sync
 */

import { Subsystem, type SubsystemConfig } from '@engine/server/core/Subsystem';
import type { WorldState } from '@engine/server/core/WorldState';
import type { TickNumber, EntityId } from '@engine/server/ecs/types';
import { EntityType } from '@engine/server/ecs/types';
import type { WeaponSystem } from './WeaponSystem';
import type { DroppedWeaponSystem } from './DroppedWeaponSystem';

/** Check if a weapon ID is a permanent default weapon (blade/gunblade) */
function isDefaultWeapon(w: string): boolean {
    return w === 'blade' || w === 'gunblade';
}

/** Must match InputButtons.USE from engine/network/components/InputComponent.ts */
const USE_BUTTON = 1 << 11;

/** Classname → weapon ID mapping (BSP entity classnames to game weapon IDs) */
const CLASSNAME_TO_WEAPON: Record<string, string> = {
    'weapon_gunblade': 'gunblade',
    'weapon_machinegun': 'machinegun',
    'weapon_riotgun': 'riotgun',
    'weapon_grenadelauncher': 'glauncher',
    'weapon_rocketlauncher': 'rlauncher',
    'weapon_plasmagun': 'plasmagun',
    'weapon_voltaic': 'voltaic',
    'weapon_lasergun': 'voltaic',       // Backward compat alias
    'weapon_electrobolt': 'electrobolt',
    'weapon_instagun': 'instagun',
};

/** A pickup item on the map */
interface PickupItem {
    id: number;
    weaponId: string;          // Game weapon ID (e.g. 'rlauncher')
    classname: string;         // BSP classname (e.g. 'weapon_rocketlauncher')
    position: { x: number; y: number; z: number };
    active: boolean;           // Whether it can be picked up
    respawnTick: number;       // Tick when it respawns (0 = active)
}

/** Event emitted when a pickup is taken */
export interface PickupEvent {
    pickupId: number;
    weaponId: string;
    entityId: EntityId;        // Player who picked it up
    droppedWeaponId?: string;  // Weapon that was dropped (if any)
    x: number;
    y: number;
    z: number;
}

const CONFIG: SubsystemConfig = {
    name: 'Pickup',
    priority: 15,    // Before weapon system (20), so pickups are processed first
    tickRate: 125,
};

// ═══════════════════════════════════════════════════════════════════
// PICKUP SYSTEM
// ═══════════════════════════════════════════════════════════════════

export class PickupSystem extends Subsystem {
    private pickups: PickupItem[] = [];
    private pendingPickupEvents: PickupEvent[] = [];
    private weaponSystem: WeaponSystem | null = null;
    private droppedWeaponSystem: DroppedWeaponSystem | null = null;
    private respawnTicks: number = 25 * 125; // 25 seconds at 125Hz (default)

    // Pickup detection parameters (matching client-side Pickup.ts)

    private readonly PICKUP_RADIUS_SQ = 128 * 128;
    private readonly VERTICAL_RANGE_MIN = -48;
    private readonly VERTICAL_RANGE_MAX = 96;

    // Track USE button edge detection per player (prevent multi-pickup)
    private useButtonPrev: Map<EntityId, boolean> = new Map();

    constructor() {
        super(CONFIG);
    }

    /**
     * Set reference to WeaponSystem for inventory management
     */
    setWeaponSystem(ws: WeaponSystem): void {
        this.weaponSystem = ws;
    }

    /**
     * Set reference to DroppedWeaponSystem for picking up dropped weapons
     */
    setDroppedWeaponSystem(dws: DroppedWeaponSystem): void {
        this.droppedWeaponSystem = dws;
    }

    /**
     * Set pickup respawn time in seconds
     */
    setRespawnTime(seconds: number): void {
        this.respawnTicks = Math.floor(seconds * 125);

    }

    /**
     * Register pickup items from BSP entity data.
     * Called during server initialization after BSP loading.
     */
    setPickupItems(items: Array<{ classname: string; position: { x: number; y: number; z: number } }>): void {
        this.pickups = [];
        let id = 0;

        for (const item of items) {
            const weaponId = CLASSNAME_TO_WEAPON[item.classname];
            if (!weaponId) {

                continue;
            }

            this.pickups.push({
                id: id++,
                weaponId,
                classname: item.classname,
                position: { ...item.position },
                active: true,
                respawnTick: 0,
            });
        }


    }

    /**
     * Get pending pickup events (consumed by GameServer for broadcast)
     */
    getPendingPickupEvents(): PickupEvent[] {
        const events = this.pendingPickupEvents;
        this.pendingPickupEvents = [];
        return events;
    }

    /**
     * Get all currently inactive pickups (for initial state sync when a client joins).
     * Returns pickup events so the client can deactivate visuals for already-consumed pickups.
     */
    getInactivePickups(): PickupEvent[] {
        const events: PickupEvent[] = [];
        for (const pickup of this.pickups) {
            if (!pickup.active) {
                events.push({
                    pickupId: pickup.id,
                    weaponId: pickup.weaponId,
                    entityId: 0 as any, // Not relevant for initial state
                    x: pickup.position.x,
                    y: pickup.position.y,
                    z: pickup.position.z,
                });
            }
        }
        return events;
    }

    update(state: WorldState, _dt: number, tick: TickNumber): void {
        const tickNum = tick as number;

        // Handle respawn timers
        for (const pickup of this.pickups) {
            if (!pickup.active && pickup.respawnTick > 0 && tickNum >= pickup.respawnTick) {
                pickup.active = true;
                pickup.respawnTick = 0;

            }
        }

        // Check each player against each active pickup
        for (const player of state.entitiesByType(EntityType.Player)) {
            if (!player.transform || !player.input || !player.health || player.health.dead) continue;

            const px = player.transform.position.x;
            const py = player.transform.position.y;
            const pz = player.transform.position.z;

            // Edge-detect USE button (only trigger on press, not hold)
            const usePressed = (player.input.buttons & USE_BUTTON) !== 0;
            const wasPressing = this.useButtonPrev.get(player.id) || false;
            this.useButtonPrev.set(player.id, usePressed);
            const useJustPressed = usePressed && !wasPressing;

            let pickedUpThisTick = false;

            for (const pickup of this.pickups) {
                if (!pickup.active) continue;

                // Cylindrical proximity check (matching client-side logic)
                const dx = px - pickup.position.x;
                const dz = pz - pickup.position.z;
                const dy = py - pickup.position.y;

                const horizDistSq = dx * dx + dz * dz;
                const inRange = horizDistSq < this.PICKUP_RADIUS_SQ
                    && dy > this.VERTICAL_RANGE_MIN
                    && dy < this.VERTICAL_RANGE_MAX;

                if (!inRange) continue;

                if (!this.weaponSystem) continue;

                const playerWeapons = this.weaponSystem.getWeapons(player.id);
                const nonDefaultCount = playerWeapons.filter(w => !isDefaultWeapon(w)).length;
                const alreadyHasWeapon = playerWeapons.includes(pickup.weaponId);
                const hasRoom = nonDefaultCount < 2;

                // Auto-pickup if: player has room OR already owns weapon (ammo pickup)
                // Require USE key only for weapon swap (at capacity + new weapon)
                if (!hasRoom && !alreadyHasWeapon && !useJustPressed) continue;

                // Try to add weapon to player's inventory
                const result = this.weaponSystem.addWeapon(player.id, pickup.weaponId);

                // addWeapon returns added=false for BOTH "already owned (ammo given)" AND "can't swap (holding default weapon)"
                // Only consume pickup if weapon was added or ammo was given (player already had it)
                if (!result.added && !alreadyHasWeapon) {
                    // Swap failed (e.g., holding default weapon at capacity) — don't consume the pickup
                    continue;
                }

                // Deactivate pickup and start respawn timer
                pickup.active = false;
                pickup.respawnTick = tickNum + this.respawnTicks;



                // Emit event for client sync
                this.pendingPickupEvents.push({
                    pickupId: pickup.id,
                    weaponId: pickup.weaponId,
                    entityId: player.id,
                    droppedWeaponId: result.dropped,
                    x: pickup.position.x,
                    y: pickup.position.y,
                    z: pickup.position.z,
                });

                // Only pick up one weapon per tick
                pickedUpThisTick = true;
                break;
            }

            // Check dropped weapons (EntityType.Item)
            // Skip if a static pickup already happened this tick (one pickup per tick)
            // Auto-pickup when player has room, require USE key when at capacity
            if (!pickedUpThisTick && this.droppedWeaponSystem) {
                for (const itemEntity of state.entitiesByType(EntityType.Item)) {
                    if (!itemEntity.transform) continue;

                    const dx = px - itemEntity.transform.position.x;
                    const dz = pz - itemEntity.transform.position.z;
                    const dy = py - itemEntity.transform.position.y;

                    const horizDistSq = dx * dx + dz * dz;
                    // Slightly wider vertical range for dropped weapons
                    // (server ballistic sim may have minor Y drift from real floor)
                    const inRange = horizDistSq < this.PICKUP_RADIUS_SQ
                        && dy > -96
                        && dy < 128;

                    if (!inRange) continue;
                    if (!this.weaponSystem) continue;

                    const meta = this.droppedWeaponSystem.getDroppedWeaponMeta(itemEntity.id);
                    if (!meta) continue;

                    // Check inventory capacity for pickup gating
                    const playerWeapons = this.weaponSystem.getWeapons(player.id);
                    const nonDefaultCount = playerWeapons.filter(w => !isDefaultWeapon(w)).length;
                    const alreadyHasWeapon = playerWeapons.includes(meta.weaponId);
                    const hasRoom = nonDefaultCount < 2;

                    // Auto-pickup if: player has room OR already owns weapon (ammo pickup)
                    // Require USE key only for weapon swap (at capacity + new weapon)
                    if (!hasRoom && !alreadyHasWeapon && !useJustPressed) continue;

                    // Add weapon to player's inventory
                    const result = this.weaponSystem.addWeapon(player.id, meta.weaponId);

                    // Transfer dropped weapon's remaining ammo (ADD to existing, don't overwrite)
                    if (meta.ammo > 0) {
                        const currentAmmo = this.weaponSystem.getAmmo(player.id, meta.weaponId);
                        this.weaponSystem.setAmmo(player.id, meta.weaponId, currentAmmo + meta.ammo);
                    }

                    // Always remove from world — even if weapon wasn't added (ammo was given)
                    state.removeEntity(itemEntity.id);
                    this.droppedWeaponSystem.removeDroppedWeapon(itemEntity.id);



                    // Emit event
                    this.pendingPickupEvents.push({
                        pickupId: -1, // Negative ID = dropped weapon pickup
                        weaponId: meta.weaponId,
                        entityId: player.id,
                        droppedWeaponId: result.dropped,
                        x: itemEntity.transform.position.x,
                        y: itemEntity.transform.position.y,
                        z: itemEntity.transform.position.z,
                    });

                    // Only pick up one item per tick
                    break;
                }
            }
        }
    }
}
