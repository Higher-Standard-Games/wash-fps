/**
 * Weapon System
 *
 * Handles weapon switching, firing, ammo management.
 * Works for any action game with ranged weapons.
 */

import { Subsystem, type SubsystemConfig } from "@engine/server/core/Subsystem";
import type { WorldState } from "@engine/server/core/WorldState";
import type { Entity } from "@engine/server/ecs/Entity";
import { createProjectileEntity } from "@engine/server/ecs/Entity";
import type { EntityId, TickNumber } from "@engine/server/ecs/types";
import { EntityType, entityId } from "@engine/server/ecs/types";
import type { WeaponLoadout } from "@shared/server/gametype";
import { DEFAULT_VIEWHEIGHT } from "../../../../engine/physics/PlayerPhysicsConstants";
import { computeSpreadSeed, generateSpreadDirections } from "../../../../shared/SpreadUtils";
import { WEAPONS, type WeaponDef } from "../weapons/WeaponDef";
import { type DamageEvent, DamageType, HitLocation } from "./CombatSystem";
import type { DroppedWeaponSystem } from "./DroppedWeaponSystem";
import type { ProjectileSystem } from "./ProjectileSystem";

/** Must match InputButtons.FIRE from engine/network/components/InputComponent.ts */
const FIRE_BUTTON = 1 << 8;
const ALT_FIRE_BUTTON = 1 << 9;

/** Check if a weapon ID is a permanent default weapon (blade/gunblade — slot 0, never dropped) */
function isDefaultWeapon(weaponId: string): boolean {
  return weaponId === "blade" || weaponId === "gunblade";
}

/** Server tick rate (Hz). Fire/reload/charge timing is quantized to these ticks. */
const TICK_RATE = 125;

/**
 * Refire interval in ticks for a weapon. Prefers an explicit `fireIntervalTicks`
 * override, else the *nearest* tick to the authored `fireRate`. Previously this
 * was `Math.floor(125 / fireRate)`, which truncated and made every weapon whose
 * rate doesn't divide 125 fire slightly fast (F1). `round` is the nearest
 * representable cadence; min 1 tick.
 */
export function fireIntervalTicks(weapon: Pick<WeaponDef, "fireRate" | "fireIntervalTicks">): number {
  return Math.max(1, weapon.fireIntervalTicks ?? Math.round(TICK_RATE / weapon.fireRate));
}

/**
 * Event emitted when a weapon is fired, for network broadcast
 */
export interface WeaponFireEvent {
  entityId: EntityId; // shooter entity
  weaponId: string; // weapon id
  originX: number; // fire origin
  originY: number;
  originZ: number;
  dirX: number; // fire direction (normalized)
  dirY: number;
  dirZ: number;
}

/**
 * Event emitted when a player starts or stops charging a weapon
 */
export interface WeaponChargeEvent {
  entityId: EntityId;
  weaponId: string;
  charging: boolean;
}

const CONFIG: SubsystemConfig = {
  name: "Weapon",
  priority: 25, // After input, before combat
  tickRate: 125,
};

// ═══════════════════════════════════════════════════════════════════
// WEAPON STATE
// ═══════════════════════════════════════════════════════════════════

export interface WeaponState {
  currentWeapon: string;
  weapons: string[]; // Owned weapons (max 2, COD-style)
  ammo: Map<string, number>;
  lastFireTick: number;
  reloading: boolean;
  reloadEndTick: number;
  // Charged attack state
  chargeStartTick: number; // Tick when fire button was first held (0 = not charging)
  wasFireButtonDown: boolean; // Edge detection for fire button release
  // Alt-fire state (blade projectile)
  lastAltFireTick: number; // Last tick alt-fire was used
  wasAltFireDown: boolean; // Edge detection for alt-fire release
  // hipfireBlocked: tick when fire was first pressed without ADS (0 = not pending)
  hipfireAdsStartTick: number;
}

// ═══════════════════════════════════════════════════════════════════
// WEAPON SYSTEM
// ═══════════════════════════════════════════════════════════════════

