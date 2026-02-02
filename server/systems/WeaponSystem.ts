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
    private nextProjectileId: number = 10000;
    private pendingDamage: DamageEvent[] = [];

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
     * Initialize weapon state for an entity
     */
    initializeWeapon(entityId: EntityId): void {
        this.weaponStates.set(entityId, {
            currentWeapon: 'plasmagun',
            ammo: new Map([
                ['machinegun', 100],
                ['shotgun', 12],
                ['rocketLauncher', 10],
                ['railgun', 10],
                ['plasmagun', 50],
            ]),
            lastFireTick: 0,
            reloading: false,
            reloadEndTick: 0,
        });
    }

    update(state: WorldState, _dt: number, tick: TickNumber): void {
        const tickNum = tick as number;

        // Process all player entities
        for (const entity of state.entitiesByType(EntityType.Player)) {
            if (!entity.input || !entity.health || entity.health.dead) continue;

            let weaponState = this.weaponStates.get(entity.id);
            if (!weaponState) {
                this.initializeWeapon(entity.id);
                weaponState = this.weaponStates.get(entity.id)!;
            }

            // Handle weapon switch
            const weaponSlot = entity.input.weaponSlot;
            const weapons = Object.keys(WEAPONS);
            if (weaponSlot > 0 && weaponSlot <= weapons.length) {
                const newWeapon = weapons[weaponSlot - 1];
                if (newWeapon && newWeapon !== weaponState.currentWeapon) {
                    weaponState.currentWeapon = newWeapon;
                    weaponState.reloading = false; // Cancel reload on switch
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

            // Handle firing
            if (entity.input.attack && !weaponState.reloading) {
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

        // Calculate fire direction from view angles
        const yawRad = (shooter.input.yaw * Math.PI) / 180;
        const pitchRad = (shooter.input.pitch * Math.PI) / 180;

        const dir = {
            x: Math.sin(yawRad) * Math.cos(pitchRad),
            y: Math.sin(pitchRad),
            z: Math.cos(yawRad) * Math.cos(pitchRad),
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
                });

                // For shotgun, continue checking (pellets can hit multiple)
                // For railgun, could pierce through
                if (weapon.id !== 'shotgun') break;
            }
        }
    }

    private fireProjectile(
        state: WorldState,
        shooter: Readonly<Entity>,
        weapon: WeaponDef
    ): void {
        if (!shooter.transform || !shooter.input || !shooter.ownerId) return;

        // Calculate fire direction
        const yawRad = (shooter.input.yaw * Math.PI) / 180;
        const pitchRad = (shooter.input.pitch * Math.PI) / 180;

        const speed = weapon.projectileSpeed || 1000;
        const velocity = {
            x: Math.sin(yawRad) * Math.cos(pitchRad) * speed,
            y: Math.sin(pitchRad) * speed,
            z: Math.cos(yawRad) * Math.cos(pitchRad) * speed,
        };

        // Spawn projectile slightly in front of shooter
        const offset = 50;
        const position = {
            x: shooter.transform.position.x + Math.sin(yawRad) * offset,
            y: shooter.transform.position.y + 20, // Eye height
            z: shooter.transform.position.z + Math.cos(yawRad) * offset,
        };

        const projectile = createProjectileEntity(
            entityId(this.nextProjectileId++),
            shooter.ownerId,
            position,
            velocity
        );

        state.addEntity(projectile);
    }

    private weaponToDamageType(weaponId: string): DamageType {
        switch (weaponId) {
            case 'machinegun': return DamageType.Bullet;
            case 'shotgun': return DamageType.Bullet;
            case 'rocketLauncher': return DamageType.Explosion;
            case 'railgun': return DamageType.Rail;
            default: return DamageType.Bullet;
        }
    }
}
