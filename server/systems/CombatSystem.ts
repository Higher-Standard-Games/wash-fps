/**
 * Combat System
 *
 * Handles damage, kills, deaths, and respawning.
 * Works for any action game (FPS, TPS, isometric).
 */

import { Subsystem, type SubsystemConfig } from "@engine/server/core/Subsystem";
import type { WorldState } from "@engine/server/core/WorldState";
import type { EntityId, TickNumber } from "@engine/server/ecs/types";
import { applyDamage } from "@shared/server/simulation/components/HealthComponent";
import { clearPowerups } from "@shared/server/simulation/components/PowerupComponent";
import { powerupDamageMultiplier } from "../../../../shared/items/Powerups";
import type { FPSMovementSubsystem } from "./FPSMovementSubsystem";

const CONFIG: SubsystemConfig = {
  name: "Combat",
  priority: 30, // After physics
  tickRate: 0, // every base tick — the rate comes from ServerTiming, not a per-subsystem literal (QA-24)
};

/** Default KB scale if weapon doesn't specify one */
const DEFAULT_KB_SCALE = 5.0;
/** Self-KB multiplier (halved for rocket jumping — base KB is already strong) */
const SELF_KB_MULTIPLIER = 0.5;
/** Minimum upward bias for KB direction (ensures dramatic vertical launches) */
const KB_UPWARD_BIAS = 0.8;
/** Fraction of incoming damage absorbed by armor at 0 armor-piercing (Q3/Warsow ~2/3). */
const BASE_ARMOR_ABSORPTION = 0.66;

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
  /**
   * Knockback magnitude source, decoupled from applied `damage`. When set, force
   * uses this instead of the dealt damage — so a hit can push a target it barely
   * (or doesn't) damage. Enables instagib "insta-jump" (self-knockback at 0
   * self-damage) and no-death shoves. Defaults to the final applied damage.
   */
  knockbackDamage?: number;
}

export enum DamageType {
  Bullet = "bullet",
  Explosion = "explosion",
  Plasma = "plasma",
  Rail = "rail",
  Melee = "melee",
  Fall = "fall",
  FallCrush = "fall_crush",
  /** Squashed by a player exiting a teleporter on top of you. */
  Telefrag = "telefrag",
  World = "world",
  /** The S&D bomb going off. Credited to no one, and always a gib on the client. */
  Bomb = "bomb",
}

export enum HitLocation {
  Body = "body",
  Head = "head",
  Legs = "legs",
}

/**
 * A head hit does 25% more damage, the same for every weapon. Enough to be felt
 * on a fast weapon (a machinegun round goes from 10 to 13 after rounding), not
 * so much that one lucky shot decides a fight.
 */
export const HEAD_DAMAGE_MULTIPLIER = 1.25;
export const LEGS_DAMAGE_MULTIPLIER = 0.75;

// Damage multipliers by location
const LOCATION_MULTIPLIER: Record<HitLocation, number> = {
  [HitLocation.Head]: HEAD_DAMAGE_MULTIPLIER,
  [HitLocation.Body]: 1.0,
  [HitLocation.Legs]: LEGS_DAMAGE_MULTIPLIER,
};

/**
 * Where a hit counts as the head or the legs: the height of the hit above or below the
 * target's origin, in map units. The origin is at the waist.
 *
 * The hit test is a sphere of radius 32 around that origin, and the height is taken at the
 * ray's closest point to its centre, so it is always under 32 in size. The head threshold
 * therefore has to be inside that range: the previous value, 32, could never be reached,
 * so head hits never registered.
 */
export const HEAD_MIN_OFFSET = 20;
export const LEGS_MAX_OFFSET = -20;

/** Classify a hit by its height relative to the target's origin. */
export function classifyHitLocation(yOffset: number): HitLocation {
  if (yOffset > HEAD_MIN_OFFSET) return HitLocation.Head;
  if (yOffset < LEGS_MAX_OFFSET) return HitLocation.Legs;
  return HitLocation.Body;
}