export class WeaponSystem extends Subsystem {
  private weaponStates: Map<EntityId, WeaponState> = new Map();
  private lastWeaponSlot: Map<EntityId, number> = new Map(); // Edge detection for slot changes
  private nextProjectileId: number = 10000;
  private pendingDamage: DamageEvent[] = [];
  private pendingFireEvents: WeaponFireEvent[] = [];
  private pendingChargeEvents: WeaponChargeEvent[] = [];
  private projectileSystem: ProjectileSystem | null = null;
  private droppedWeaponSystem: DroppedWeaponSystem | null = null;
  private movementSubsystem: import("./FPSMovementSubsystem").FPSMovementSubsystem | null = null;
  /** Pending drop positions — set by GameServer before tick when a swap happens */
  private entityPositions: Map<EntityId, { x: number; y: number; z: number }> = new Map();
  /** Per-entity shot counter for deterministic pellet spread seeds */
  private shotCounts: Map<EntityId, number> = new Map();
  /** Delayed melee damage checks — fires visual immediately, checks damage later */
  private pendingMeleeChecks: {
    fireTick: number; // Tick when fire was pressed
    checkTick: number; // Tick when damage should be checked
    shooterId: EntityId; // Who fired
    weapon: WeaponDef; // Weapon definition
  }[] = [];

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
   * Get pending fire events to broadcast to clients
   */
  getPendingFireEvents(): WeaponFireEvent[] {
    const events = this.pendingFireEvents;
    this.pendingFireEvents = [];
    return events;
  }

  /**
   * Get pending charge events to broadcast to clients
   */
  getPendingChargeEvents(): WeaponChargeEvent[] {
    const events = this.pendingChargeEvents;
    this.pendingChargeEvents = [];
    return events;
  }

  /**
   * Get weapon state for a specific entity (used for game state broadcast)
   */
  getWeaponState(entityId: EntityId): WeaponState | undefined {
    return this.weaponStates.get(entityId);
  }

  /**
   * Set reference to ProjectileSystem (for registering projectile types)
   */
  setProjectileSystem(system: ProjectileSystem): void {
    this.projectileSystem = system;
  }

  /**
   * Set reference to DroppedWeaponSystem (for spawning dropped weapons)
   */
  setDroppedWeaponSystem(system: DroppedWeaponSystem): void {
    this.droppedWeaponSystem = system;
  }

  /**
   * Set reference to FPSMovementSubsystem (for weapon speed bonuses)
   */
  setMovementSubsystem(sub: import("./FPSMovementSubsystem").FPSMovementSubsystem): void {
    this.movementSubsystem = sub;
  }

  /**
   * Cache entity position (called by GameServer before tick for drop spawning)
   */
  cacheEntityPosition(eId: EntityId, pos: { x: number; y: number; z: number }): void {
    this.entityPositions.set(eId, pos);
  }

  /**
   * Add a weapon to a player's inventory (server-side pickup).
   * Rules:
   *   - Default weapon (blade/gunblade) is permanent (slot 0), never dropped
   *   - Players can carry default + 2 picked-up weapons
   *   - If at capacity, drop current weapon; if holding default, drop first non-default
   * @returns { added: true, dropped?: weaponId } or { added: false } if already owned
   */
  addWeapon(entityId: EntityId, weaponId: string): { added: boolean; dropped?: string } {
    const state = this.weaponStates.get(entityId);
    if (!state) return { added: false };

    // Already has this weapon — give ammo instead (Warsow behavior)
    if (state.weapons.includes(weaponId)) {
      const weapon = WEAPONS[weaponId];
      if (weapon) {
        const currentAmmo = state.ammo.get(weaponId) || 0;
        const pickupAmount = weapon.pickupAmmo ?? weapon.maxAmmo;
        const newAmmo = Math.min(weapon.maxAmmo, currentAmmo + pickupAmount);
        if (newAmmo > currentAmmo) {
          state.ammo.set(weaponId, newAmmo);
        }
      }
      return { added: false };
    }

    const MAX_PICKABLE = 2; // not counting default weapon
    const nonDefaultWeapons = state.weapons.filter((w) => !isDefaultWeapon(w));

    if (nonDefaultWeapons.length < MAX_PICKABLE) {
      // Have room — just add
      state.weapons.push(weaponId);
      state.currentWeapon = weaponId; // auto-switch to new weapon
      // Reset slot edge detection so manual switch back works after auto-switch
      this.lastWeaponSlot.delete(entityId);
      // Give ammo if not already present
      if (!state.ammo.has(weaponId) || state.ammo.get(weaponId)! <= 0) {
        const weapon = WEAPONS[weaponId];
        if (weapon) state.ammo.set(weaponId, weapon.pickupAmmo ?? weapon.maxAmmo);
      }

      return { added: true };
    }

    // At capacity — need to drop one
    let droppedWeapon: string;

    if (isDefaultWeapon(state.currentWeapon)) {
      // Holding default weapon — can't swap (default is permanent)
      // Player must switch to the weapon they want to drop first

      return { added: false };
    } else {
      // Drop currently held weapon
      droppedWeapon = state.currentWeapon;
    }

    // Queue physical drop — cap ammo at pickupAmmo (one clip worth)
    const weaponDef = WEAPONS[droppedWeapon];
    const playerAmmo = state.ammo.get(droppedWeapon) || 0;
    const droppedAmmo = weaponDef ? Math.min(playerAmmo, weaponDef.pickupAmmo ?? weaponDef.maxAmmo) : playerAmmo;
    const pos = this.entityPositions.get(entityId);
    if (this.droppedWeaponSystem && pos) {
      // Random toss: upward + random horizontal scatter
      const angle = Math.random() * Math.PI * 2;
      const hSpeed = 80 + Math.random() * 60; // 80-140 horizontal
      this.droppedWeaponSystem.queueDrop({
        weaponId: droppedWeapon,
        ammo: droppedAmmo,
        position: { x: pos.x, y: pos.y + 20, z: pos.z },
        velocity: {
          x: Math.cos(angle) * hSpeed,
          y: 180 + Math.random() * 60, // 180-240 upward
          z: Math.sin(angle) * hSpeed,
        },
      });
    }

    // Remove dropped weapon and insert new weapon at same slot position
    const dropIdx = state.weapons.indexOf(droppedWeapon);
    if (dropIdx >= 0) {
      // Replace in-place to maintain stable slot indices (keys 1-2-3)
      state.weapons.splice(dropIdx, 1, weaponId);
    } else {
      state.weapons.push(weaponId);
    }
    state.ammo.delete(droppedWeapon);
    state.currentWeapon = weaponId;
    // Reset slot edge detection so manual switch back works after auto-switch
    this.lastWeaponSlot.delete(entityId);
    // Give ammo if not already present
    if (!state.ammo.has(weaponId) || state.ammo.get(weaponId)! <= 0) {
      const weapon = WEAPONS[weaponId];
      if (weapon) state.ammo.set(weaponId, weapon.maxAmmo);
    }

    return { added: true, dropped: droppedWeapon };
  }

