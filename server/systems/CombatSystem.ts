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

    constructor() {
        super(CONFIG);
    }

    /**
     * Queue damage to be applied this tick
     */
    queueDamage(event: DamageEvent): void {
        this.pendingDamage.push(event);
    }

    /**
     * Get kills from last tick.
     * GametypeController drains these via drainKills().
     */
    getRecentKills(): KillEvent[] {
        return [...this.kills];
    }

    /**
     * Drain kills — returns kills and clears the buffer.
     * Called by GametypeController after processing.
     */
    drainKills(): KillEvent[] {
        const drained = this.kills;
        this.kills = [];
        return drained;
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
        // NOTE: Respawning is now handled by GametypeController.postTick()
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
            // NOTE: Respawn queuing is now handled by GametypeController
        }
    }
}