/** Which of two hit locations to report when damage from one attacker is merged into one number: head over legs over body. */
function moreSpecificLocation(a: HitLocation, b: HitLocation): HitLocation {
  const rank = { [HitLocation.Body]: 0, [HitLocation.Legs]: 1, [HitLocation.Head]: 2 };
  return rank[b] > rank[a] ? b : a;
}

/** One damage event as it leaves the combat system for the network (and the damage numbers). */
export interface ProcessedDamage {
  victimId: EntityId;
  attackerId?: EntityId;
  damage: number;
  damageType: DamageType;
  /** Where the (strongest of the merged) hit landed. Body for anything that has no location. */
  hitLocation: HitLocation;
  x: number;
  y: number;
  z: number;
}

// ═══════════════════════════════════════════════════════════════════
// KILL EVENT
// ═══════════════════════════════════════════════════════════════════

export interface KillEvent {
  victimId: EntityId;
  killerId?: EntityId;
  damageType: DamageType;
  /** Final damage of the killing blow (used for gib vs ragdoll decision) */
  finalDamage: number;
  tick: TickNumber;
  /** Victim position at death (for gibs) */
  victimX: number;
  victimY: number;
  victimZ: number;
  /** Victim velocity at death (for gibs) */
  victimVelX: number;
  victimVelY: number;
  victimVelZ: number;
  /** Knockback direction (from damage source → victim) */
  kbDirX: number;
  kbDirY: number;
  kbDirZ: number;
}

// ═══════════════════════════════════════════════════════════════════
// COMBAT SYSTEM
// ═══════════════════════════════════════════════════════════════════

