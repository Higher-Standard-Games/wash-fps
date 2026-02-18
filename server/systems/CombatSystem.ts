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
import type { FPSMovementSubsystem } from './FPSMovementSubsystem';

const CONFIG: SubsystemConfig = {
    name: 'Combat',
    priority: 30, // After physics
    tickRate: 125,
};

/** Default KB scale if weapon doesn't specify one */
const DEFAULT_KB_SCALE = 5.0;
/** Self-KB multiplier (slightly stronger for rocket jumping feel) */
const SELF_KB_MULTIPLIER = 1.2;
/** Minimum upward bias for KB direction (ensures launches feel "up") */
const KB_UPWARD_BIAS = 0.4;

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
    /** Knockback direction (unnormalized ok — will be normalized + biased upward) */
    knockbackDir?: { x: number; y: number; z: number };
    /** Knockback scale override (defaults to weapon's knockbackScale) */
    knockbackScale?: number;
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
    /** Processed damage events (with final damage) for network forwarding */
    private processedDamage: { victimId: EntityId; attackerId?: EntityId; damage: number; damageType: DamageType }[] = [];
    /** Movement subsystem ref for grounded state reset after KB */
    private movementSubsystem: FPSMovementSubsystem | null = null;

    constructor() {
        super(CONFIG);
    }

    /**
     * Set reference to movement subsystem (needed for KB grounded reset)
     */
    setMovementSubsystem(sub: FPSMovementSubsystem): void {
        this.movementSubsystem = sub;
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

    /**
     * Get processed damage events for network forwarding.
     * Contains final damage values (after location multipliers).
     */
    getProcessedDamage(): readonly { victimId: EntityId; attackerId?: EntityId; damage: number; damageType: DamageType }[] {
        return this.processedDamage;
    }

    /**
     * Clear processed damage buffer (call after forwarding to network).
     */
    clearProcessedDamage(): void {
        this.processedDamage = [];
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

        // ── STUN + KNOCKBACK ──
        // Stun: strip horizontal speed proportional to damage (Warsow-style)
        // KB: push victim away from damage source with upward bias
        if (victim.physics && event.knockbackDir) {
            const vel = victim.physics.velocity;

            // 1. STUN — strip horizontal speed (cripple momentum)
            //    Cap at 80% speed loss to prevent full freeze
            const stunFraction = Math.min(finalDamage / 100, 0.8);
            vel.x *= (1 - stunFraction);
            vel.z *= (1 - stunFraction);
            // Y untouched — don't cancel gravity or upward KB

            // 2. KNOCKBACK — calculate direction with upward bias
            const kbDir = { ...event.knockbackDir };
            // Apply upward bias (always launch upward)
            kbDir.y = Math.max(kbDir.y, KB_UPWARD_BIAS);
            // Normalize
            const len = Math.sqrt(kbDir.x * kbDir.x + kbDir.y * kbDir.y + kbDir.z * kbDir.z);
            if (len > 0.001) {
                kbDir.x /= len;
                kbDir.y /= len;
                kbDir.z /= len;
            }

            // Calculate force: damage × weapon KB scale
            const kbScale = event.knockbackScale ?? DEFAULT_KB_SCALE;
            const isSelf = event.attackerId !== undefined && event.attackerId === event.victimId;
            const selfMult = isSelf ? SELF_KB_MULTIPLIER : 1.0;
            const force = finalDamage * kbScale * selfMult;

            // Apply impulse
            vel.x += kbDir.x * force;
            vel.y += kbDir.y * force;
            vel.z += kbDir.z * force;

            // 3. Reset grounded state so friction doesn't eat the impulse
            if (this.movementSubsystem) {
                this.movementSubsystem.resetGroundedState(event.victimId as number, false);
            }
        }

        // Store for network forwarding (with final damage value)
        this.processedDamage.push({
            victimId: event.victimId,
            attackerId: event.attackerId,
            damage: finalDamage,
            damageType: event.damageType,
        });

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
