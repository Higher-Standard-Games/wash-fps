/**
 * Projectile System
 * 
 * Handles projectile movement and collision.
 * Works for any projectile-based combat system.
 */

import { Subsystem, type SubsystemConfig } from '@engine/server/core/Subsystem';
import type { WorldState } from '@engine/server/core/WorldState';
import type { TickNumber, EntityId } from '@engine/server/ecs/types';
import { EntityType } from '@engine/server/ecs/types';
import { DamageType, type DamageEvent, HitLocation } from './CombatSystem';
import { WEAPONS } from '../weapons/WeaponDef';
import type { CollisionWorld } from '../../../../engine/network/systems/collision/CollisionWorld';

const CONFIG: SubsystemConfig = {
    name: 'Projectile',
    priority: 20, // Early, so explosions happen before combat
    tickRate: 125,
};

// ═══════════════════════════════════════════════════════════════════
// PROJECTILE SYSTEM
// ═══════════════════════════════════════════════════════════════════

export class ProjectileSystem extends Subsystem {
    private pendingDamage: DamageEvent[] = [];
    private projectilesToRemove: EntityId[] = [];
    private maxLifetimeTicks: number = 500; // 4 seconds at 125Hz
    private projectileAges: Map<EntityId, number> = new Map();
    private collisionWorld: CollisionWorld | null = null;

    constructor(collisionWorld?: CollisionWorld) {
        super(CONFIG);
        this.collisionWorld = collisionWorld ?? null;
    }

    /**
     * Set collision world for BSP-aware collision detection
     */
    setCollisionWorld(world: CollisionWorld): void {
        this.collisionWorld = world;
    }

    /**
     * Get pending damage events
     */
    getPendingDamage(): DamageEvent[] {
        const events = this.pendingDamage;
        this.pendingDamage = [];
        return events;
    }

    update(state: WorldState, dt: number, _tick: TickNumber): void {
        this.projectilesToRemove = [];

        // Process all projectiles
        for (const projectile of state.entitiesByType(EntityType.Projectile)) {
            if (!projectile.transform || !projectile.physics) continue;

            const mutable = state.getEntityMut(projectile.id);
            if (!mutable?.transform || !mutable?.physics) continue;

            // Track age
            const age = (this.projectileAges.get(projectile.id) || 0) + 1;
            this.projectileAges.set(projectile.id, age);

            // Remove if too old
            if (age > this.maxLifetimeTicks) {
                this.projectilesToRemove.push(projectile.id);
                continue;
            }

            // Calculate movement delta
            const oldPos = { ...mutable.transform.position };
            const moveX = mutable.physics.velocity.x * dt;
            const moveY = mutable.physics.velocity.y * dt;
            const moveZ = mutable.physics.velocity.z * dt;

            let newPos = {
                x: oldPos.x + moveX,
                y: oldPos.y + moveY,
                z: oldPos.z + moveZ,
            };
            let hitWorld = false;

            // Check BSP collision if available
            if (this.collisionWorld) {
                const traceResult = this.collisionWorld.trace(
                    oldPos,
                    { x: oldPos.x + moveX, y: oldPos.y + moveY, z: oldPos.z + moveZ },
                    { min: { x: -2, y: -2, z: -2 }, max: { x: 2, y: 2, z: 2 } } // Small projectile bounds
                );

                if (traceResult.fraction < 1.0 && traceResult.hitPoint) {
                    // Hit something in the world
                    newPos = traceResult.hitPoint;
                    hitWorld = true;
                }
            }

            mutable.transform.position = newPos;

            // Apply gravity to rockets (slight drop), plasma has less gravity
            mutable.physics.velocity.y -= 50 * dt;

            // Check collisions with players
            for (const target of state.entitiesByType(EntityType.Player)) {
                if (target.ownerId === projectile.ownerId) continue; // No self-damage
                if (!target.transform || !target.health || target.health.dead) continue;

                // Simple sphere collision
                const distSq =
                    (newPos.x - target.transform.position.x) ** 2 +
                    (newPos.y - target.transform.position.y) ** 2 +
                    (newPos.z - target.transform.position.z) ** 2;

                const hitRadius = 50; // Projectile + player radius
                if (distSq < hitRadius ** 2) {
                    // Direct hit! Use plasma damage (20) or fallback to rocket
                    const damage = WEAPONS.plasmagun?.damage || WEAPONS.rocketLauncher.damage;
                    this.pendingDamage.push({
                        victimId: target.id,
                        attackerId: projectile.ownerId ? state.getEntityByOwner(projectile.ownerId)?.id : undefined,
                        damage,
                        armorPiercing: 0,
                        damageType: DamageType.Plasma,
                        hitLocation: HitLocation.Body,
                    });

                    this.projectilesToRemove.push(projectile.id);
                    break;
                }
            }

            // Check world collision
            if (hitWorld || newPos.y < -1000) {
                // Hit world geometry or fell out of world
                this.projectilesToRemove.push(projectile.id);
            }
        }

        // Remove expired/exploded projectiles
        for (const id of this.projectilesToRemove) {
            state.removeEntity(id);
            this.projectileAges.delete(id);
        }
    }

    private applySplashDamage(
        state: WorldState,
        center: { x: number; y: number; z: number },
        attackerOwnerId: number | undefined,
        radius: number
    ): void {
        for (const target of state.entitiesByType(EntityType.Player)) {
            if (!target.transform || !target.health || target.health.dead) continue;

            const dist = Math.sqrt(
                (center.x - target.transform.position.x) ** 2 +
                (center.y - target.transform.position.y) ** 2 +
                (center.z - target.transform.position.z) ** 2
            );

            if (dist < radius) {
                // Damage falls off with distance
                const falloff = 1 - (dist / radius);
                const damage = Math.round(WEAPONS.rocketLauncher.damage * 0.5 * falloff);

                if (damage > 0) {
                    // Allow self-damage but reduced
                    const isSelf = target.ownerId === attackerOwnerId;
                    const finalDamage = isSelf ? Math.round(damage * 0.5) : damage;

                    this.pendingDamage.push({
                        victimId: target.id,
                        attackerId: attackerOwnerId ? state.getEntityByOwner(attackerOwnerId)?.id : undefined,
                        damage: finalDamage,
                        armorPiercing: 0,
                        damageType: DamageType.Explosion,
                        hitLocation: HitLocation.Body,
                    });
                }
            }
        }
    }
}