export class CombatSystem extends Subsystem {
  private pendingDamage: DamageEvent[] = [];
  private damageFilter: ((event: DamageEvent, tick: number) => boolean) | null = null;
  /** Scoring's own damage buffer. See `drainDamageForStats`. */
  private damageForStats: { victimId: EntityId; attackerId?: EntityId; damage: number }[] = [];
  private kills: KillEvent[] = [];
  /** Processed damage events (with final damage) for network forwarding */
  private processedDamage: ProcessedDamage[] = [];
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
   * Install a veto on incoming damage. Return false to drop a hit entirely.
   *
   * Dropped, not zeroed: a zero-damage hit still emits a damage number, still
   * knocks the victim back, and still tells the shooter they connected. None of
   * that is wanted for a hit that did not happen.
   */
  setDamageFilter(filter: ((event: DamageEvent, tick: number) => boolean) | null): void {
    this.damageFilter = filter;
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
  getProcessedDamage(): readonly ProcessedDamage[] {
    // Merged here, once per snapshot, rather than every tick: the buffer only
    // empties at the snapshot rate, so merging per tick re-merged everything
    // gathered so far on every tick in between, for the same result.
    this.aggregateProcessedDamage();
    return this.processedDamage;
  }

  /**
   * Clear processed damage buffer (call after forwarding to network).
   */
  clearProcessedDamage(): void {
    this.processedDamage = [];
  }

  /**
   * Damage dealt since the last call, for scoring. Drains its own buffer.
   *
   * Deliberately NOT `getProcessedDamage`, which is cleared by snapshot
   * building at the SNAPSHOT rate while scoring runs every tick — reading that
   * one would credit the same hit once per tick until the next snapshot, about
   * six times over at the shipped rates, and forever on a server with no
   * clients (where snapshots are not built at all).
   *
   * Two consumers, two buffers, no race.
   */
  drainDamageForStats(): readonly { victimId: EntityId; attackerId?: EntityId; damage: number }[] {
    const drained = this.damageForStats;
    this.damageForStats = [];
    return drained;
  }

  /** Drop every warmup combat transient before players are respawned for a match. */
  resetForMatch(): void {
    this.pendingDamage = [];
    this.kills = [];
    this.processedDamage = [];
    this.damageForStats = [];
  }

  update(state: WorldState, _dt: number, tick: TickNumber): void {
    // Process pending damage
    for (const damage of this.pendingDamage) {
      this.processDamage(state, damage, tick);
    }
    this.pendingDamage = [];

    // Damage to the same victim from the same attacker+type is merged when the
    // snapshot reads it (getProcessedDamage), so 20 pellets show as one number.
    // NOTE: Respawning is now handled by GametypeController.postTick()
  }

  /**
   * Merge processedDamage entries that share the same victim + attacker + damageType.
   * Combines damage values and keeps the last position.
   */
  private aggregateProcessedDamage(): void {
    if (this.processedDamage.length <= 1) return;

    const merged = new Map<string, ProcessedDamage>();

    for (const entry of this.processedDamage) {
      const key = `${entry.victimId}_${entry.attackerId ?? "env"}_${entry.damageType}`;
      const existing = merged.get(key);
      if (existing) {
        existing.damage += entry.damage;
        // A shotgun's pellets arrive as one number: if any of them hit the head, it was a head hit
        existing.hitLocation = moreSpecificLocation(existing.hitLocation, entry.hitLocation);
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

    // Gametype veto. Injected rather than decided here because the reasons are
    // never combat's business — S&D uses it for spawn protection, which needs
    // team membership and a respawn tick that live in the match, not the world.
    if (this.damageFilter && !this.damageFilter(event, tick as number)) return;

    // FallCrush is a hard set (exactly 1 HP + 0 armor), not a computed hit —
    // the incoming event's damage/armorPiercing/hitLocation fields are inert.
    if (event.damageType === DamageType.FallCrush) {
      const healthBefore = victim.health.health;
      const armorBefore = victim.health.armor;
      victim.health.armor = 0;
      victim.health.health = Math.min(victim.health.health, 1);
      const actualDamage = Math.round(healthBefore - victim.health.health + armorBefore);

      this.damageForStats.push({ victimId: event.victimId, attackerId: event.attackerId, damage: actualDamage });
      this.processedDamage.push({
        victimId: event.victimId,
        attackerId: event.attackerId,
        damage: actualDamage,
        damageType: event.damageType,
        hitLocation: HitLocation.Body,
        x: victim.transform?.position.x ?? 0,
        y: victim.transform?.position.y ?? 0,
        z: victim.transform?.position.z ?? 0,
      });
      return;
    }

    // Calculate final damage with location multiplier.
    //
    // The powerup multiplier is the ATTACKER's (quad = 4x). It is applied here,
    // in the one place every damage source funnels through (hitscan, projectile,
    // splash, fall), so no weapon can miss it. Q3-classic scope: it multiplies
    // self-damage too, and it flows into knockback below via `finalDamage` —
    // a quad rocket jump throws you four times as far and usually kills you.
    const multiplier = LOCATION_MULTIPLIER[event.hitLocation] || 1.0;
    const attacker = event.attackerId !== undefined ? state.getEntity(event.attackerId) : undefined;
    const powerMultiplier = powerupDamageMultiplier(attacker?.powerups?.expiry, tick as number);
    const finalDamage = Math.round(event.damage * multiplier * powerMultiplier);

    // Apply damage. NOTE: applyDamage's 3rd arg is armorABSORPTION (fraction of
    // damage soaked by armor), not armor-piercing. Passing event.armorPiercing
    // (0 = normal) directly made armor absorb 0% — so armor never degraded and
    // gave no protection. Convert piercing → absorption: 0 piercing = normal
    // 0.66 absorption, 1 piercing = full bypass (0 absorption).
    const armorAbsorption = BASE_ARMOR_ABSORPTION * (1 - event.armorPiercing);
    applyDamage(victim.health, finalDamage, armorAbsorption);

    // ── KNOCKBACK DIRECTION ──
    // Computed once, up here, because BOTH the gameplay impulse below and the
    // kill event further down need it. They used to disagree: the impulse used
    // this normalized, upward-biased vector while the kill event forwarded the
    // RAW authored direction, so the corpse flew along a different vector than
    // the push that killed you.
    let kbDir: { x: number; y: number; z: number } | null = null;
    if (event.knockbackDir) {
      // 1. Normalize raw direction first
      const raw = event.knockbackDir;
      let len = Math.sqrt(raw.x * raw.x + raw.y * raw.y + raw.z * raw.z);
      kbDir = len > 0.001 ? { x: raw.x / len, y: raw.y / len, z: raw.z / len } : { x: 0, y: 1, z: 0 }; // fallback: straight up

      // 2. Apply upward bias to the UNIT vector (guarantees meaningful Y)
      kbDir.y = Math.max(kbDir.y, KB_UPWARD_BIAS);

      // 3. Re-normalize after bias
      len = Math.sqrt(kbDir.x * kbDir.x + kbDir.y * kbDir.y + kbDir.z * kbDir.z);
      kbDir.x /= len;
      kbDir.y /= len;
      kbDir.z /= len;
    }

    // ── KNOCKBACK (queued for movement system) ──
    // Queue impulse for FPSMovementSubsystem to apply BEFORE simulate().
    // This ensures KB bypasses ground friction/clipping.
    if (kbDir && this.movementSubsystem) {
      // Calculate force: knockback magnitude × weapon KB scale.
      // knockbackDamage decouples the push from the dealt damage (0-damage shoves,
      // instagib insta-jump); falls back to the applied damage for normal hits.
      // `finalDamage` already carries the quad multiplier; an explicit
      // knockbackDamage does not, so scale it here to keep quad knockback
      // consistent for decoupled pushes (instagib insta-jump, 0-damage shoves).
      const kbMagnitude = event.knockbackDamage !== undefined ? event.knockbackDamage * powerMultiplier : finalDamage;
      const kbScale = event.knockbackScale ?? DEFAULT_KB_SCALE;
      const isSelf = event.attackerId !== undefined && event.attackerId === event.victimId;
      const selfMult = isSelf ? SELF_KB_MULTIPLIER : 1.0;
      const force = kbMagnitude * kbScale * selfMult;

      // Stun fraction: strip horizontal speed proportional to dealt damage (cap 80%)
      const stunFraction = Math.min(finalDamage / 100, 0.8);

      this.movementSubsystem.queueImpulse({
        entityId: event.victimId,
        dirX: kbDir.x,
        dirY: kbDir.y,
        dirZ: kbDir.z,
        force,
        stunFraction,
      });
    }

    // Store for network forwarding (with final damage value)
    this.damageForStats.push({ victimId: event.victimId, attackerId: event.attackerId, damage: finalDamage });
    this.processedDamage.push({
      victimId: event.victimId,
      attackerId: event.attackerId,
      damage: finalDamage,
      damageType: event.damageType,
      hitLocation: event.hitLocation,
      x: victim.transform?.position.x ?? 0,
      y: victim.transform?.position.y ?? 0,
      z: victim.transform?.position.z ?? 0,
    });

    // Check for kill
    if (victim.health.dead) {
      // Powerups die with the carrier, here rather than at respawn. Clearing them
      // on respawn left a corpse holding the quad for the whole death screen —
      // still flagged as the carrier to every other player, and still carrying it
      // through a round-based mode where respawn may not come until the round does.
      if (victim.powerups) clearPowerups(victim.powerups);

      // Get victim position and velocity for gibs
      const pos = victim.transform?.position ?? { x: 0, y: 0, z: 0 };
      const vel = victim.physics?.velocity ?? { x: 0, y: 0, z: 0 };
      const killEvent: KillEvent = {
        victimId: event.victimId,
        killerId: event.attackerId,
        damageType: event.damageType,
        finalDamage,
        tick,
        victimX: pos.x,
        victimY: pos.y,
        victimZ: pos.z,
        victimVelX: vel.x,
        victimVelY: vel.y,
        victimVelZ: vel.z,
        // The SAME normalized, upward-biased vector the impulse above used, so
        // the ragdoll flies along the push that actually killed the player.
        kbDirX: kbDir?.x ?? 0,
        kbDirY: kbDir?.y ?? 0,
        kbDirZ: kbDir?.z ?? 0,
      };
      this.kills.push(killEvent);
      // NOTE: Respawn queuing is now handled by GametypeController
    }
  }
}
