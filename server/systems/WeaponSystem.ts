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
import { type CollisionWorld, SHOT_CONTENT_MASK } from "../../../../engine/network/systems/collision/CollisionWorld";
import { DEFAULT_VIEWHEIGHT } from "../../../../engine/physics/PlayerPhysicsConstants";
import { rngFrom } from "../../../../shared/DeterministicRng";
import { GRENADE } from "../../../../shared/entities/definitions/projectiles/grenade";
import { canonicalWeaponId, WEAPONS } from "../../../../shared/entities/definitions/weapons/WeaponsTable";
import type { ProjectileDef } from "../../../../shared/entities/ProjectileDef";
import type { WeaponDef } from "../../../../shared/entities/WeaponDef";
import { computeSpreadSeed, generateSpreadDirections } from "../../../../shared/SpreadUtils";
import { type DamageEvent, DamageType, HitLocation } from "./CombatSystem";
import type { DroppedWeaponSystem } from "./DroppedWeaponSystem";
import type { ProjectileSystem } from "./ProjectileSystem";

/** Must match InputButtons.FIRE from engine/network/components/InputComponent.ts */
const FIRE_BUTTON = 1 << 8;
const ALT_FIRE_BUTTON = 1 << 9;
const RELOAD_BUTTON = 1 << 10;

/** Check if a weapon ID is the permanent default weapon (blade — slot 0, never dropped) */
function isDefaultWeapon(weaponId: string): boolean {
  return weaponId === "blade";
}

/** Server tick rate (Hz). Fire/reload/charge timing is quantized to these ticks. */
const TICK_RATE = 125;

const PROJECTILE_DEFS: Record<string, ProjectileDef> = {
  [GRENADE.id]: GRENADE,
};

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

/**
 * Event emitted when a chain-lightning beam arcs between targets, so clients can
 * draw the arcs. `points` is the ordered link chain (primary hit first, then hops).
 */
export interface WeaponChainEvent {
  entityId: EntityId; // shooter
  points: { x: number; y: number; z: number }[];
}

/** Authoritative truth spine for the procedural Voltaic presentation. */
export interface VoltaicBeamEvent {
  entityId: EntityId;
  originX: number;
  originY: number;
  originZ: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  endX: number;
  endY: number;
  endZ: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  impactKind: 0 | 1 | 2;
}

/** Authoritative rail truth for the Electrobolt presentation — identical shape to {@link VoltaicBeamEvent}. */
export type ElectroRailEvent = VoltaicBeamEvent;

interface HitscanHitResult {
  id: EntityId;
  position: { x: number; y: number; z: number };
  hitLocation: HitLocation;
  impactPoint: { x: number; y: number; z: number };
  impactNormal: { x: number; y: number; z: number };
}

const CONFIG: SubsystemConfig = {
  name: "Weapon",
  priority: 25, // After input, before combat
  tickRate: 0, // every base tick — the rate comes from ServerTiming, not a per-subsystem literal (QA-24)
};

// ═══════════════════════════════════════════════════════════════════
// WEAPON STATE
// ═══════════════════════════════════════════════════════════════════

export interface WeaponState {
  currentWeapon: string;
  weapons: string[]; // Owned weapons (max 2, COD-style)
  ammo: Map<string, WeaponAmmo>;
  lastFireTick: number;
  reloading: boolean;
  reloadEndTick: number;
  // Charged attack state
  chargeStartTick: number; // Tick when fire button was first held (0 = not charging)
  wasFireButtonDown: boolean; // Edge detection for fire button release
  // Alt-fire state (blade projectile)
  lastAltFireTick: number; // Last tick alt-fire was used
  wasAltFireDown: boolean; // Edge detection for alt-fire release
  wasReloadButtonDown: boolean; // Edge detection for manual reload
  // hipfireBlocked: tick when fire was first pressed without ADS (0 = not pending)
  hipfireAdsStartTick: number;
}

export interface WeaponAmmo {
  clip: number;
  reserve: number;
}

// ═══════════════════════════════════════════════════════════════════
// WEAPON SYSTEM
// ═══════════════════════════════════════════════════════════════════

export class WeaponSystem extends Subsystem {
  private weaponStates: Map<EntityId, WeaponState> = new Map();
  private lastWeaponSlot: Map<EntityId, number> = new Map(); // Edge detection for slot changes
  private lastSwitchTick: Map<EntityId, number> = new Map();
  /**
   * Per-entity accuracy accounting for anti-cheat telemetry (WO-AC1). Scoped to
   * **single-ray hitscan** (machinegun/electrobolt/instagun/Voltaic, including
   * legacy `lasergun` IDs) — the
   * cleanest signal, where one trigger pull = one ray = 0 or 1 hit. Pellet and
   * projectile/splash weapons are excluded (a blast has no clean shot↔hit mapping).
   * Cumulative per entity id (≈ per-match), composed into the [Telemetry] log by
   * GameServer, which owns the entity→player mapping.
   */
  private accuracy: Map<EntityId, { shots: number; hits: number; headshots: number }> = new Map();
  /** Current sim tick, captured each update() — seeds deterministic RNG for drop
   *  scatter / projectile spread so the sim is reproducible for demo re-sim (R3). */
  private currentTick = 0;
  private nextProjectileId: number = 10000;
  private pendingDamage: DamageEvent[] = [];
  private pendingFireEvents: WeaponFireEvent[] = [];
  private pendingChargeEvents: WeaponChargeEvent[] = [];
  private pendingChainEvents: WeaponChainEvent[] = [];
  private pendingVoltaicBeamEvents: VoltaicBeamEvent[] = [];
  private pendingElectroRailEvents: ElectroRailEvent[] = [];
  private projectileSystem: ProjectileSystem | null = null;
  private droppedWeaponSystem: DroppedWeaponSystem | null = null;
  private collisionWorld: CollisionWorld | null = null;
  /** Gametype self-damage multiplier (1.0 = full, 0 = none). Mirrors ProjectileSystem. */
  selfDamageMultiplier: number = 1.0;
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
  private static readonly SWITCH_INTERVAL_TICKS = 25;

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
   * Get pending chain-lightning arc events to broadcast to clients
   */
  getPendingChainEvents(): WeaponChainEvent[] {
    const events = this.pendingChainEvents;
    this.pendingChainEvents = [];
    return events;
  }

