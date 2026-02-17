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

/**
 * Event emitted when a projectile impacts, for network broadcast
 */
export interface ProjectileImpactEvent {
    defId: string;    // weapon definition id (e.g. 'rlauncher', 'glauncher')
    x: number;        // impact position
    y: number;
    z: number;
    normalX: number;  // surface normal at impact
    normalY: number;
    normalZ: number;
}

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
    private pendingImpacts: ProjectileImpactEvent[] = [];
    private projectilesToRemove: EntityId[] = [];
    private maxLifetimeTicks: number = 500; // 4 seconds at 125Hz
    private projectileAges: Map<EntityId, number> = new Map();
    private projectileTypes: Map<EntityId, string> = new Map();
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

    /**
     * Get pending impact events (consumed by GameServer for broadcast)
     */
    getPendingImpacts(): ProjectileImpactEvent[] {
        const events = this.pendingImpacts;
        this.pendingImpacts = [];
        return events;
    }

    /**
     * Register a projectile's weapon type (called by WeaponSystem on spawn)
     */
    registerProjectileType(entityId: EntityId, defId: string): void {
        this.projectileTypes.set(entityId, defId);
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
            let hitNormal = { x: 0, y: 1, z: 0 };

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
                    if (traceResult.normal) {
                        hitNormal = traceResult.normal;
                    }
                    console.log(`[ProjectileSystem] World hit! fraction=${traceResult.fraction.toFixed(3)} pos=(${newPos.x.toFixed(1)},${newPos.y.toFixed(1)},${newPos.z.toFixed(1)}) normal=(${hitNormal.x.toFixed(2)},${hitNormal.y.toFixed(2)},${hitNormal.z.toFixed(2)})`);
                }
            } else {
                if (age === 1) console.warn('[ProjectileSystem] No collision world set!');
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
                    const damage = WEAPONS.plasmagun?.damage || WEAPONS.rlauncher.damage;
                    this.pendingDamage.push({
                        victimId: target.id,
                        attackerId: projectile.ownerId ? state.getEntityByOwner(projectile.ownerId)?.id : undefined,
                        damage,
                        armorPiercing: 0,
                        damageType: DamageType.Plasma,
                        hitLocation: HitLocation.Body,
                    });

                    // Emit impact event (direction from projectile to target as normal)
                    const defId = this.projectileTypes.get(projectile.id) || 'rlauncher';
                    const dist = Math.sqrt(distSq) || 1;
                    this.pendingImpacts.push({
                        defId,
                        x: newPos.x, y: newPos.y, z: newPos.z,
                        normalX: (target.transform!.position.x - newPos.x) / dist,
                        normalY: (target.transform!.position.y - newPos.y) / dist,
                        normalZ: (target.transform!.position.z - newPos.z) / dist,
                    });

                    this.projectilesToRemove.push(projectile.id);
                    break;
                }
            }

            // Check world collision
            if (hitWorld) {
                // Emit impact event for world hit
                const defId = this.projectileTypes.get(projectile.id) || 'rlauncher';
                console.log(`[ProjectileSystem] Emitting impact event: defId=${defId} pos=(${newPos.x.toFixed(1)},${newPos.y.toFixed(1)},${newPos.z.toFixed(1)})`);
                this.pendingImpacts.push({
                    defId,
                    x: newPos.x, y: newPos.y, z: newPos.z,
                    normalX: hitNormal.x, normalY: hitNormal.y, normalZ: hitNormal.z,
                });
                this.projectilesToRemove.push(projectile.id);
            } else if (newPos.y < -1000) {
                // Fell out of world — no explosion needed
                this.projectilesToRemove.push(projectile.id);
            }
        }

        // Remove expired/exploded projectiles
        for (const id of this.projectilesToRemove) {
            state.removeEntity(id);
            this.projectileAges.delete(id);
            this.projectileTypes.delete(id);
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
                const damage = Math.round(WEAPONS.rlauncher.damage * 0.5 * falloff);

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
