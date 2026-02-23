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
/** Self-KB multiplier (halved for rocket jumping — base KB is already strong) */
const SELF_KB_MULTIPLIER = 0.5;
/** Minimum upward bias for KB direction (ensures dramatic vertical launches) */
const KB_UPWARD_BIAS = 0.80;

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
    /** Victim position at death (for gibs) */
    victimX: number;
    victimY: number;
    victimZ: number;
    /** Victim velocity at death (for gibs) */
    victimVelX: number;
    victimVelY: number;
    victimVelZ: number;
}

// ═══════════════════════════════════════════════════════════════════
// COMBAT SYSTEM
// ═══════════════════════════════════════════════════════════════════

export class CombatSystem extends Subsystem {
    private pendingDamage: DamageEvent[] = [];
    private kills: KillEvent[] = [];
    /** Processed damage events (with final damage) for network forwarding */
    private processedDamage: { victimId: EntityId; attackerId?: EntityId; damage: number; damageType: DamageType; x: number; y: number; z: number }[] = [];
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
    getProcessedDamage(): readonly { victimId: EntityId; attackerId?: EntityId; damage: number; damageType: DamageType; x: number; y: number; z: number }[] {
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

        // Aggregate same-tick damage to the same victim from the same attacker+type
        // (merges 20 pellet hits into one combined damage number for client display)
        this.aggregateProcessedDamage();
        // NOTE: Respawning is now handled by GametypeController.postTick()
    }

    /**
     * Merge processedDamage entries that share the same victim + attacker + damageType.
     * Combines damage values and keeps the last position.
     */
    private aggregateProcessedDamage(): void {
        if (this.processedDamage.length <= 1) return;

        const merged = new Map<string, { victimId: EntityId; attackerId?: EntityId; damage: number; damageType: DamageType; x: number; y: number; z: number }>();

        for (const entry of this.processedDamage) {
            const key = `${entry.victimId}_${entry.attackerId ?? 'env'}_${entry.damageType}`;
            const existing = merged.get(key);
            if (existing) {
                existing.damage += entry.damage;
                // Keep latest position
                existing.x = entry.x;
                existing.y = entry.y;
                existing.z = entry.z;
            } else {
                merged.set(key, { ...entry });
            }
        }

        this.processedDamage = Array.from(merged.values());
    }

    private processDamage(state: WorldState, event: DamageEvent, tick: TickNumber): void {
        const victim = state.getEntityMut(event.victimId);
        if (!victim?.health || victim.health.dead) return;

        // Calculate final damage with location multiplier
        const multiplier = LOCATION_MULTIPLIER[event.hitLocation] || 1.0;
        const finalDamage = Math.round(event.damage * multiplier);

        // Apply damage
        applyDamage(victim.health, finalDamage, event.armorPiercing);


        // ── KNOCKBACK (queued for movement system) ──
        // Queue impulse for FPSMovementSubsystem to apply BEFORE simulate().
        // This ensures KB bypasses ground friction/clipping.
        if (event.knockbackDir && this.movementSubsystem) {
            // 1. Normalize raw direction first
            const raw = event.knockbackDir;
            let len = Math.sqrt(raw.x * raw.x + raw.y * raw.y + raw.z * raw.z);
            const kbDir = len > 0.001
                ? { x: raw.x / len, y: raw.y / len, z: raw.z / len }
                : { x: 0, y: 1, z: 0 }; // fallback: straight up

            // 2. Apply upward bias to the UNIT vector (guarantees meaningful Y)
            kbDir.y = Math.max(kbDir.y, KB_UPWARD_BIAS);

            // 3. Re-normalize after bias
            len = Math.sqrt(kbDir.x * kbDir.x + kbDir.y * kbDir.y + kbDir.z * kbDir.z);
            kbDir.x /= len;
            kbDir.y /= len;
            kbDir.z /= len;

            // Calculate force: damage × weapon KB scale
            const kbScale = event.knockbackScale ?? DEFAULT_KB_SCALE;
            const isSelf = event.attackerId !== undefined && event.attackerId === event.victimId;
            const selfMult = isSelf ? SELF_KB_MULTIPLIER : 1.0;
            const force = finalDamage * kbScale * selfMult;

            // Stun fraction: strip horizontal speed proportional to damage (cap 80%)
            const stunFraction = Math.min(finalDamage / 100, 0.8);

            this.movementSubsystem.queueImpulse({
                entityId: event.victimId,
                dirX: kbDir.x, dirY: kbDir.y, dirZ: kbDir.z,
                force,
                stunFraction,
            });

        }

        // Store for network forwarding (with final damage value)
        this.processedDamage.push({
            victimId: event.victimId,
            attackerId: event.attackerId,
            damage: finalDamage,
            damageType: event.damageType,
            x: victim.transform?.position.x ?? 0,
            y: victim.transform?.position.y ?? 0,
            z: victim.transform?.position.z ?? 0,
        });

        // Check for kill
        if (victim.health.dead) {
            // Get victim position and velocity for gibs
            const pos = victim.transform?.position ?? { x: 0, y: 0, z: 0 };
            const vel = victim.physics?.velocity ?? { x: 0, y: 0, z: 0 };
            const killEvent: KillEvent = {
                victimId: event.victimId,
                killerId: event.attackerId,
                damageType: event.damageType,
                tick,
                victimX: pos.x,
                victimY: pos.y,
                victimZ: pos.z,
                victimVelX: vel.x,
                victimVelY: vel.y,
                victimVelZ: vel.z,
            };
            this.kills.push(killEvent);
            // NOTE: Respawn queuing is now handled by GametypeController
        }
    }
}
