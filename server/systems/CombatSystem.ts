/**
 * Combat System
 * 
 * Handles damage, kills, deaths, and respawning.
 * Works for any action game (FPS, TPS, isometric).
 */

import { Subsystem, type SubsystemConfig } from '@engine/server/core/Subsystem';
import type { WorldState } from '@engine/server/core/WorldState';
import type { TickNumber, EntityId } from '@engine/server/ecs/types';
import { applyDamage } from '@shared/server/simulation/components/HealthComponent';

const CONFIG: SubsystemConfig = {
    name: 'Combat',
    priority: 30, // After physics
    tickRate: 125,
};

// ═══════════════════════════════════════════════════════════════════
// DAMAGE EVENT
// ═══════════════════════════════════════════════════════════════════

export interface DamageEvent {
    victimId: EntityId;
    attackerId?: EntityId;
    damage: number;
    armorPiercing: number; // 0 = normal, 1 = full armor bypass
    damageType: DamageType;
    hitLocation: HitLocation;
}

export enum DamageType {
    Bullet = 'bullet',
    Explosion = 'explosion',
    Plasma = 'plasma',
    Rail = 'rail',
    Melee = 'melee',
    Fall = 'fall',
    World = 'world',
}

export enum HitLocation {
    Body = 'body',
    Head = 'head',
    Legs = 'legs',
}

// Damage multipliers by location
const LOCATION_MULTIPLIER: Record<HitLocation, number> = {
    [HitLocation.Head]: 2.0,
    [HitLocation.Body]: 1.0,
    [HitLocation.Legs]: 0.75,
};

// ═══════════════════════════════════════════════════════════════════
// KILL EVENT
// ═══════════════════════════════════════════════════════════════════

export interface KillEvent {
    victimId: EntityId;
    killerId?: EntityId;
    damageType: DamageType;
    tick: TickNumber;
}

// ═══════════════════════════════════════════════════════════════════
// COMBAT SYSTEM
// ═══════════════════════════════════════════════════════════════════

export class CombatSystem extends Subsystem {
    private pendingDamage: DamageEvent[] = [];
    private kills: KillEvent[] = [];
    private respawnQueue: Map<EntityId, number> = new Map(); // Entity -> respawn tick

    constructor(private respawnDelayTicks: number = 375) { // 3 seconds at 125Hz
        super(CONFIG);
    }

    /**
     * Queue damage to be applied this tick
     */
    queueDamage(event: DamageEvent): void {
        this.pendingDamage.push(event);
    }

    /**
     * Get kills from last tick
     */
    getRecentKills(): KillEvent[] {
        return [...this.kills];
    }

    /**
     * Clear kills (call after processing)
     */
    clearKills(): void {
        this.kills = [];
    }

    update(state: WorldState, _dt: number, tick: TickNumber): void {
        // Process pending damage
        for (const damage of this.pendingDamage) {
            this.processDamage(state, damage, tick);
        }
        this.pendingDamage = [];

        // Process respawns
        this.processRespawns(state, tick);
    }

    private processDamage(state: WorldState, event: DamageEvent, tick: TickNumber): void {
        const victim = state.getEntityMut(event.victimId);
        if (!victim?.health || victim.health.dead) return;

        // Calculate final damage with location multiplier
        const multiplier = LOCATION_MULTIPLIER[event.hitLocation] || 1.0;
        const finalDamage = Math.round(event.damage * multiplier);

        // Apply damage
        applyDamage(victim.health, finalDamage, event.armorPiercing);

        // Check for kill
        if (victim.health.dead) {
            const killEvent: KillEvent = {
                victimId: event.victimId,
                killerId: event.attackerId,
                damageType: event.damageType,
                tick,
            };
            this.kills.push(killEvent);

            // Queue respawn
            this.respawnQueue.set(event.victimId, (tick as number) + this.respawnDelayTicks);
        }
    }

    private processRespawns(state: WorldState, tick: TickNumber): void {
        const toRespawn: EntityId[] = [];

        for (const [entityId, respawnTick] of this.respawnQueue) {
            if ((tick as number) >= respawnTick) {
                toRespawn.push(entityId);
            }
        }

        for (const id of toRespawn) {
            this.respawnQueue.delete(id);
            this.respawnPlayer(state, id);
        }
    }

    private respawnPlayer(state: WorldState, id: EntityId): void {
        const entity = state.getEntityMut(id);
        if (!entity) return;

        // Reset health
        if (entity.health) {
            entity.health.health = entity.health.maxHealth;
            entity.health.armor = 0;
            entity.health.dead = false;
        }

        // Reset position (TODO: use spawn point selection)
        if (entity.transform) {
            entity.transform.position = {
                x: (Math.random() - 0.5) * 500,
                y: 100,
                z: (Math.random() - 0.5) * 500,
            };
        }

        // Reset velocity
        if (entity.physics) {
            entity.physics.velocity = { x: 0, y: 0, z: 0 };
            entity.physics.grounded = false;
            entity.physics.jumping = false;
        }
    }
}