  /**
   * Get a player's current weapon list (for sync/debug)
   */
  getWeapons(entityId: EntityId): string[] {
    return this.weaponStates.get(entityId)?.weapons || [];
  }

  /**
   * Set ammo for a specific weapon (used for dropped weapon ammo transfer)
   */
  setAmmo(entityId: EntityId, weaponId: string, ammo: number): void {
    const state = this.weaponStates.get(entityId);
    if (!state) return;
    const weapon = WEAPONS[weaponId];
    if (weapon) {
      state.ammo.set(weaponId, Math.min(weapon.maxAmmo, ammo));
    }
  }

  /**
   * Get current ammo for a specific weapon
   */
  getAmmo(entityId: EntityId, weaponId: string): number {
    const state = this.weaponStates.get(entityId);
    if (!state) return 0;
    return state.ammo.get(weaponId) || 0;
  }

  /**
   * Drop all non-default weapons (on death).
   * Queues drop requests and strips weapons from inventory.
   */
  dropAllWeapons(eId: EntityId): void {
    const state = this.weaponStates.get(eId);
    if (!state) return;

    const pos = this.entityPositions.get(eId);
    if (!pos || !this.droppedWeaponSystem) return;

    const toDrop = state.weapons.filter((w) => !isDefaultWeapon(w));
    for (let i = 0; i < toDrop.length; i++) {
      const weaponId = toDrop[i];
      const weaponDef = WEAPONS[weaponId];
      const playerAmmo = state.ammo.get(weaponId) || 0;
      // Cap dropped ammo at pickupAmmo (one clip worth)
      const ammo = weaponDef ? Math.min(playerAmmo, weaponDef.pickupAmmo ?? weaponDef.maxAmmo) : playerAmmo;
      // Death scatter: spread weapons in different directions
      const angle = (i / toDrop.length) * Math.PI * 2 + Math.random() * 0.5;
      const hSpeed = 60 + Math.random() * 80;
      this.droppedWeaponSystem.queueDrop({
        weaponId,
        ammo,
        position: { x: pos.x, y: pos.y + 20, z: pos.z },
        velocity: {
          x: Math.cos(angle) * hSpeed,
          y: 200 + Math.random() * 80, // 200-280 upward
          z: Math.sin(angle) * hSpeed,
        },
      });

      const idx = state.weapons.indexOf(weaponId);
      if (idx >= 0) state.weapons.splice(idx, 1);
      state.ammo.delete(weaponId);
    }

    // Reset to default weapon
    const defaultWep = state.weapons.find((w) => isDefaultWeapon(w)) || "blade";
    state.currentWeapon = defaultWep;
  }

