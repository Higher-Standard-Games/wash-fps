/**
 * Weapon System
 * 
 * Handles weapon switching, firing, ammo management.
 * Works for any action game with ranged weapons.
 */

import { Subsystem, type SubsystemConfig } from '@engine/server/core/Subsystem';
import type { WorldState } from '@engine/server/core/WorldState';
import type { TickNumber, EntityId } from '@engine/server/ecs/types';
import { EntityType, entityId } from '@engine/server/ecs/types';
import type { Entity } from '@engine/server/ecs/Entity';
import { createProjectileEntity } from '@engine/server/ecs/Entity';
import { WEAPONS, type WeaponDef } from '../weapons/WeaponDef';
import { DamageType, type DamageEvent, HitLocation } from './CombatSystem';
import type { WeaponLoadout } from '@shared/server/gametype';
import type { ProjectileSystem } from './ProjectileSystem';

/** Must match InputButtons.FIRE from engine/network/components/InputComponent.ts */
const FIRE_BUTTON = 1 << 8;

/**
 * Event emitted when a weapon is fired, for network broadcast
 */
export interface WeaponFireEvent {
    entityId: EntityId;  // shooter entity
    weaponId: string;    // weapon id
    originX: number;     // fire origin
    originY: number;
    originZ: number;
    dirX: number;        // fire direction (normalized)
    dirY: number;
    dirZ: number;
}

const CONFIG: SubsystemConfig = {
    name: 'Weapon',
    priority: 25, // After input, before combat
    tickRate: 125,
};

// ═══════════════════════════════════════════════════════════════════
// WEAPON STATE
// ═══════════════════════════════════════════════════════════════════

export interface WeaponState {
    currentWeapon: string;
    weapons: string[]; // Owned weapons (max 2, COD-style)
    ammo: Map<string, number>;
    lastFireTick: number;
    reloading: boolean;
    reloadEndTick: number;
}

// ═══════════════════════════════════════════════════════════════════
// WEAPON SYSTEM
// ═══════════════════════════════════════════════════════════════════

export class WeaponSystem extends Subsystem {
    private weaponStates: Map<EntityId, WeaponState> = new Map();
    private lastWeaponSlot: Map<EntityId, number> = new Map(); // Edge detection for slot changes
    private nextProjectileId: number = 10000;
    private pendingDamage: DamageEvent[] = [];
    private pendingFireEvents: WeaponFireEvent[] = [];
    private projectileSystem: ProjectileSystem | null = null;

    constructor() {
        super(CONFIG);
    }

    /**
     * Get pending damage events to pass to combat system
     */
    getPendingDamage(): DamageEvent[] {
        const events = this.pendingDamage;
        this.pendingDamage = [];
        return events;
    }

    /**
     * Get pending fire events to broadcast to clients
     */
    getPendingFireEvents(): WeaponFireEvent[] {
        const events = this.pendingFireEvents;
        this.pendingFireEvents = [];
        return events;
    }

    /**
     * Get weapon state for a specific entity (used for game state broadcast)
     */
    getWeaponState(entityId: EntityId): WeaponState | undefined {
        return this.weaponStates.get(entityId);
    }

    /**
     * Set reference to ProjectileSystem (for registering projectile types)
     */
    setProjectileSystem(system: ProjectileSystem): void {
        this.projectileSystem = system;
    }

