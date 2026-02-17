/**
 * Projectile System
 * 
 * Handles projectile movement and collision.
 * Supports per-projectile behavior: bouncing (grenades), instant-explode (rockets),
 * gravity, and time-based lifetime.
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

/**
 * Per-projectile metadata for bounce/lifetime/gravity behavior
 */
interface ProjectileMeta {
    defId: string;       // weapon definition id
    bouncesLeft: number; // remaining bounces before explode (0 = explode on first hit)
    lifetime: number;    // max lifetime in seconds
    gravity: number;     // gravity multiplier (0 = none, 1 = full)
    age: number;         // accumulated time alive (seconds)
}

/** Velocity retention on bounce (Warsow-style) */
const BOUNCE_FACTOR = 0.65;

/** Gravity acceleration (units/sec²) */
const GRAVITY_ACCEL = 800;

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
    private projectileMeta: Map<EntityId, ProjectileMeta> = new Map();
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
     * Register a projectile's weapon type and behavior (called by WeaponSystem on spawn)
     */
    registerProjectileType(entityId: EntityId, defId: string, opts?: {
        bounces?: number;
        lifetime?: number;
        gravity?: number;
    }): void {
        this.projectileMeta.set(entityId, {
            defId,
            bouncesLeft: opts?.bounces ?? 0,
            lifetime: opts?.lifetime ?? 10.0,
            gravity: opts?.gravity ?? 0,
            age: 0,
        });
    }

    update(state: WorldState, dt: number, _tick: TickNumber): void {
        this.projectilesToRemove = [];

        // Process all projectiles
        for (const projectile of state.entitiesByType(EntityType.Projectile)) {
            if (!projectile.transform || !projectile.physics) continue;

            const mutable = state.getEntityMut(projectile.id);
            if (!mutable?.transform || !mutable?.physics) continue;

            const meta = this.projectileMeta.get(projectile.id);
            if (!meta) {
                // No metadata — legacy fallback, remove after a while
                this.projectilesToRemove.push(projectile.id);
                continue;
            }

            // Track age (real seconds, not ticks)
            meta.age += dt;

            // Check lifetime expiry — bouncing projectiles explode on timeout
            if (meta.age >= meta.lifetime) {
                const pos = mutable.transform.position;

                if (meta.bouncesLeft >= 0) {
                    // Grenade-type: explode on timeout
                    this.pendingImpacts.push({
                        defId: meta.defId,
                        x: pos.x, y: pos.y, z: pos.z,
                        normalX: 0, normalY: 1, normalZ: 0,
                    });

                    // Apply splash damage
                    const weaponDef = WEAPONS[meta.defId];
                    if (weaponDef?.splashRadius) {
                        this.applySplashDamage(state, pos, projectile.ownerId, weaponDef.splashRadius);
                    }
                }

                this.projectilesToRemove.push(projectile.id);
                continue;
            }

            // Apply gravity
            if (meta.gravity > 0) {
                mutable.physics.velocity.y -= GRAVITY_ACCEL * meta.gravity * dt;
            } else {
                // Slight gravity for non-grenade projectiles (rockets etc)
                mutable.physics.velocity.y -= 50 * dt;
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
                    newPos = traceResult.hitPoint;
                    hitWorld = true;
                    if (traceResult.normal) {
                        hitNormal = traceResult.normal;
                    }
                }
            } else {
                if (meta.age < dt * 2) console.warn('[ProjectileSystem] No collision world set!');
            }

            mutable.transform.position = newPos;

            // Check collisions with players (direct hit)
            let hitPlayer = false;
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
                    // Direct hit!
                    const weaponDef = WEAPONS[meta.defId];
                    const damage = weaponDef?.damage || 80;

                    this.pendingDamage.push({
                        victimId: target.id,
                        attackerId: projectile.ownerId ? state.getEntityByOwner(projectile.ownerId)?.id : undefined,
                        damage,
                        armorPiercing: 0,
                        damageType: this.defIdToDamageType(meta.defId),
                        hitLocation: HitLocation.Body,
                    });

                    // Emit impact event
                    const dist = Math.sqrt(distSq) || 1;
                    this.pendingImpacts.push({
                        defId: meta.defId,
                        x: newPos.x, y: newPos.y, z: newPos.z,
                        normalX: (target.transform!.position.x - newPos.x) / dist,
                        normalY: (target.transform!.position.y - newPos.y) / dist,
                        normalZ: (target.transform!.position.z - newPos.z) / dist,
                    });

                    // Apply splash damage on direct hit too (for weapons with splash)
                    if (weaponDef?.splashRadius) {
                        this.applySplashDamage(state, newPos, projectile.ownerId, weaponDef.splashRadius);
                    }

                    hitPlayer = true;
                    this.projectilesToRemove.push(projectile.id);
                    break;
                }
            }

            if (hitPlayer) continue;

            // Handle world collision
            if (hitWorld) {
                if (meta.bouncesLeft > 0) {
                    // ── BOUNCE ──
                    meta.bouncesLeft--;

                    // Reflect velocity: v' = v - 2(v·n)n, scaled by bounce factor
                    const vel = mutable.physics.velocity;
                    const dotVN = vel.x * hitNormal.x + vel.y * hitNormal.y + vel.z * hitNormal.z;
                    vel.x = (vel.x - 2 * dotVN * hitNormal.x) * BOUNCE_FACTOR;
                    vel.y = (vel.y - 2 * dotVN * hitNormal.y) * BOUNCE_FACTOR;
                    vel.z = (vel.z - 2 * dotVN * hitNormal.z) * BOUNCE_FACTOR;

                    // Nudge position slightly off the surface to prevent re-collision
                    mutable.transform.position.x += hitNormal.x * 2;
                    mutable.transform.position.y += hitNormal.y * 2;
                    mutable.transform.position.z += hitNormal.z * 2;

                    // Don't remove — projectile continues bouncing
                } else {
                    // ── EXPLODE ON WORLD HIT ──
                    this.pendingImpacts.push({
                        defId: meta.defId,
                        x: newPos.x, y: newPos.y, z: newPos.z,
                        normalX: hitNormal.x, normalY: hitNormal.y, normalZ: hitNormal.z,
                    });

                    // Apply splash damage
                    const weaponDef = WEAPONS[meta.defId];
                    if (weaponDef?.splashRadius) {
                        this.applySplashDamage(state, newPos, projectile.ownerId, weaponDef.splashRadius);
                    }

                    this.projectilesToRemove.push(projectile.id);
                }
            } else if (newPos.y < -1000) {
                // Fell out of world — no explosion needed
                this.projectilesToRemove.push(projectile.id);
            }
        }

        // Remove expired/exploded projectiles
        for (const id of this.projectilesToRemove) {
            state.removeEntity(id);
            this.projectileMeta.delete(id);
        }
    }

    /**
     * Map weapon def ID to damage type
     */
    private defIdToDamageType(defId: string): DamageType {
        switch (defId) {
            case 'plasmagun': return DamageType.Plasma;
            case 'glauncher':
            case 'rlauncher': return DamageType.Explosion;
            default: return DamageType.Bullet;
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
                const weaponDef = WEAPONS['rlauncher'];
                const baseDamage = weaponDef?.damage || 80;
                const damage = Math.round(baseDamage * 0.5 * falloff);

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