  /**
   * Initialize weapon state from a gametype-defined loadout.
   * Called by GametypeController on spawn/respawn.
   */
  initializeWeaponFromLoadout(id: EntityId, loadout: WeaponLoadout): void {
    const ammoMap = new Map<string, number>();
    for (const [weaponId, amount] of Object.entries(loadout.ammo)) {
      ammoMap.set(weaponId, amount);
    }
    // Always include default weapon (blade or gunblade), limit pickable weapons to MAX_PICKABLE (2)
    const defaultWeapon =
      loadout.weapons.find((w) => w === "blade" || w === "gunblade") || loadout.weapons[0] || "blade";
    const nonDefault = loadout.weapons.filter((w) => w !== defaultWeapon).slice(0, 2);
    const weapons = [defaultWeapon, ...nonDefault];
    this.weaponStates.set(id, {
      currentWeapon: weapons[0],
      weapons,
      ammo: ammoMap,
      lastFireTick: 0,
      reloading: false,
      reloadEndTick: 0,
      chargeStartTick: 0,
      wasFireButtonDown: false,
      lastAltFireTick: 0,
      wasAltFireDown: false,
      hipfireAdsStartTick: 0,
    });
    // Reset edge detection so weapon slot changes are detected cleanly after respawn
    this.lastWeaponSlot.delete(id);
  }

  /**
   * Initialize weapon state for an entity (fallback with default loadout)
   */
  initializeWeapon(entityId: EntityId): void {
    this.initializeWeaponFromLoadout(entityId, {
      weapons: ["blade"],
      ammo: {
        blade: 1,
        machinegun: 100,
        riotgun: 20,
        glauncher: 20,
        rlauncher: 20,
        plasmagun: 150,
        voltaic: 150,
        electrobolt: 10,
        instagun: 5,
      },
      health: 100,
      armor: 0,
    });
  }

