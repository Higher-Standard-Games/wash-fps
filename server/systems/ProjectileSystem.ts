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
    /** Gametype self-damage multiplier (1.0 = full, 0.0 = none) */
    selfDamageMultiplier: number = 1.0;

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

    /**
     * Get the defId for a projectile entity (used by GameServer for snapshot events)
     */
    getDefId(entityId: EntityId): string | undefined {
        return this.projectileMeta.get(entityId)?.defId;
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
                        this.applySplashDamage(state, pos, projectile.ownerId, weaponDef.splashRadius, meta.defId);
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
                if (!target.transform || !target.health || target.health.dead) continue;

                // Self-damage: skip if selfDamage multiplier is 0
                const isSelf = target.ownerId === projectile.ownerId;
                if (isSelf && this.selfDamageMultiplier <= 0) continue;

                // Simple sphere collision
                const distSq =
                    (newPos.x - target.transform.position.x) ** 2 +
                    (newPos.y - target.transform.position.y) ** 2 +
                    (newPos.z - target.transform.position.z) ** 2;

                const hitRadius = 50; // Projectile + player radius
                if (distSq < hitRadius ** 2) {
                    // Direct hit!
                    const weaponDef = WEAPONS[meta.defId];
                    const baseDamage = weaponDef?.damage || 80;
                    const damage = isSelf
                        ? Math.round(baseDamage * this.selfDamageMultiplier)
                        : baseDamage;

                    if (damage > 0) {
                        // KB direction = projectile velocity (momentum transfer)
                        const vel = mutable.physics.velocity;
                        this.pendingDamage.push({
                            victimId: target.id,
                            attackerId: projectile.ownerId ? state.getEntityByOwner(projectile.ownerId)?.id : undefined,
                            damage,
                            armorPiercing: 0,
                            damageType: this.defIdToDamageType(meta.defId),
                            hitLocation: HitLocation.Body,
                            knockbackDir: { x: vel.x, y: vel.y, z: vel.z },
                            knockbackScale: weaponDef?.knockbackScale,
                        });
                    }

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
                    // Skip the direct-hit entity to prevent stacking
                    if (weaponDef?.splashRadius) {
                        this.applySplashDamage(state, newPos, projectile.ownerId, weaponDef.splashRadius, meta.defId, target.id);
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
                        this.applySplashDamage(state, newPos, projectile.ownerId, weaponDef.splashRadius, meta.defId);
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
        radius: number,
        defId: string,
        skipEntityId?: number
    ): void {
        const weaponDef = WEAPONS[defId];
        const baseSplashDamage = weaponDef?.splashDamage ?? weaponDef?.damage ?? 80;

        for (const target of state.entitiesByType(EntityType.Player)) {
            if (!target.transform || !target.health || target.health.dead) continue;
            if (target.id === skipEntityId) continue; // Skip this entity if it was directly hit

            const dist = Math.sqrt(
                (center.x - target.transform.position.x) ** 2 +
                (center.y - target.transform.position.y) ** 2 +
                (center.z - target.transform.position.z) ** 2
            );

            if (dist < radius) {
                // Damage interpolates: max at center, min at edge (Warsow-style floor)
                const minSplash = weaponDef?.minSplashDamage ?? 0;
                const falloff = 1 - (dist / radius);
                let damage = Math.round(minSplash + (baseSplashDamage - minSplash) * falloff);

                // Apply self-damage multiplier from gametype config
                const isSelf = target.ownerId === attackerOwnerId;
                if (isSelf) {
                    if (this.selfDamageMultiplier <= 0) continue;
                    damage = Math.round(damage * this.selfDamageMultiplier);
                }

                if (damage > 0) {
                    // KB direction = explosion center → victim (radial push)
                    const dx = target.transform.position.x - center.x;
                    const dy = target.transform.position.y - center.y;
                    const dz = target.transform.position.z - center.z;
                    this.pendingDamage.push({
                        victimId: target.id,
                        attackerId: attackerOwnerId ? state.getEntityByOwner(attackerOwnerId)?.id : undefined,
                        damage,
                        armorPiercing: 0,
                        damageType: DamageType.Explosion,
                        hitLocation: HitLocation.Body,
                        knockbackDir: { x: dx, y: dy, z: dz },
                        knockbackScale: weaponDef?.knockbackScale,
                    });
                }
            }
        }
    }
}