    /**
     * Add a weapon to a player's inventory (server-side pickup).
     * Rules:
     *   - Gunblade is permanent (slot 0), never dropped
     *   - Players can carry gunblade + 2 picked-up weapons
     *   - If at capacity, drop current weapon; if holding gunblade, drop first non-gunblade
     * @returns { added: true, dropped?: weaponId } or { added: false } if already owned
     */
    addWeapon(entityId: EntityId, weaponId: string): { added: boolean; dropped?: string } {
        const state = this.weaponStates.get(entityId);
        if (!state) return { added: false };

        // Already has this weapon — no-op (could give ammo instead)
        if (state.weapons.includes(weaponId)) return { added: false };

        const MAX_PICKABLE = 2; // not counting gunblade
        const nonGunbladeWeapons = state.weapons.filter(w => w !== 'gunblade');

        if (nonGunbladeWeapons.length < MAX_PICKABLE) {
            // Have room — just add
            state.weapons.push(weaponId);
            state.currentWeapon = weaponId; // auto-switch to new weapon
            // Give ammo if not already present
            if (!state.ammo.has(weaponId) || state.ammo.get(weaponId)! <= 0) {
                const weapon = WEAPONS[weaponId];
                if (weapon) state.ammo.set(weaponId, weapon.ammoCapacity);
            }
            console.log(`[WeaponSystem] Entity ${entityId}: picked up ${weaponId} (${state.weapons.length} weapons, ammo=${state.ammo.get(weaponId)})`);
            return { added: true };
        }

        // At capacity — need to drop one
        let droppedWeapon: string;

        if (state.currentWeapon === 'gunblade') {
            // Holding gunblade → drop first non-gunblade weapon
            droppedWeapon = nonGunbladeWeapons[0];
        } else {
            // Drop currently held weapon
            droppedWeapon = state.currentWeapon;
        }

        // Remove dropped weapon from inventory
        const dropIdx = state.weapons.indexOf(droppedWeapon);
        if (dropIdx >= 0) state.weapons.splice(dropIdx, 1);

        // Add new weapon and switch to it
        state.weapons.push(weaponId);
        state.currentWeapon = weaponId;
        // Give ammo if not already present
        if (!state.ammo.has(weaponId) || state.ammo.get(weaponId)! <= 0) {
            const weapon = WEAPONS[weaponId];
            if (weapon) state.ammo.set(weaponId, weapon.ammoCapacity);
        }

        console.log(`[WeaponSystem] Entity ${entityId}: picked up ${weaponId}, dropped ${droppedWeapon}`);
        return { added: true, dropped: droppedWeapon };
    }

    /**
     * Get a player's current weapon list (for sync/debug)
     */
    getWeapons(entityId: EntityId): string[] {
        return this.weaponStates.get(entityId)?.weapons || [];
    }

    /**
     * Initialize weapon state from a gametype-defined loadout.
     * Called by GametypeController on spawn/respawn.
     */
    initializeWeaponFromLoadout(id: EntityId, loadout: WeaponLoadout): void {
        const ammoMap = new Map<string, number>();
        for (const [weaponId, amount] of Object.entries(loadout.ammo)) {
            ammoMap.set(weaponId, amount);
        }
        this.weaponStates.set(id, {
            currentWeapon: loadout.weapons[0] || 'gunblade',
            weapons: [...loadout.weapons].slice(0, 2), // Max 2 pickable weapons
            ammo: ammoMap,
            lastFireTick: 0,
            reloading: false,
            reloadEndTick: 0,
        });
    }

    /**
     * Initialize weapon state for an entity (fallback with default loadout)
     */
    initializeWeapon(entityId: EntityId): void {
        this.initializeWeaponFromLoadout(entityId, {
            weapons: ['gunblade'],
            ammo: {
                gunblade: 1,
                machinegun: 100,
                riotgun: 20,
                glauncher: 20,
                rlauncher: 20,
                plasmagun: 150,
                lasergun: 150,
                electrobolt: 10,
                instagun: 5,
            },
            health: 100,
            armor: 0,
        });
    }