  update(state: WorldState, _dt: number, tick: TickNumber): void {
    const tickNum = tick as number;

    // Process delayed melee damage checks
    // Damage is checked using the shooter's CURRENT aim, not aim at fire time
    // This gives targets a dodge window (meleeDamageDelay)
    for (let i = this.pendingMeleeChecks.length - 1; i >= 0; i--) {
      const check = this.pendingMeleeChecks[i];
      if (tickNum >= check.checkTick) {
        // Find shooter entity at current tick
        const shooter = state.getEntity(check.shooterId);
        if (shooter && shooter.transform && shooter.input && !shooter.health?.dead) {
          this.fireMelee(state, shooter, check.weapon);
        }
        this.pendingMeleeChecks.splice(i, 1);
      }
    }

    // Process all player entities
    for (const entity of state.entitiesByType(EntityType.Player)) {
      if (!entity.input || !entity.health || entity.health.dead) {
        continue;
      }

      let weaponState = this.weaponStates.get(entity.id);
      if (!weaponState) {
        this.initializeWeapon(entity.id);
        weaponState = this.weaponStates.get(entity.id)!;
      }

      // Handle weapon switch — only on CHANGE (edge detection)
      // This prevents the client's weaponSlot from overriding server-side
      // pickup auto-switch every tick.
      const weaponSlot = entity.input.weaponSlot;
      const prevSlot = this.lastWeaponSlot.get(entity.id) || 0;
      this.lastWeaponSlot.set(entity.id, weaponSlot);

      if (weaponSlot !== prevSlot && weaponSlot > 0 && weaponSlot <= weaponState.weapons.length) {
        const newWeapon = weaponState.weapons[weaponSlot - 1];
        if (newWeapon && newWeapon !== weaponState.currentWeapon) {
          weaponState.currentWeapon = newWeapon;
          weaponState.reloading = false; // Cancel reload on switch
          weaponState.chargeStartTick = 0; // Cancel charge on switch
        }
      }

      // Handle reload completion
      if (weaponState.reloading && tickNum >= weaponState.reloadEndTick) {
        weaponState.reloading = false;
        // Refill ammo (simplified - would normally pull from reserve)
        const weapon = WEAPONS[weaponState.currentWeapon];
        if (weapon) {
          weaponState.ammo.set(weaponState.currentWeapon, weapon.maxAmmo);
        }
      }

      // Handle firing — check raw buttons bitmask (entity.input.attack is never set;
      // FPSMovementSubsystem only populates input.buttons from the inputQueue)
      const isFiring = (entity.input.buttons & FIRE_BUTTON) !== 0;
      const isAltFiring = (entity.input.buttons & ALT_FIRE_BUTTON) !== 0;
      const weapon = WEAPONS[weaponState.currentWeapon];

      // Set weapon speed bonus on movement subsystem
      if (this.movementSubsystem) {
        this.movementSubsystem.setSpeedBonus(entity.id as number, weapon?.speedBonus ?? 0);
      }

      if (weapon && !weaponState.reloading) {
        // === MELEE WEAPON LOGIC (blade) ===
        // FIRE = melee slash, ALT_FIRE = hold-to-charge projectile
        if (weapon.meleeRadius && weapon.chargedProjectileId) {
          // Keep ammo at max (infinite melee)
          weaponState.ammo.set(weaponState.currentWeapon, weapon.maxAmmo);

          // --- Primary fire: melee slash (semi-auto on press) ---
          if (isFiring && !weaponState.wasFireButtonDown) {
            const fireInterval = fireIntervalTicks(weapon);
            const timeSinceFire = tickNum - weaponState.lastFireTick;
            if (timeSinceFire >= fireInterval) {
              // Fire visual event immediately (animation + sound)
              if (entity.transform && entity.input) {
                const yaw = entity.input.yaw;
                const pitch = -entity.input.pitch;
                this.pendingFireEvents.push({
                  entityId: entity.id,
                  weaponId: weapon.id,
                  originX: entity.transform.position.x,
                  originY: entity.transform.position.y,
                  originZ: entity.transform.position.z,
                  dirX: Math.sin(yaw) * Math.cos(pitch),
                  dirY: Math.sin(pitch),
                  dirZ: Math.cos(yaw) * Math.cos(pitch),
                });
              }

              // Queue delayed melee damage check
              const delayTicks = Math.ceil((weapon.meleeDamageDelay || 0) * 125);
              if (delayTicks > 0) {
                this.pendingMeleeChecks.push({
                  fireTick: tickNum,
                  checkTick: tickNum + delayTicks,
                  shooterId: entity.id,
                  weapon: weapon,
                });
              } else {
                // No delay — fire immediately
                this.fireMelee(state, entity, weapon);
              }
              weaponState.lastFireTick = tickNum;
            }
          }
          weaponState.wasFireButtonDown = isFiring;

          // --- Alt fire: hold-to-charge projectile ---
          const chargeMaxTicks = Math.ceil((weapon.chargeTime || 1.0) * 125);
          const chargeMinTicks = Math.ceil((weapon.chargeMinTime || 0.5) * 125);

          if (isAltFiring) {
            if (!weaponState.wasAltFireDown) {
              // ALT_FIRE just pressed — start charging
              weaponState.chargeStartTick = tickNum;
              // Emit charge start event
              this.pendingChargeEvents.push({
                entityId: entity.id,
                weaponId: weapon.id,
                charging: true,
              });
            }
            // While held: charging (no action)
          } else if (weaponState.wasAltFireDown) {
            // ALT_FIRE just released — fire if charged enough
            const heldTicks = tickNum - weaponState.chargeStartTick;

            if (heldTicks >= chargeMinTicks) {
              // Clamp charge to max
              const clampedTicks = Math.min(heldTicks, chargeMaxTicks);
              // Linear damage: min at chargeMinTicks, max at chargeMaxTicks
              const chargeRatio = (clampedTicks - chargeMinTicks) / Math.max(1, chargeMaxTicks - chargeMinTicks);
              const dmgMin = weapon.chargedDamageMin ?? 25;
              const dmgMax = weapon.chargedDamageMax ?? weapon.chargedDamage ?? 50;
              const damage = Math.round(dmgMin + chargeRatio * (dmgMax - dmgMin));

              this.fireChargedProjectile(state, entity, weapon, damage);
              weaponState.lastAltFireTick = tickNum;
            }
            // If released too early, charge cancelled — no fire
            weaponState.chargeStartTick = 0;
            // Emit charge stop event (whether fired or cancelled)
            this.pendingChargeEvents.push({
              entityId: entity.id,
              weaponId: weapon.id,
              charging: false,
            });
          }
          weaponState.wasAltFireDown = isAltFiring;
        } else {
          // === STANDARD WEAPON LOGIC ===
          // hipfireBlocked: determine if fire is allowed this tick
          let hipfireAllowFire = true;

          if (isFiring && weapon.hipfireBlocked) {
            // On fire button edge (just pressed), decide: was player already ADS?
            if (!weaponState.wasFireButtonDown) {
              if (weaponState.wasAltFireDown) {
                // Player was holding ADS BEFORE pressing fire — no delay
                weaponState.hipfireAdsStartTick = -1; // sentinel: pre-ADS
              } else {
                // Fire pressed from hip — start ADS delay
                weaponState.hipfireAdsStartTick = tickNum;
              }
            }

            // If started from hip, enforce ADS transition delay
            if (weaponState.hipfireAdsStartTick > 0) {
              const adsTimeTicks = Math.ceil((weapon.ads?.time || 0.08) * 125);
              if (tickNum - weaponState.hipfireAdsStartTick < adsTimeTicks) {
                hipfireAllowFire = false; // Still in ADS transition
              }
            }
            // hipfireAdsStartTick === -1 means pre-ADS, fire immediately
          }

          if (isFiring && hipfireAllowFire) {
            const fireInterval = fireIntervalTicks(weapon); // ticks between shots
            const timeSinceFire = tickNum - weaponState.lastFireTick;

            if (timeSinceFire >= fireInterval) {
              const ammo = weaponState.ammo.get(weaponState.currentWeapon) || 0;
              if (ammo > 0) {
                this.fireWeapon(state, entity, weapon, tick);
                const newAmmo = ammo - 1;
                weaponState.ammo.set(weaponState.currentWeapon, newAmmo);

                weaponState.lastFireTick = tickNum;

                // Auto-reload when ammo depleted
                if (newAmmo <= 0) {
                  weaponState.reloading = true;
                  weaponState.reloadEndTick = tickNum + Math.ceil(weapon.reloadTime * 125);
                }
              }
            }
          }

          if (!isFiring) {
            // Fire released — reset hipfire ADS timer
            weaponState.hipfireAdsStartTick = 0;
          }

          // Always track fire + alt-fire state for edge detection
          weaponState.wasFireButtonDown = isFiring;
          weaponState.wasAltFireDown = isAltFiring;
        }
      }
    }
  }

