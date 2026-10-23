/**
 * Dropped Weapon System
 *
 * Manages weapons dropped by players (on swap or death).
 * Dropped weapons are EntityType.Item entities with position + metadata.
 * They can be picked up by other players and despawn after a timeout.
 *
 * Physics: the server steps each drop with the shared item throw
 * (shared/items/ItemThrow), the same arc map weapons land with.
 * Clients use Havok for visual physics but converge to server position.
 */

import type { SubsystemConfig } from "@engine/server/core/Subsystem";
import { Subsystem } from "@engine/server/core/Subsystem";
import type { WorldState } from "@engine/server/core/WorldState";
import { createDroppedWeaponEntity } from "@engine/server/ecs/Entity";
import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "@shared/server/simulation/physics/constants";
import type { EntityId, TickNumber } from "@shared/server/simulation/types";
import { entityId } from "@shared/server/simulation/types";
import type { CollisionWorld } from "../../../../engine/network/systems/collision/CollisionWorld";
import { ITEM_GRAVITY, stepThrownItem } from "../../shared/items/ItemThrow";

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

/** Metadata for a dropped weapon entity */
interface DroppedWeaponMeta {
  entityId: EntityId;
  weaponId: string;
  ammo: number;
  spawnTick: number;
  /** Current velocity (zeroed once settled) */
  velocity: { x: number; y: number; z: number };
  /** Whether the weapon has landed and stopped moving */
  settled: boolean;
  /** Floor Y for this weapon (derived from spawn position) */
  floorY: number;
}

/** Request to spawn a dropped weapon */
export interface WeaponDropRequest {
  weaponId: string;
  ammo: number;
  position: { x: number; y: number; z: number };
  velocity?: { x: number; y: number; z: number };
}

/** Event emitted when a weapon is dropped (for client broadcast) */
export interface WeaponDropEvent {
  entityId: string; // Network entity ID (e.g. 'item_50001')
  weaponId: string;
  x: number;
  y: number;
  z: number;
  velX: number;
  velY: number;
  velZ: number;
}

const CONFIG: SubsystemConfig = {
  name: "DroppedWeapon",
  priority: 12, // Before PickupSystem (15) so drops are visible for pickup same tick
  tickRate: 0, // every base tick — the rate comes from ServerTiming, not a per-subsystem literal (QA-24)
};

/** Despawn time in seconds */
const DESPAWN_TIME = 15;

/**
 * Simulation base tick rate (Hz). Subsystems run every base tick (`CONFIG.tickRate`
 * is 0, QA-24), so time-derived values must use the base rate, NOT the per-subsystem
 * rate — otherwise `1 / CONFIG.tickRate` is Infinity and `DESPAWN_TIME * CONFIG.tickRate`
 * is 0 (weapons get NaN physics and despawn the same tick they drop).
 */
const BASE_TICK_RATE = TICK_RATE;

/** Offset from player origin Y to estimate the floor Y (Q3: origin is 24 above feet) */
const PLAYER_ORIGIN_HEIGHT = 24;

/** Velocity magnitude below which the no-collision fallback considers a drop settled */
const SETTLE_SPEED = 5;

/** Bounce coefficient (energy retained per bounce) */
const BOUNCE_COEFF = 0.3;

// ═══════════════════════════════════════════════════════════════════
// DROPPED WEAPON SYSTEM
// ═══════════════════════════════════════════════════════════════════

export class DroppedWeaponSystem extends Subsystem {
  /** Metadata for each dropped weapon entity */
  private droppedWeapons: Map<EntityId, DroppedWeaponMeta> = new Map();

  /** Pending drop requests (queued by WeaponSystem, consumed on tick) */
  private pendingDrops: WeaponDropRequest[] = [];

  /** Pending events for client broadcast */
  private pendingDropEvents: WeaponDropEvent[] = [];

  /** Next entity ID for dropped weapons */
  private nextDropId: number = 50001;

  /** Despawn time in ticks (computed from tick rate) */
  private despawnTicks: number;

  /** Seconds per tick */
  private dt: number;

  /** Collision world for floor detection (optional) */
  private collisionWorld: CollisionWorld | null = null;

  constructor() {
    super(CONFIG);
    this.despawnTicks = DESPAWN_TIME * BASE_TICK_RATE;
    this.dt = 1 / BASE_TICK_RATE;
  }

  /**
   * Set the collision world for accurate floor detection.
   * When set, dropped weapons trace downward to find the real BSP floor
   * instead of estimating from the dropper's Y position.
   */
  setCollisionWorld(collision: CollisionWorld): void {
    this.collisionWorld = collision;
  }

  // ────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────

  /**
   * Queue a weapon drop (called by WeaponSystem when a weapon is swapped out or on death)
   */
  queueDrop(request: WeaponDropRequest): void {
    this.pendingDrops.push(request);
  }