    update(state: WorldState, _dt: number, tick: TickNumber): void {
        const tickNum = tick as number;
        const debugTick = tickNum % 1000 === 0; // Log every 1000 ticks (~8s)

        // Process all player entities
        for (const entity of state.entitiesByType(EntityType.Player)) {
            if (!entity.input || !entity.health || entity.health.dead) {
                if (debugTick) console.log(`[WeaponSystem] Entity ${entity.id}: skip (input=${!!entity.input}, health=${!!entity.health}, dead=${entity.health?.dead})`);
                continue;
            }

            let weaponState = this.weaponStates.get(entity.id);
            if (!weaponState) {
                this.initializeWeapon(entity.id);
                weaponState = this.weaponStates.get(entity.id)!;
            }

            // Handle weapon switch — only on CHANGE (edge detection)
            // This prevents the client's weaponSlot from overriding server-side
            // pickup auto-switch every tick.
            const weaponSlot = entity.input.weaponSlot;
            const prevSlot = this.lastWeaponSlot.get(entity.id) || 0;
            this.lastWeaponSlot.set(entity.id, weaponSlot);

            if (weaponSlot !== prevSlot && weaponSlot > 0 && weaponSlot <= weaponState.weapons.length) {
                const newWeapon = weaponState.weapons[weaponSlot - 1];
                if (newWeapon && newWeapon !== weaponState.currentWeapon) {
                    weaponState.currentWeapon = newWeapon;
                    weaponState.reloading = false; // Cancel reload on switch
                    console.log(`[WeaponSystem] Entity ${entity.id}: switched to ${newWeapon} (slot ${weaponSlot})`);
                }
            }

            // Handle reload completion
            if (weaponState.reloading && tickNum >= weaponState.reloadEndTick) {
                weaponState.reloading = false;
                // Refill ammo (simplified - would normally pull from reserve)
                const weapon = WEAPONS[weaponState.currentWeapon];
                if (weapon) {
                    weaponState.ammo.set(weaponState.currentWeapon, weapon.ammoCapacity);
                }
            }

            // Handle firing — check raw buttons bitmask (entity.input.attack is never set;
            // FPSMovementSubsystem only populates input.buttons from the inputQueue)
            const isFiring = (entity.input.buttons & FIRE_BUTTON) !== 0;
            if (debugTick) console.log(`[WeaponSystem] Entity ${entity.id}: buttons=${entity.input.buttons}, isFiring=${isFiring}, weapon=${weaponState.currentWeapon}, ammo=${weaponState.ammo.get(weaponState.currentWeapon)}`);
            if (isFiring && !weaponState.reloading) {
                const weapon = WEAPONS[weaponState.currentWeapon];
                if (weapon) {
                    const fireInterval = Math.floor(125 / weapon.fireRate); // ticks between shots
                    const timeSinceFire = tickNum - weaponState.lastFireTick;

                    if (timeSinceFire >= fireInterval) {
                        const ammo = weaponState.ammo.get(weaponState.currentWeapon) || 0;
                        if (ammo > 0) {
                            this.fireWeapon(state, entity, weapon, tick);
                            weaponState.ammo.set(weaponState.currentWeapon, ammo - 1);
                            weaponState.lastFireTick = tickNum;
                        }
                    }
                }
            }
        }
    }

    private fireWeapon(
        state: WorldState,
        shooter: Readonly<Entity>,
        weapon: WeaponDef,
        tick: TickNumber
    ): void {
        // Emit fire event for network broadcast
        if (shooter.transform && shooter.input) {
            // yaw/pitch are already in radians from the client (Babylon.js camera)
            // Negate pitch: Babylon uses negative rotationX for looking UP
            const yaw = shooter.input.yaw;
            const pitch = -shooter.input.pitch;
            this.pendingFireEvents.push({
                entityId: shooter.id,
                weaponId: weapon.id,
                originX: shooter.transform.position.x,
                originY: shooter.transform.position.y,
                originZ: shooter.transform.position.z,
                dirX: Math.sin(yaw) * Math.cos(pitch),
                dirY: Math.sin(pitch),
                dirZ: Math.cos(yaw) * Math.cos(pitch),
            });
        }

        if (weapon.type === 'hitscan') {
            this.fireHitscan(state, shooter, weapon, tick);
        } else {
            this.fireProjectile(state, shooter, weapon);
        }
    }