  private fireWeapon(state: WorldState, shooter: Readonly<Entity>, weapon: WeaponDef, tick: TickNumber): void {
    // Emit fire event for network broadcast
    if (shooter.transform && shooter.input) {
      // yaw/pitch are already in radians from the client (Babylon.js camera)
      // Negate pitch: Babylon uses negative rotationX for looking UP
      const yaw = shooter.input.yaw;
      const pitch = -shooter.input.pitch;
      this.pendingFireEvents.push({
        entityId: shooter.id,
        weaponId: weapon.id,
        originX: shooter.transform.position.x,
        originY: shooter.transform.position.y,
        originZ: shooter.transform.position.z,
        dirX: Math.sin(yaw) * Math.cos(pitch),
        dirY: Math.sin(pitch),
        dirZ: Math.cos(yaw) * Math.cos(pitch),
      });
    }

    // Route to melee or ranged
    if (weapon.meleeRadius) {
      this.fireMelee(state, shooter, weapon);
    } else if (weapon.hitscan) {
      this.fireHitscan(state, shooter, weapon, tick);
    } else {
      this.fireProjectile(state, shooter, weapon);
    }
  }

  /**
   * Melee attack — cone check for all players within range and meleeRadius.
   * Hits all targets in the forward cone (~60° half-angle).
   */
  private fireMelee(state: WorldState, shooter: Readonly<Entity>, weapon: WeaponDef): void {
    if (!shooter.transform || !shooter.input) return;

    const yaw = shooter.input.yaw;
    const pitch = -shooter.input.pitch;
    const maxRange = weapon.range || 100;
    const hitRadius = weapon.meleeRadius || 32;

    // Aim direction
    const dir = {
      x: Math.sin(yaw) * Math.cos(pitch),
      y: Math.sin(pitch),
      z: Math.cos(yaw) * Math.cos(pitch),
    };

    const start = shooter.transform.position;

    // Cosine of 60° half-angle cone
    const coneCos = 0.5;

    for (const target of state.entitiesByType(EntityType.Player)) {
      if (target.id === shooter.id) continue;
      if (!target.transform || !target.health || target.health.dead) continue;

      // Vector to target
      const toTarget = {
        x: target.transform.position.x - start.x,
        y: target.transform.position.y - start.y,
        z: target.transform.position.z - start.z,
      };

      // Distance to target
      const dist = Math.sqrt(toTarget.x ** 2 + toTarget.y ** 2 + toTarget.z ** 2);
      if (dist > maxRange + hitRadius) continue; // Too far
      if (dist < 0.01) continue; // On top of us

      // Normalize
      const toTargetN = {
        x: toTarget.x / dist,
        y: toTarget.y / dist,
        z: toTarget.z / dist,
      };

      // Dot product with aim direction (cone check)
      const dot = dir.x * toTargetN.x + dir.y * toTargetN.y + dir.z * toTargetN.z;

      // Must be within cone OR within melee radius of the ray
      if (dot < coneCos && dist > hitRadius) continue;

      // Project onto ray for perpendicular distance check
      const projDist = toTarget.x * dir.x + toTarget.y * dir.y + toTarget.z * dir.z;
      if (projDist < -hitRadius || projDist > maxRange + hitRadius) continue;

      const closestPoint = {
        x: start.x + dir.x * Math.max(0, projDist),
        y: start.y + dir.y * Math.max(0, projDist),
        z: start.z + dir.z * Math.max(0, projDist),
      };

      const perpDistSq =
        (closestPoint.x - target.transform.position.x) ** 2 +
        (closestPoint.y - target.transform.position.y) ** 2 +
        (closestPoint.z - target.transform.position.z) ** 2;

      if (perpDistSq > (hitRadius + 32) ** 2) continue; // 32 = player capsule radius

      // Hit!
      const yOffset = closestPoint.y - target.transform.position.y;
      let hitLocation = HitLocation.Body;
      if (yOffset > 32) hitLocation = HitLocation.Head;
      else if (yOffset < -20) hitLocation = HitLocation.Legs;

      this.pendingDamage.push({
        victimId: target.id,
        attackerId: shooter.id,
        damage: weapon.damage,
        armorPiercing: 0,
        damageType: DamageType.Melee,
        hitLocation,
        knockbackDir: { x: dir.x, y: 0.3, z: dir.z }, // Slight upward knockback
        knockbackScale: weapon.knockbackScale,
      });
    }
  }