  /**
   * Get pending drop events (consumed by GameServer for broadcast)
   */
  getPendingDropEvents(): WeaponDropEvent[] {
    const events = this.pendingDropEvents;
    this.pendingDropEvents = [];
    return events;
  }

  /**
   * Get metadata for a dropped weapon entity (used by PickupSystem)
   */
  getDroppedWeaponMeta(eId: EntityId): DroppedWeaponMeta | undefined {
    return this.droppedWeapons.get(eId);
  }

  /**
   * Remove a dropped weapon after it's been picked up
   */
  removeDroppedWeapon(eId: EntityId): void {
    this.droppedWeapons.delete(eId);
  }

  /** Remove all warmup drops and queued drop work from the authoritative world. */
  resetForMatch(state: WorldState): void {
    for (const eId of this.droppedWeapons.keys()) {
      state.removeEntity(eId);
    }
    this.droppedWeapons.clear();
    this.pendingDrops = [];
    this.pendingDropEvents = [];
  }

  // ────────────────────────────────────────────────────────────────
  // Subsystem update
  // ────────────────────────────────────────────────────────────────

  update(state: WorldState, _dt: number, tick: TickNumber): void {
    const tickNum = tick as number;

    // 1. Process pending drops → spawn entities
    for (const drop of this.pendingDrops) {
      const vel = drop.velocity || { x: 0, y: 150, z: 0 };
      const id = entityId(this.nextDropId++);
      const entity = createDroppedWeaponEntity(id, drop.position, vel, drop.weaponId);
      state.addEntity(entity);

      // Find real floor Y using BSP collision trace (if available)
      let floorY = drop.position.y - PLAYER_ORIGIN_HEIGHT; // Fallback estimate
      if (this.collisionWorld) {
        const traceStart = { x: drop.position.x, y: drop.position.y, z: drop.position.z };
        const traceEnd = { x: drop.position.x, y: drop.position.y - 2000, z: drop.position.z };
        const result = this.collisionWorld.trace(traceStart, traceEnd);
        if (result.hit && result.hitPoint) {
          floorY = result.hitPoint.y;
        }
      }
      const meta: DroppedWeaponMeta = {
        entityId: id,
        weaponId: drop.weaponId,
        ammo: drop.ammo,
        spawnTick: tickNum,
        velocity: { ...vel },
        settled: false,
        floorY,
      };
      this.droppedWeapons.set(id, meta);

      // Emit event for client (includes velocity for Havok toss)
      this.pendingDropEvents.push({
        entityId: `item_${id}`,
        weaponId: drop.weaponId,
        x: drop.position.x,
        y: drop.position.y,
        z: drop.position.z,
        velX: vel.x,
        velY: vel.y,
        velZ: vel.z,
      });
    }
    this.pendingDrops = [];

    // 2. Tick physics for unsettled weapons
    for (const [eId, meta] of this.droppedWeapons) {
      if (meta.settled) continue;

      const entity = state.getEntity(eId);
      if (!entity?.transform) continue;

      const pos = entity.transform.position;
      const vel = meta.velocity;

      if (this.collisionWorld) {
        // The shared item throw: step-slide through BSP collision, ground friction, settling.
        const item = { position: pos, velocity: vel, settled: false };
        stepThrownItem(item, this.collisionWorld, this.dt);
        meta.settled = item.settled;
      } else {
        // Fallback: simple gravity with estimated floor (no BSP)
        vel.y -= ITEM_GRAVITY * this.dt;
        pos.x += vel.x * this.dt;
        pos.y += vel.y * this.dt;
        pos.z += vel.z * this.dt;

        if (pos.y <= meta.floorY) {
          pos.y = meta.floorY;
          if (Math.abs(vel.y) < SETTLE_SPEED * 3) {
            vel.x = 0;
            vel.y = 0;
            vel.z = 0;
            meta.settled = true;
          } else {
            vel.y = -vel.y * BOUNCE_COEFF;
            vel.x *= BOUNCE_COEFF;
            vel.z *= BOUNCE_COEFF;
          }
        }

        const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
        if (speed < SETTLE_SPEED && pos.y <= meta.floorY + 1) {
          vel.x = 0;
          vel.y = 0;
          vel.z = 0;
          meta.settled = true;
        }
      }

      // Update entity physics velocity for serialization
      if (entity.physics) {
        entity.physics.velocity = { ...vel };
      }
    }

    // 3. Despawn expired drops
    const entitiesToRemove: EntityId[] = [];
    for (const [eId, meta] of this.droppedWeapons) {
      if (tickNum - meta.spawnTick >= this.despawnTicks) {
        entitiesToRemove.push(eId);
      }
    }
    for (const eId of entitiesToRemove) {
      state.removeEntity(eId);
      this.droppedWeapons.delete(eId);
    }
  }
}