  getPendingVoltaicBeamEvents(): VoltaicBeamEvent[] {
    const events = this.pendingVoltaicBeamEvents;
    this.pendingVoltaicBeamEvents = [];
    return events;
  }

  getPendingElectroRailEvents(): ElectroRailEvent[] {
    const events = this.pendingElectroRailEvents;
    this.pendingElectroRailEvents = [];
    return events;
  }

  /** Clear actions produced during warmup; player loadouts are rebuilt on respawn. */
  resetForMatch(): void {
    this.pendingDamage = [];
    this.pendingFireEvents = [];
    this.pendingChargeEvents = [];
    this.pendingChainEvents = [];
    this.pendingVoltaicBeamEvents = [];
    this.pendingElectroRailEvents = [];
    this.pendingMeleeChecks = [];
    this.entityPositions.clear();
    this.accuracy.clear();
    this.shotCounts.clear();
  }

  /**
   * Get weapon state for a specific entity (used for game state broadcast)
   */
  getWeaponState(entityId: EntityId): WeaponState | undefined {
    return this.weaponStates.get(entityId);
  }

  /**
   * Cumulative single-ray-hitscan accuracy for an entity (WO-AC1). GameServer maps
   * entity→player and composes accuracy%/headshot% (min-sample gated) into telemetry.
   */
  getAccuracy(entityId: EntityId): { shots: number; hits: number; headshots: number } {
    return this.accuracy.get(entityId) ?? { shots: 0, hits: 0, headshots: 0 };
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
   * Set collision world (for hitscan splash weapons — instagun world-impact
   * knockback / insta-jump).
   */
  setCollisionWorld(world: CollisionWorld): void {
    this.collisionWorld = world;
  }

  /**
   * Set reference to FPSMovementSubsystem (for weapon speed bonuses)
   */
  setMovementSubsystem(sub: import("./FPSMovementSubsystem").FPSMovementSubsystem): void {
    this.movementSubsystem = sub;
  }

  private getFireViewOrigin(shooter: Readonly<Entity>): { x: number; y: number; z: number } | null {
    if (!shooter.transform) return null;
    const pos = shooter.transform.position;
    return {
      x: pos.x,
      y: pos.y + DEFAULT_VIEWHEIGHT + (shooter.physics?.crouchViewOffset ?? 0),
      z: pos.z,
    };
  }

  /**
   * Cache entity position (called by GameServer before tick for drop spawning)
   */
  cacheEntityPosition(eId: EntityId, pos: { x: number; y: number; z: number }): void {
    this.entityPositions.set(eId, pos);
  }

  private reloadModel(weapon: WeaponDef): "clip" | "pool" | "none" {
    return weapon.reloadModel ?? "pool";
  }

  private maxTotalAmmo(weapon: WeaponDef): number {
    const model = this.reloadModel(weapon);
    if (model === "none") return weapon.maxAmmo || 1;
    if (model === "clip") return Math.max(0, weapon.clipSize) + Math.max(0, weapon.maxAmmo);
    return Math.max(0, weapon.maxAmmo);
  }

  private createAmmoState(weapon: WeaponDef, amount: number): WeaponAmmo {
    const total = Math.max(0, Math.min(this.maxTotalAmmo(weapon), Math.floor(amount)));
    const model = this.reloadModel(weapon);

    if (model === "none") {
      return { clip: weapon.maxAmmo || 1, reserve: 0 };
    }

    if (model === "clip") {
      const clip = Math.min(Math.max(0, weapon.clipSize), total);
      return { clip, reserve: Math.min(Math.max(0, weapon.maxAmmo), Math.max(0, total - clip)) };
    }

    return { clip: Math.min(Math.max(0, weapon.maxAmmo), total), reserve: 0 };
  }

  private ammoTotal(ammo: WeaponAmmo | undefined): number {
    return ammo ? ammo.clip + ammo.reserve : 0;
  }

  private getAmmoState(state: WeaponState, weapon: WeaponDef): WeaponAmmo {
    let ammo = state.ammo.get(weapon.id);
    if (!ammo) {
      ammo = this.createAmmoState(weapon, 0);
      state.ammo.set(weapon.id, ammo);
    }
    return ammo;
  }

  private addAmmo(state: WeaponState, weapon: WeaponDef, amount: number): void {
    const add = Math.max(0, Math.floor(amount));
    if (add <= 0 || this.reloadModel(weapon) === "none") return;

    const ammo = this.getAmmoState(state, weapon);
    if (this.reloadModel(weapon) === "clip") {
      ammo.reserve = Math.min(weapon.maxAmmo, ammo.reserve + add);
      return;
    }

    ammo.clip = Math.min(weapon.maxAmmo, ammo.clip + add);
  }

  private consumeShot(state: WeaponState, weapon: WeaponDef): boolean {
    const model = this.reloadModel(weapon);
    if (model === "none") return true;

    const ammo = this.getAmmoState(state, weapon);
    if (ammo.clip < 1) return false;
    ammo.clip -= 1;
    return true;
  }

  private canReload(state: WeaponState, weapon: WeaponDef): boolean {
    if (this.reloadModel(weapon) !== "clip") return false;
    const ammo = this.getAmmoState(state, weapon);
    return ammo.clip < weapon.clipSize && ammo.reserve > 0;
  }

  private startReload(state: WeaponState, weapon: WeaponDef, tickNum: number): void {
    if (state.reloading || !this.canReload(state, weapon)) return;
    state.reloading = true;
    state.reloadEndTick = tickNum + Math.ceil(weapon.reloadTime * TICK_RATE);
  }

  private finishReload(state: WeaponState, weapon: WeaponDef): void {
    state.reloading = false;
    if (this.reloadModel(weapon) !== "clip") return;

    const ammo = this.getAmmoState(state, weapon);
    const needed = Math.max(0, weapon.clipSize - ammo.clip);
    const moved = Math.min(needed, ammo.reserve);
    ammo.clip += moved;
    ammo.reserve -= moved;
  }

  /** Add ammo to owned weapons that use the given ammo type. Returns true if any ammo increased. */
  addAmmoByType(entityId: EntityId, ammoType: string, amount: number): boolean {
    const state = this.weaponStates.get(entityId);
    if (!state) return false;

    let changed = false;
    for (const weaponId of state.weapons) {
      const weapon = WEAPONS[weaponId];
      if (!weapon || weapon.ammoType !== ammoType || this.reloadModel(weapon) === "none") continue;

      const before = this.ammoTotal(state.ammo.get(weaponId));
      this.addAmmo(state, weapon, amount);
      const after = this.ammoTotal(state.ammo.get(weaponId));
      if (after > before) changed = true;
    }

    return changed;
  }
  /**
   * Add a weapon to a player's inventory (server-side pickup).
   * Rules:
   *   - Default weapon (blade) is permanent (slot 0), never dropped
   *   - Players can carry default + 2 picked-up weapons
   *   - If at capacity, drop current weapon; if holding default, drop first non-default
   * @returns { added: true, dropped?: weaponId } or { added: false } if already owned
   */
  addWeapon(entityId: EntityId, weaponId: string): { added: boolean; dropped?: string } {
    const state = this.weaponStates.get(entityId);
    if (!state) return { added: false };
    weaponId = canonicalWeaponId(weaponId);

    // Already has this weapon — give ammo instead
    if (state.weapons.includes(weaponId)) {
      const weapon = WEAPONS[weaponId];
      if (weapon) {
        const pickupAmount = weapon.pickupAmmo ?? weapon.maxAmmo;
        this.addAmmo(state, weapon, pickupAmount);
      }
      // Holding the blade means you have nothing to shoot with, and walking
      // over a gun is an unambiguous request for one. Owning it already —
      // spawned with it, or out of ammo for it — does not make the request any
      // less clear, so the switch happens on this path too.
      if (isDefaultWeapon(state.currentWeapon) && !isDefaultWeapon(weaponId)) {
        state.currentWeapon = weaponId;
        this.lastWeaponSlot.delete(entityId);
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
      if (!state.ammo.has(weaponId) || this.ammoTotal(state.ammo.get(weaponId)) <= 0) {
        const weapon = WEAPONS[weaponId];
        if (weapon)
          state.ammo.set(weaponId, this.createAmmoState(weapon, weapon.pickupAmmo ?? this.maxTotalAmmo(weapon)));
      }

      return { added: true };
    }

    // At capacity — need to drop one
    let droppedWeapon: string;

    if (isDefaultWeapon(state.currentWeapon)) {
      // Holding the blade at capacity. The blade itself can never be dropped,
      // so there is nothing to swap out and the pickup is declined — but the
      // walk-over still says "I want a gun", and we are holding the one thing
      // that is not one. Arm them with what they already carry.
      const firstReal = state.weapons.find((w) => !isDefaultWeapon(w));
      if (firstReal) {
        state.currentWeapon = firstReal;
        this.lastWeaponSlot.delete(entityId);
      }
      return { added: false };
    } else {
      // Drop currently held weapon
      droppedWeapon = state.currentWeapon;
    }

    // Queue physical drop — cap ammo at pickupAmmo (one clip worth)
    const weaponDef = WEAPONS[droppedWeapon];
    const playerAmmo = this.ammoTotal(state.ammo.get(droppedWeapon));
    const droppedAmmo = weaponDef ? Math.min(playerAmmo, weaponDef.pickupAmmo ?? weaponDef.maxAmmo) : playerAmmo;
    const pos = this.entityPositions.get(entityId);
    if (this.droppedWeaponSystem && pos) {
      // Deterministic toss, seeded from tick+entity so demo re-sim reproduces it (R3).
      const rng = rngFrom(this.currentTick, entityId as number, 1);
      const angle = rng() * Math.PI * 2;
      const hSpeed = 80 + rng() * 60; // 80-140 horizontal
      this.droppedWeaponSystem.queueDrop({
        weaponId: droppedWeapon,
        ammo: droppedAmmo,
        position: { x: pos.x, y: pos.y + 20, z: pos.z },
        velocity: {
          x: Math.cos(angle) * hSpeed,
          y: 180 + rng() * 60, // 180-240 upward
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
    if (!state.ammo.has(weaponId) || this.ammoTotal(state.ammo.get(weaponId)) <= 0) {
      const weapon = WEAPONS[weaponId];
      if (weapon)
        state.ammo.set(weaponId, this.createAmmoState(weapon, weapon.pickupAmmo ?? this.maxTotalAmmo(weapon)));
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
    weaponId = canonicalWeaponId(weaponId);
    const weapon = WEAPONS[weaponId];
    if (weapon) {
      state.ammo.set(weaponId, this.createAmmoState(weapon, ammo));
    }
  }

  /**
   * Get current ammo for a specific weapon
   */
  getAmmo(entityId: EntityId, weaponId: string): number {
    const state = this.weaponStates.get(entityId);
    if (!state) return 0;
    return this.ammoTotal(state.ammo.get(canonicalWeaponId(weaponId)));
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
      const playerAmmo = this.ammoTotal(state.ammo.get(weaponId));
      // Cap dropped ammo at pickupAmmo (one clip worth)
      const ammo = weaponDef ? Math.min(playerAmmo, weaponDef.pickupAmmo ?? weaponDef.maxAmmo) : playerAmmo;
      // Deterministic death scatter (seeded from tick+entity+slot, R3).
      const rng = rngFrom(this.currentTick, eId as number, i);
      const angle = (i / toDrop.length) * Math.PI * 2 + rng() * 0.5;
      const hSpeed = 60 + rng() * 80;
      this.droppedWeaponSystem.queueDrop({
        weaponId,
        ammo,
        position: { x: pos.x, y: pos.y + 20, z: pos.z },
        velocity: {
          x: Math.cos(angle) * hSpeed,
          y: 200 + rng() * 80, // 200-280 upward
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
    const ammoMap = new Map<string, WeaponAmmo>();
    for (const [weaponId, amount] of Object.entries(loadout.ammo)) {
      const canonicalId = canonicalWeaponId(weaponId);
      const weapon = WEAPONS[canonicalId];
      if (weapon) {
        // Old saves can contain both names. Collapse them without adding the
        // two amounts together and accidentally granting bonus ammunition.
        const existing = ammoMap.get(canonicalId);
        if (!existing || this.ammoTotal(existing) < amount) {
          ammoMap.set(canonicalId, this.createAmmoState(weapon, amount));
        }
      }
    }
    const canonicalWeapons = [...new Set(loadout.weapons.map(canonicalWeaponId))];
    // Always include the default weapon (blade), limit pickable weapons to MAX_PICKABLE (2)
    const defaultWeapon = canonicalWeapons.find((w) => w === "blade") || canonicalWeapons[0] || "blade";
    const nonDefault = canonicalWeapons.filter((w) => w !== defaultWeapon).slice(0, 2);
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
      wasReloadButtonDown: false,
      hipfireAdsStartTick: 0,
    });
    // Reset edge detection so weapon slot changes are detected cleanly after respawn
    this.lastWeaponSlot.delete(id);
    this.lastSwitchTick.delete(id);
  }

  /**
   * Initialize weapon state for an entity (fallback with default loadout)
   */
  initializeWeapon(entityId: EntityId): void {
    this.initializeWeaponFromLoadout(entityId, {
      weapons: ["blade"],
      ammo: {
        blade: 1,
        machinegun: 160,
        riotgun: 32,
        glauncher: 20,
        rlauncher: 20,
        plasmagun: 200,
        voltaic: 180,
        electrobolt: 10,
        instagun: 5,
      },
      health: 100,
      armor: 0,
    });
  }

  update(state: WorldState, _dt: number, tick: TickNumber): void {
    const tickNum = tick as number;
    this.currentTick = tickNum;

    // Process delayed melee damage checks
    // Damage is checked using the shooter's CURRENT aim, not aim at fire time
    // This gives targets a dodge window (meleeDamageDelay)
    for (let i = this.pendingMeleeChecks.length - 1; i >= 0; i--) {
      const check = this.pendingMeleeChecks[i];
      if (tickNum >= check.checkTick) {
        // Find shooter entity at current tick
        const shooter = state.getEntity(check.shooterId);
        if (shooter?.transform && shooter.input && !shooter.health?.dead) {
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
        const lastSwitch = this.lastSwitchTick.get(entity.id) ?? Number.NEGATIVE_INFINITY;
        if (
          newWeapon &&
          newWeapon !== weaponState.currentWeapon &&
          tickNum - lastSwitch >= WeaponSystem.SWITCH_INTERVAL_TICKS
        ) {
          weaponState.currentWeapon = newWeapon;
          weaponState.reloading = false; // Cancel reload on switch
          weaponState.reloadEndTick = 0;
          weaponState.chargeStartTick = 0; // Cancel charge on switch
          this.lastSwitchTick.set(entity.id, tickNum);
        }
      }

      // Handle reload completion
      if (weaponState.reloading && tickNum >= weaponState.reloadEndTick) {
        const weapon = WEAPONS[weaponState.currentWeapon];
        if (weapon) {
          this.finishReload(weaponState, weapon);
        } else {
          weaponState.reloading = false;
        }
      }

      // Handle firing — check raw buttons bitmask (entity.input.attack is never set;
      // FPSMovementSubsystem only populates input.buttons from the inputQueue)
      const isFiring = (entity.input.buttons & FIRE_BUTTON) !== 0;
      const isAltFiring = (entity.input.buttons & ALT_FIRE_BUTTON) !== 0;
      const isReloading = (entity.input.buttons & RELOAD_BUTTON) !== 0;
      const weapon = WEAPONS[weaponState.currentWeapon];

      // Set weapon speed bonus on movement subsystem
      if (this.movementSubsystem) {
        this.movementSubsystem.setSpeedBonus(entity.id as number, weapon?.speedBonus ?? 0);
      }

      if (weapon && !weaponState.reloading && isReloading && !weaponState.wasReloadButtonDown) {
        this.startReload(weaponState, weapon, tickNum);
      }
      weaponState.wasReloadButtonDown = isReloading;

      if (weapon && !weaponState.reloading) {
        // === MELEE WEAPON LOGIC (blade) ===
        // FIRE = melee slash, ALT_FIRE = hold-to-charge projectile
        if (weapon.meleeRadius && weapon.chargedProjectileId) {
          // Keep ammo at max (infinite melee)
          weaponState.ammo.set(weaponState.currentWeapon, this.createAmmoState(weapon, weapon.maxAmmo || 1));

          // --- Primary fire: melee slash (semi-auto on press) ---
          if (isFiring && !weaponState.wasFireButtonDown) {
            const fireInterval = fireIntervalTicks(weapon);
            const timeSinceFire = tickNum - weaponState.lastFireTick;
            if (timeSinceFire >= fireInterval) {
              // Fire visual event immediately (animation + sound)
              if (entity.input) {
                const origin = this.getFireViewOrigin(entity);
                const yaw = entity.input.yaw;
                const pitch = -entity.input.pitch;
                if (origin) {
                  this.pendingFireEvents.push({
                    entityId: entity.id,
                    weaponId: weapon.id,
                    originX: origin.x,
                    originY: origin.y,
                    originZ: origin.z,
                    dirX: Math.sin(yaw) * Math.cos(pitch),
                    dirY: Math.sin(pitch),
                    dirZ: Math.cos(yaw) * Math.cos(pitch),
                  });
                }
              }

              this.queueMeleeDash(entity, weapon);

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
              const ammo = this.getAmmoState(weaponState, weapon);
              if (ammo.clip > 0 || this.reloadModel(weapon) === "none") {
                this.fireWeapon(state, entity, weapon, tick);
                this.consumeShot(weaponState, weapon);

                weaponState.lastFireTick = tickNum;

                // Auto-reload clip weapons when the magazine is depleted.
                if (this.reloadModel(weapon) === "clip" && ammo.clip <= 0) {
                  this.startReload(weaponState, weapon, tickNum);
                }
              } else if (this.canReload(weaponState, weapon)) {
                this.startReload(weaponState, weapon, tickNum);
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

  /**
   * Deterministic smooth "wander" deflection for unstable beams (voltaic). Hipfire
   * only — a slow drift of the aim (not random jitter or an orbit), so the beam
   * moves off distant targets without spinning between 20 Hz damage samples.
   * ADS (ALT_FIRE held) zeroes it → pinpoint.
   * Stateless (function of tick + shooter id) so the damage ray and the fire-event
   * direction agree without extra network state.
   */
  private beamWanderOffset(
    weapon: WeaponDef,
    shooterId: EntityId,
    tick: TickNumber,
    isADS: boolean,
  ): { dYaw: number; dPitch: number } {
    if (!weapon.beamWanderDeg || isADS) return { dYaw: 0, dPitch: 0 };
    const w = (weapon.beamWanderDeg * Math.PI) / 180;
    // Tick is a 125 Hz counter, not seconds. The old `tick * 0.35` advanced the
    // phase ~2.1 radians between six-tick Voltaic shots and made the ray jump
    // chaotically around the reticle. Low, unequal frequencies create a smooth
    // non-circular meander while retaining the intended hip-fire inaccuracy.
    const seconds = (tick as number) / TICK_RATE;
    const phase = (shooterId as number) * 0.754877666;
    return {
      dYaw: Math.sin(seconds * 1.35 + phase) * w,
      dPitch: Math.sin(seconds * 0.83 + phase * 1.7 + 1.3) * w * 0.6,
    };
  }

  private fireWeapon(state: WorldState, shooter: Readonly<Entity>, weapon: WeaponDef, tick: TickNumber): void {
    // Emit fire event for network broadcast
    if (shooter.input) {
      const origin = this.getFireViewOrigin(shooter);
      // yaw/pitch are already in radians from the client (Babylon.js camera)
      // Negate pitch: Babylon uses negative rotationX for looking UP.
      // Apply beam wander so remote beams bend to match the (deflected) damage ray.
      const isADS = (shooter.input.buttons & ALT_FIRE_BUTTON) !== 0;
      const wander = this.beamWanderOffset(weapon, shooter.id, tick, isADS);
      const yaw = shooter.input.yaw + wander.dYaw;
      const pitch = -shooter.input.pitch + wander.dPitch;
      if (origin) {
        this.pendingFireEvents.push({
          entityId: shooter.id,
          weaponId: weapon.id,
          originX: origin.x,
          originY: origin.y,
          originZ: origin.z,
          dirX: Math.sin(yaw) * Math.cos(pitch),
          dirY: Math.sin(pitch),
          dirZ: Math.cos(yaw) * Math.cos(pitch),
        });
      }
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
  private queueMeleeDash(shooter: Readonly<Entity>, weapon: WeaponDef): void {
    const distance = weapon.meleeDashDistance ?? 0;
    if (distance <= 0 || !this.movementSubsystem || !shooter.input) return;

    const yaw = shooter.input.yaw;
    this.movementSubsystem.queueMeleeDash({
      entityId: shooter.id,
      dirX: Math.sin(yaw),
      dirZ: Math.cos(yaw),
      distance,
    });
  }

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
    const origin = this.getFireViewOrigin(shooter);
    if (!origin) return;

    this.pendingFireEvents.push({
      entityId: shooter.id,
      weaponId: weapon.id,
      originX: origin.x,
      originY: origin.y,
      originZ: origin.z,
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
      x: origin.x + Math.sin(yaw) * Math.cos(pitch) * offset,
      y: origin.y + Math.sin(pitch) * offset,
      z: origin.z + Math.cos(yaw) * Math.cos(pitch) * offset,
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

    const start = this.getFireViewOrigin(shooter);
    if (!start) return;
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
    // Unstable-beam wander (voltaic hipfire): deflect the aim by a smooth,
    // deterministic sweep unless ADS — the beam bends and drifts off distant
    // targets from the hip; ADS locks it straight. Same offset as the fire event.
    const isADS = (shooter.input.buttons & ALT_FIRE_BUTTON) !== 0;
    const wander = this.beamWanderOffset(weapon, shooter.id, _tick, isADS);
    const wYaw = yaw + wander.dYaw;
    const wPitch = pitch + wander.dPitch;
    const dir = {
      x: Math.sin(wYaw) * Math.cos(wPitch),
      y: Math.sin(wPitch),
      z: Math.cos(wYaw) * Math.cos(wPitch),
    };
    const primaryHit = this.traceHitscanRay(state, shooter, weapon, start, dir, maxRange);
    // Continuous beam compatibility IDs have already normalized to Voltaic.
    if (weapon.hitscanType === "beam") {
      this.emitVoltaicBeamEvent(shooter.id, start, dir, maxRange, primaryHit);
    } else if (weapon.hitscanType === "bolt") {
      // Instant rail truth (Electrobolt). Presentation-only, like the Voltaic beam.
      this.emitElectroRailEvent(shooter.id, start, dir, maxRange, primaryHit);
    }

    // Accuracy telemetry (WO-AC1): single-ray hitscan only — one trigger pull = one
    // ray = 0/1 hit. (Pellet weapons return above; projectiles never reach here.)
    const acc = this.accuracy.get(shooter.id) ?? { shots: 0, hits: 0, headshots: 0 };
    acc.shots++;
    if (primaryHit) {
      acc.hits++;
      if (primaryHit.hitLocation === HitLocation.Head) acc.headshots++;
    }
    this.accuracy.set(shooter.id, acc);

    // Chain lightning (voltaic): arc from the primary hit to nearby enemies.
    if (weapon.chainCount && primaryHit) {
      const links = this.applyChainLightning(state, shooter, weapon, primaryHit);
      if (links.length >= 2) {
        this.pendingChainEvents.push({ entityId: shooter.id, points: links });
      }
    }

    // Splash-knockback hitscan (instagun): shooting a surface launches players
    // near the world-impact point. This is what makes instagib "insta-jump" work
    // (shoot the floor/wall to rocket-jump without a projectile). Knockback is
    // applied even at 0 self-damage via DamageEvent.knockbackDamage (F4).
    if (weapon.splashRadius && this.collisionWorld) {
      const impact = this.traceWorldImpact(start, dir, maxRange);
      if (impact) this.applyHitscanSplash(state, shooter, weapon, impact);
    }
  }

  /**
   * Resolve the authoritative endpoint/normal/kind of a hitscan ray for
   * presentation events (Voltaic beam, Electrobolt rail): a player hit wins,
   * else the world impact, else a max-range miss. Presentation-only — never
   * feeds back into the deterministic simulation.
   */
  private buildHitscanTruthEvent(
    shooterId: EntityId,
    start: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxRange: number,
    primaryHit: HitscanHitResult | null,
  ): VoltaicBeamEvent {
    const worldHit = primaryHit ? null : this.traceWorldImpactDetails(start, dir, maxRange);
    const endpoint = primaryHit?.impactPoint ??
      worldHit?.point ?? {
        x: start.x + dir.x * maxRange,
        y: start.y + dir.y * maxRange,
        z: start.z + dir.z * maxRange,
      };
    const normal = primaryHit?.impactNormal ?? worldHit?.normal ?? { x: -dir.x, y: -dir.y, z: -dir.z };

    return {
      entityId: shooterId,
      originX: start.x,
      originY: start.y,
      originZ: start.z,
      dirX: dir.x,
      dirY: dir.y,
      dirZ: dir.z,
      endX: endpoint.x,
      endY: endpoint.y,
      endZ: endpoint.z,
      normalX: normal.x,
      normalY: normal.y,
      normalZ: normal.z,
      impactKind: primaryHit ? 2 : worldHit ? 1 : 0,
    };
  }

  private emitVoltaicBeamEvent(
    shooterId: EntityId,
    start: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxRange: number,
    primaryHit: HitscanHitResult | null,
  ): void {
    this.pendingVoltaicBeamEvents.push(this.buildHitscanTruthEvent(shooterId, start, dir, maxRange, primaryHit));
  }

  private emitElectroRailEvent(
    shooterId: EntityId,
    start: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxRange: number,
    primaryHit: HitscanHitResult | null,
  ): void {
    this.pendingElectroRailEvents.push(this.buildHitscanTruthEvent(shooterId, start, dir, maxRange, primaryHit));
  }

  private traceWorldImpactDetails(
    start: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxRange: number,
  ): { point: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } } | null {
    if (!this.collisionWorld) return null;
    const end = { x: start.x + dir.x * maxRange, y: start.y + dir.y * maxRange, z: start.z + dir.z * maxRange };
    const res = this.collisionWorld.trace(
      start,
      end,
      { min: { x: -2, y: -2, z: -2 }, max: { x: 2, y: 2, z: 2 } },
      // Solid world only — a hitscan ray passes through playerclip, which is
      // there to stop bodies walking into a gap, not to stop bullets.
      SHOT_CONTENT_MASK,
    );
    if (res.fraction >= 1.0 || !res.hitPoint) return null;
    return {
      point: res.hitPoint,
      normal: res.normal ?? { x: -dir.x, y: -dir.y, z: -dir.z },
    };
  }

  /** Trace a ray against the BSP world; returns the impact point or null. */
  private traceWorldImpact(
    start: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxRange: number,
  ): { x: number; y: number; z: number } | null {
    return this.traceWorldImpactDetails(start, dir, maxRange)?.point ?? null;
  }

  /**
   * Radial splash-knockback at a hitscan world-impact point (instagun).
   * Health damage is self-gated by selfDamageMultiplier (instagib self = 0), but
   * the knockback magnitude is decoupled (knockbackDamage), so the shooter still
   * launches — the whole point of insta-jump.
   */
  private applyHitscanSplash(
    state: WorldState,
    shooter: Readonly<Entity>,
    weapon: WeaponDef,
    center: { x: number; y: number; z: number },
  ): void {
    const radius = weapon.splashRadius ?? 0;
    if (radius <= 0) return;
    const baseSplash = weapon.splashDamage ?? weapon.damage;
    const minSplash = weapon.minSplashDamage ?? 0;

    for (const target of state.entitiesByType(EntityType.Player)) {
      if (!target.transform || !target.health || target.health.dead) continue;

      const dx = target.transform.position.x - center.x;
      const dy = target.transform.position.y - center.y;
      const dz = target.transform.position.z - center.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist >= radius) continue;

      const falloff = 1 - dist / radius;
      const magnitude = Math.round(minSplash + (baseSplash - minSplash) * falloff);
      if (magnitude <= 0) continue;

      const isSelf = target.id === shooter.id;
      const healthDamage = isSelf ? Math.round(magnitude * this.selfDamageMultiplier) : magnitude;

      this.pendingDamage.push({
        victimId: target.id,
        attackerId: shooter.id,
        damage: healthDamage,
        knockbackDamage: magnitude, // push regardless of self-damage gating (insta-jump)
        armorPiercing: 0,
        damageType: this.weaponToDamageType(weapon.id),
        hitLocation: HitLocation.Body,
        knockbackDir: { x: dx, y: dy, z: dz },
        knockbackScale: weapon.knockbackScale,
      });
    }
  }

  /**
   * Trace a single hitscan ray and register damage for the first target hit.
   * Returns the hit target (id + position) for chain-lightning follow-up, or null.
   */
  private traceHitscanRay(
    state: WorldState,
    shooter: Readonly<Entity>,
    weapon: WeaponDef,
    start: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxRange: number,
  ): HitscanHitResult | null {
    // World occlusion: a hitscan ray stops at the first solid surface, so find
    // where it meets the BSP world. Any target beyond that distance is standing
    // behind a wall/floor and must NOT be hit (the "bots shoot through the floor"
    // bug — the sphere test alone had no notion of world geometry). With no
    // collision world wired in (unit tests, headless), this stays +Infinity and
    // the trace behaves exactly as before.
    const worldBlock = this.traceWorldImpactDetails(start, dir, maxRange);
    const worldBlockDist = worldBlock
      ? Math.hypot(worldBlock.point.x - start.x, worldBlock.point.y - start.y, worldBlock.point.z - start.z)
      : Number.POSITIVE_INFINITY;

    // The ray stops at whichever target it enters FIRST, so a body between the
    // shooter and a farther enemy shields that enemy. Track the nearest valid
    // (non-occluded) hit rather than the first one in iteration order.
    let best: {
      entryDistance: number;
      id: EntityId;
      position: { x: number; y: number; z: number };
      hitLocation: HitLocation;
      impactPoint: { x: number; y: number; z: number };
      impactNormal: { x: number; y: number; z: number };
    } | null = null;

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
      if (distSq >= hitRadius ** 2) continue;

      const entryDistance = Math.max(0, dot - Math.sqrt(Math.max(0, hitRadius ** 2 - distSq)));
      // Occluded: the ray hit world geometry before reaching this target.
      if (entryDistance > worldBlockDist) continue;
      // A nearer target already absorbs the ray.
      if (best && entryDistance >= best.entryDistance) continue;

      const impactPoint = {
        x: start.x + dir.x * entryDistance,
        y: start.y + dir.y * entryDistance,
        z: start.z + dir.z * entryDistance,
      };
      const normalX = impactPoint.x - target.transform.position.x;
      const normalY = impactPoint.y - target.transform.position.y;
      const normalZ = impactPoint.z - target.transform.position.z;
      const normalLength = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ) || 1;
      // Hit! Determine location based on Y offset
      const yOffset = closestPoint.y - target.transform.position.y;
      let hitLocation = HitLocation.Body;
      if (yOffset > 32) hitLocation = HitLocation.Head;
      else if (yOffset < -20) hitLocation = HitLocation.Legs;

      best = {
        entryDistance,
        id: target.id,
        position: { ...target.transform.position },
        hitLocation,
        impactPoint,
        impactNormal: { x: normalX / normalLength, y: normalY / normalLength, z: normalZ / normalLength },
      };
    }

    if (!best) return null;

    this.pendingDamage.push({
      victimId: best.id,
      attackerId: shooter.id,
      damage: weapon.damage,
      armorPiercing: 0,
      damageType: this.weaponToDamageType(weapon.id),
      hitLocation: best.hitLocation,
      knockbackDir: { x: dir.x, y: dir.y, z: dir.z },
      knockbackScale: weapon.knockbackScale,
    });

    // Return the hit for chain follow-up.
    return {
      id: best.id,
      position: best.position,
      hitLocation: best.hitLocation,
      impactPoint: best.impactPoint,
      impactNormal: best.impactNormal,
    };
  }

  /**
   * Chain lightning (voltaic): after the primary beam hit, arc to the nearest
   * not-yet-hit enemies within `chainRadius`, dealing damage that falls off by
   * `chainFalloff` per hop (e.g. 0.5 → 100% / 50% / 25%). Returns the ordered
   * chain of hit world-positions (primary first) so the visual layer can draw arcs.
   */
  private applyChainLightning(
    state: WorldState,
    shooter: Readonly<Entity>,
    weapon: WeaponDef,
    primary: { id: EntityId; position: { x: number; y: number; z: number } },
  ): { x: number; y: number; z: number }[] {
    const maxChains = weapon.chainCount ?? 0;
    const radius = weapon.chainRadius ?? 250;
    const falloff = weapon.chainFalloff ?? 0.5;

    const positions: { x: number; y: number; z: number }[] = [{ ...primary.position }];
    const hit = new Set<EntityId>([shooter.id, primary.id]);
    let from = primary.position;
    let damage = weapon.damage;

    for (let hop = 0; hop < maxChains; hop++) {
      damage *= falloff;
      const dmg = Math.round(damage);
      if (dmg <= 0) break;

      // Nearest unhit, living enemy within radius of the previous link.
      let nearest: Readonly<Entity> | null = null;
      let nearestDist = radius;
      for (const target of state.entitiesByType(EntityType.Player)) {
        if (hit.has(target.id)) continue;
        if (!target.transform || !target.health || target.health.dead) continue;
        const p = target.transform.position;
        const d = Math.sqrt((p.x - from.x) ** 2 + (p.y - from.y) ** 2 + (p.z - from.z) ** 2);
        if (d < nearestDist) {
          nearest = target;
          nearestDist = d;
        }
      }
      if (!nearest?.transform) break;

      hit.add(nearest.id);
      const p = nearest.transform.position;
      this.pendingDamage.push({
        victimId: nearest.id,
        attackerId: shooter.id,
        damage: dmg,
        armorPiercing: 0,
        damageType: this.weaponToDamageType(weapon.id),
        hitLocation: HitLocation.Body,
        knockbackDir: { x: p.x - from.x, y: p.y - from.y, z: p.z - from.z },
        knockbackScale: weapon.knockbackScale,
      });
      positions.push({ ...p });
      from = p;
    }

    return positions;
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
        const rng = rngFrom(this.currentTick, shooter.id as number, 3);
        yaw += (rng() - 0.5) * spreadRad;
        pitch += (rng() - 0.5) * spreadRad;
      }
    }

    const projectileDef = weapon.projectileId ? PROJECTILE_DEFS[weapon.projectileId] : undefined;
    const speed = projectileDef?.speed ?? weapon.projectileSpeed ?? 1000;
    const velocity = {
      x: Math.sin(yaw) * Math.cos(pitch) * speed,
      y: Math.sin(pitch) * speed,
      z: Math.cos(yaw) * Math.cos(pitch) * speed,
    };

    // Spawn projectile slightly in front of shooter, along look direction
    // Q3-style: spawn point follows crosshair (pitch-aware), not fixed eye height
    const offset = 50;
    const origin = this.getFireViewOrigin(shooter);
    if (!origin) return;
    const position = {
      x: origin.x + Math.sin(yaw) * Math.cos(pitch) * offset,
      y: origin.y + Math.sin(pitch) * offset,
      z: origin.z + Math.cos(yaw) * Math.cos(pitch) * offset,
    };

    const projectile = createProjectileEntity(entityId(this.nextProjectileId++), shooter.ownerId, position, velocity);

    state.addEntity(projectile);

    // Register projectile type with ProjectileSystem for impact events.
    // Identify the projectile by its own projectileId (F8) — the WEAPONS map has a
    // matching alias, so damage/splash lookup and client effects share one identity.
    if (this.projectileSystem) {
      this.projectileSystem.registerProjectileType(projectile.id, weapon.projectileId ?? weapon.id, {
        bounces: projectileDef?.bounces ?? 0,
        lifetime: projectileDef?.lifetime ?? 10.0,
        gravity: projectileDef?.gravity ?? weapon.projectileGravity ?? 0, // 0 = straight (F6); grenades set it explicitly
        bounceFactor: projectileDef?.bounceFactor,
      });
    }
  }

  private weaponToDamageType(weaponId: string): DamageType {
    switch (weaponId) {
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