  /**
   * Fire the charged projectile (blade blast).
   * Uses the weapon's chargedProjectileId to spawn a projectile.
   * @param damageOverride - scaled damage based on charge time
   */
  private fireChargedProjectile(
    state: WorldState,
    shooter: Readonly<Entity>,
    weapon: WeaponDef,
    damageOverride?: number,
  ): void {
    if (!shooter.transform || !shooter.input || !shooter.ownerId) return;

    // Emit fire event for network broadcast
    const yaw = shooter.input.yaw;
    const pitch = -shooter.input.pitch;
    this.pendingFireEvents.push({
      entityId: shooter.id,
      weaponId: weapon.id,
      originX: shooter.transform.position.x,
      originY: shooter.transform.position.y,
      originZ: shooter.transform.position.z,
      dirX: Math.sin(yaw) * Math.cos(pitch),
      dirY: Math.sin(pitch),
      dirZ: Math.cos(yaw) * Math.cos(pitch),
    });

    // Use weapon's projectile speed or default
    const speed = weapon.projectileSpeed || 2500;
    const velocity = {
      x: Math.sin(yaw) * Math.cos(pitch) * speed,
      y: Math.sin(pitch) * speed,
      z: Math.cos(yaw) * Math.cos(pitch) * speed,
    };

    const offset = 50;
    const position = {
      x: shooter.transform.position.x + Math.sin(yaw) * Math.cos(pitch) * offset,
      y: shooter.transform.position.y + DEFAULT_VIEWHEIGHT + Math.sin(pitch) * offset,
      z: shooter.transform.position.z + Math.cos(yaw) * Math.cos(pitch) * offset,
    };

    const projectile = createProjectileEntity(entityId(this.nextProjectileId++), shooter.ownerId, position, velocity);

    state.addEntity(projectile);

    // Register with ProjectileSystem (pass damageOverride for charge scaling)
    if (this.projectileSystem) {
      this.projectileSystem.registerProjectileType(projectile.id, weapon.chargedProjectileId || weapon.id, {
        bounces: 0,
        lifetime: 5.0,
        gravity: 0,
        damageOverride,
      });
    }
  }

  private fireHitscan(state: WorldState, shooter: Readonly<Entity>, weapon: WeaponDef, _tick: TickNumber): void {
    if (!shooter.transform || !shooter.input) return;

    // Calculate fire direction from view angles (already in radians)
    // Negate pitch: Babylon uses negative rotationX for looking UP
    const yaw = shooter.input.yaw;
    const pitch = -shooter.input.pitch;

    const start = {
      x: shooter.transform.position.x,
      y: shooter.transform.position.y + DEFAULT_VIEWHEIGHT,
      z: shooter.transform.position.z,
    };
    const maxRange = weapon.range || 5000;

    // Pellet weapons (riotgun): fire N rays with seeded spread
    if (weapon.pelletCount && weapon.pelletCount > 1 && weapon.spread) {
      // Increment shot count for seed uniqueness
      const shotCount = (this.shotCounts.get(shooter.id) || 0) + 1;
      this.shotCounts.set(shooter.id, shotCount);

      // Use adsSpread when player is aiming down sights (ALT_FIRE button)
      const ALT_FIRE_BUTTON = 1 << 9;
      const isADS = (shooter.input.buttons & ALT_FIRE_BUTTON) !== 0;
      const spreadDeg = isADS && weapon.adsSpread !== undefined ? weapon.adsSpread : weapon.spread;

      const seed = computeSpreadSeed(_tick as number, shooter.id as number, shotCount);
      const directions = generateSpreadDirections(seed, weapon.pelletCount, spreadDeg, yaw, shooter.input.pitch);

      // Trace each pellet individually
      for (const dir of directions) {
        this.traceHitscanRay(state, shooter, weapon, start, dir, maxRange);
      }
      return;
    }

    // Standard single-ray hitscan (machinegun, electrobolt, etc.)
    // Use the same look-direction convention as fireProjectile/fireMelee and the
    // pendingFireEvents tracer visual: dir.y = sin(-input.pitch). This previously
    // double-negated (`const p = -pitch`, where pitch is already -input.pitch),
    // inverting vertical aim so the damage ray disagreed with the tracer and every
    // other fire path — machinegun/electrobolt/instagun hit low when aiming up (F2).
    const dir = {
      x: Math.sin(yaw) * Math.cos(pitch),
      y: Math.sin(pitch),
      z: Math.cos(yaw) * Math.cos(pitch),
    };
    this.traceHitscanRay(state, shooter, weapon, start, dir, maxRange);
  }