    private fireHitscan(
        state: WorldState,
        shooter: Readonly<Entity>,
        weapon: WeaponDef,
        _tick: TickNumber
    ): void {
        if (!shooter.transform || !shooter.input) return;

        // Calculate fire direction from view angles (already in radians)
        // Negate pitch: Babylon uses negative rotationX for looking UP
        const yaw = shooter.input.yaw;
        const pitch = -shooter.input.pitch;

        const dir = {
            x: Math.sin(yaw) * Math.cos(pitch),
            y: Math.sin(pitch),
            z: Math.cos(yaw) * Math.cos(pitch),
        };

        const start = shooter.transform.position;
        const maxRange = weapon.maxRange || 5000;

        // Check all potential targets
        for (const target of state.entitiesByType(EntityType.Player)) {
            if (target.id === shooter.id) continue;
            if (!target.transform || !target.health || target.health.dead) continue;

            // Simple sphere intersection test
            const toTarget = {
                x: target.transform.position.x - start.x,
                y: target.transform.position.y - start.y,
                z: target.transform.position.z - start.z,
            };

            // Project onto ray
            const dot = toTarget.x * dir.x + toTarget.y * dir.y + toTarget.z * dir.z;
            if (dot < 0 || dot > maxRange) continue;

            // Distance from ray to target center
            const closestPoint = {
                x: start.x + dir.x * dot,
                y: start.y + dir.y * dot,
                z: start.z + dir.z * dot,
            };

            const distSq =
                (closestPoint.x - target.transform.position.x) ** 2 +
                (closestPoint.y - target.transform.position.y) ** 2 +
                (closestPoint.z - target.transform.position.z) ** 2;

            const hitRadius = 32; // Player capsule radius
            if (distSq < hitRadius ** 2) {
                // Hit! Determine location based on Y offset
                const yOffset = closestPoint.y - target.transform.position.y;
                let hitLocation = HitLocation.Body;
                if (yOffset > 24) hitLocation = HitLocation.Head;
                else if (yOffset < -20) hitLocation = HitLocation.Legs;

                this.pendingDamage.push({
                    victimId: target.id,
                    attackerId: shooter.id,
                    damage: weapon.damage,
                    armorPiercing: 0,
                    damageType: this.weaponToDamageType(weapon.id),
                    hitLocation,
                    knockbackDir: { x: dir.x, y: dir.y, z: dir.z },
                    knockbackScale: weapon.knockbackScale,
                });

                // Pellet weapons (riotgun) continue checking — pellets can hit multiple
                // All other hitscan weapons break on first hit
                if (!weapon.pelletCount) break;
            }
        }
    }

    private fireProjectile(
        state: WorldState,
        shooter: Readonly<Entity>,
        weapon: WeaponDef
    ): void {
        if (!shooter.transform || !shooter.input || !shooter.ownerId) return;

        // Calculate fire direction (already in radians from client)
        // Negate pitch: Babylon uses negative rotationX for looking UP
        const yaw = shooter.input.yaw;
        const pitch = -shooter.input.pitch;

        const speed = weapon.projectileSpeed || 1000;
        const velocity = {
            x: Math.sin(yaw) * Math.cos(pitch) * speed,
            y: Math.sin(pitch) * speed,
            z: Math.cos(yaw) * Math.cos(pitch) * speed,
        };

        // Spawn projectile slightly in front of shooter
        const offset = 50;
        const position = {
            x: shooter.transform.position.x + Math.sin(yaw) * offset,
            y: shooter.transform.position.y + 24, // Eye height (matches client camera offset)
            z: shooter.transform.position.z + Math.cos(yaw) * offset,
        };

        const projectile = createProjectileEntity(
            entityId(this.nextProjectileId++),
            shooter.ownerId,
            position,
            velocity
        );

        state.addEntity(projectile);

        // Register projectile type with ProjectileSystem for impact events
        if (this.projectileSystem) {
            // Per-projectile behavior based on weapon type
            const isGrenade = weapon.id === 'glauncher';
            this.projectileSystem.registerProjectileType(projectile.id, weapon.id, {
                bounces: isGrenade ? 3 : 0,
                lifetime: isGrenade ? 1.25 : 10.0,
                gravity: isGrenade ? 1 : 0,
            });
        }
    }

    private weaponToDamageType(weaponId: string): DamageType {
        switch (weaponId) {
            case 'gunblade': return DamageType.Melee;
            case 'machinegun': return DamageType.Bullet;
            case 'riotgun': return DamageType.Bullet;
            case 'glauncher': return DamageType.Explosion;
            case 'rlauncher': return DamageType.Explosion;
            case 'plasmagun': return DamageType.Plasma;
            case 'lasergun': return DamageType.Plasma;
            case 'electrobolt': return DamageType.Rail;
            case 'instagun': return DamageType.Rail;
            default: return DamageType.Bullet;
        }
    }
}