  /**
   * Trace a single hitscan ray and register damage for hit targets.
   */
  private traceHitscanRay(
    state: WorldState,
    shooter: Readonly<Entity>,
    weapon: WeaponDef,
    start: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxRange: number,
  ): void {
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
        if (yOffset > 32) hitLocation = HitLocation.Head;
        else if (yOffset < -20) hitLocation = HitLocation.Legs;

        this.pendingDamage.push({
          victimId: target.id,
          attackerId: shooter.id,
          damage: weapon.damage,
          armorPiercing: 0,
          damageType: this.weaponToDamageType(weapon.id),
          hitLocation,
          knockbackDir: { x: dir.x, y: dir.y, z: dir.z },
          knockbackScale: weapon.knockbackScale,
        });

        // Single-ray weapons break on first hit; pellet rays always break
        // (each pellet is its own ray call)
        break;
      }
    }
  }

  private fireProjectile(state: WorldState, shooter: Readonly<Entity>, weapon: WeaponDef): void {
    if (!shooter.transform || !shooter.input || !shooter.ownerId) return;

    // Calculate fire direction (already in radians from client)
    // Negate pitch: Babylon uses negative rotationX for looking UP
    let yaw = shooter.input.yaw;
    let pitch = -shooter.input.pitch;

    // Apply random spread if weapon has it (e.g. plasmagun hipfire)
    if (weapon.spread) {
      const isADS = (shooter.input.buttons & ALT_FIRE_BUTTON) !== 0;
      const spreadDeg = isADS && weapon.adsSpread !== undefined ? weapon.adsSpread : weapon.spread;
      if (spreadDeg > 0) {
        const spreadRad = (spreadDeg * Math.PI) / 180;
        yaw += (Math.random() - 0.5) * spreadRad;
        pitch += (Math.random() - 0.5) * spreadRad;
      }
    }

    const speed = weapon.projectileSpeed || 1000;
    const velocity = {
      x: Math.sin(yaw) * Math.cos(pitch) * speed,
      y: Math.sin(pitch) * speed,
      z: Math.cos(yaw) * Math.cos(pitch) * speed,
    };

    // Spawn projectile slightly in front of shooter, along look direction
    // Q3-style: spawn point follows crosshair (pitch-aware), not fixed eye height
    const offset = 50;
    const position = {
      x: shooter.transform.position.x + Math.sin(yaw) * Math.cos(pitch) * offset,
      y: shooter.transform.position.y + DEFAULT_VIEWHEIGHT + Math.sin(pitch) * offset,
      z: shooter.transform.position.z + Math.cos(yaw) * Math.cos(pitch) * offset,
    };

    const projectile = createProjectileEntity(entityId(this.nextProjectileId++), shooter.ownerId, position, velocity);

    state.addEntity(projectile);

    // Register projectile type with ProjectileSystem for impact events
    if (this.projectileSystem) {
      // Per-projectile behavior based on weapon type
      const isGrenade = weapon.id === "glauncher";
      this.projectileSystem.registerProjectileType(projectile.id, weapon.id, {
        bounces: isGrenade ? 3 : 0,
        lifetime: isGrenade ? 2.0 : 10.0,
        gravity: weapon.projectileGravity ?? 0, // 0 = straight (F6); grenades set it explicitly
      });
    }
  }

  private weaponToDamageType(weaponId: string): DamageType {
    switch (weaponId) {
      case "gunblade":
        return DamageType.Melee;
      case "blade":
        return DamageType.Melee;
      case "machinegun":
        return DamageType.Bullet;
      case "riotgun":
        return DamageType.Bullet;
      case "glauncher":
        return DamageType.Explosion;
      case "rlauncher":
        return DamageType.Explosion;
      case "plasmagun":
        return DamageType.Plasma;
      case "voltaic":
        return DamageType.Plasma;
      case "electrobolt":
        return DamageType.Rail;
      case "instagun":
        return DamageType.Rail;
      default:
        return DamageType.Bullet;
    }
  }
}
