import { grantPowerup } from "../../shared/items/PowerupGrant";
/**
 * Pickup System
 *
 * Server-authoritative item/weapon pickup system.
 * Detects player proximity to pickup items and handles acquisition.
 *
 * Design:
 *   - Reads weapon entity positions from BSP data
 *   - Each tick, checks if any player is near an active pickup
 *   - When player presses USE (F key) near a weapon pickup, adds it to inventory
 *   - Handles respawn timers (pickup reappears after N seconds)
 *   - Emits pickup events for client-side sync
 */

import { Subsystem, type SubsystemConfig } from "@engine/server/core/Subsystem";
import type { WorldState } from "@engine/server/core/WorldState";
import type { EntityId, TickNumber } from "@engine/server/ecs/types";
import { EntityType, entityId } from "@engine/server/ecs/types";
import type { ItemRespawnMode } from "@shared/server/gametype";
import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "@shared/server/simulation/physics/constants";
import { createPowerups } from "../../../../shared/server/simulation/components/PowerupComponent";
// Shared pickup table (client+server agree on ids) + pure grant math.
import type { PickupEntry, PickupType } from "../../shared/bsp/PickupTable";
import {
  type ArmorKind,
  armorAfterPickup,
  decayOverheal,
  type HealthKind,
  healthAfterPickup,
} from "../../shared/items/ItemGrants";
import {
  ITEM_RESPAWN_SECONDS,
  itemRespawnSeconds,
  MAJOR_ITEM_FIRST_SPAWN_SECONDS,
} from "../../shared/items/ItemRespawn";
import { POWERUP_DISPLAY, type PowerupKind } from "../../shared/items/Powerups";
import { debugLog } from "../DebugLog";
import type { DroppedWeaponSystem } from "./DroppedWeaponSystem";
import type { WeaponSystem } from "./WeaponSystem";

/** Check if a weapon ID is the permanent default weapon (blade) */
function isDefaultWeapon(w: string): boolean {
  return w === "blade";
}

/** Must match InputButtons.USE from engine/network/components/InputComponent.ts */
const USE_BUTTON = 1 << 11;

/** A pickup item on the map */
interface PickupItem {
  id: number;
  type: PickupType;
  /** weapon id (weapons), ammo type (ammo), ArmorKind (armor), or HealthKind (health). */
  kind: string;
  amount?: number;
  classname: string; // BSP classname (e.g. 'weapon_rocketlauncher')
  position: { x: number; y: number; z: number };
  active: boolean; // Whether it can be picked up
  respawnTick: number; // Tick when it respawns (0 = active / no pending respawn)
  respawnTicks: number; // Per-type respawn duration in ticks
  /** Left out by the mode (`excludeClassnames`): never active, never respawns. */
  excluded?: boolean;
}

/** Event emitted when a pickup is taken */
export interface PickupEvent {
  pickupId: number;
  weaponId: string;
  entityId: EntityId; // Player who picked it up
  droppedWeaponId?: string; // Weapon that was dropped (if any)
  x: number;
  y: number;
  z: number;
}

const CONFIG: SubsystemConfig = {
  name: "Pickup",
  priority: 15, // Before weapon system (20), so pickups are processed first
  tickRate: 0, // every base tick — the rate comes from ServerTiming, not a per-subsystem literal (QA-24)
};

// ═══════════════════════════════════════════════════════════════════
// PICKUP SYSTEM
// ═══════════════════════════════════════════════════════════════════

export class PickupSystem extends Subsystem {
  private pickups: PickupItem[] = [];
  private pendingPickupEvents: PickupEvent[] = [];
  /** Per-player pickup notifications (label) for the HUD toast + demos. */
  private pendingPickupNotifies: Array<{ entityId: number; label: string }> = [];
  /**
   * Powerups that became available this tick, with their world position.
   * Broadcast to EVERY client (not just the grabber) so the map-wide "quad has
   * spawned" cue plays — knowing when it is up is the whole point of a powerup
   * that only exists once per map.
   */
  private pendingPowerupSpawns: Array<{ kind: string; x: number; y: number; z: number }> = [];
  private weaponSystem: WeaponSystem | null = null;
  private droppedWeaponSystem: DroppedWeaponSystem | null = null;
  /** Weapon respawn time (seconds); overridable via setRespawnTime. Armor/health use defaults. */
  private weaponRespawnSeconds: number = ITEM_RESPAWN_SECONDS.weapon;
  /** When consumed items return. Round modes override this. */
  private respawnMode: ItemRespawnMode = "timed";
  /** Items taken during the round now being played. */
  private consumedThisRound = new Set<number>();
  /** Items sitting out this round, under `alternating`. */
  private dormant = new Set<number>();

  // Pickup detection parameters (matching client-side Pickup.ts)

  private readonly PICKUP_RADIUS_SQ = 128 * 128;
  private readonly VERTICAL_RANGE_MIN = -48;
  private readonly VERTICAL_RANGE_MAX = 96;

  // Track USE button edge detection per player (prevent multi-pickup)
  private useButtonPrev: Map<EntityId, boolean> = new Map();

  constructor() {
    super(CONFIG);
  }

  /**
   * Set reference to WeaponSystem for inventory management
   */
  setWeaponSystem(ws: WeaponSystem): void {
    this.weaponSystem = ws;
  }

  /**
   * Set reference to DroppedWeaponSystem for picking up dropped weapons
   */
  setDroppedWeaponSystem(dws: DroppedWeaponSystem): void {
    this.droppedWeaponSystem = dws;
  }

  /**
   * Set the WEAPON respawn time in seconds (armor/health use built-in defaults).
   */
  setRespawnTime(seconds: number): void {
    this.weaponRespawnSeconds = seconds;
  }

  /**
   * Choose when consumed items come back. See `ItemRespawnMode`.
   *
   * Under `round` and `alternating` the per-item timers stop mattering — the
   * round boundary is the only thing that restores anything.
   */
  setRespawnMode(mode: ItemRespawnMode): void {
    this.respawnMode = mode;
    debugLog("setup", () => `[PickupSystem] Item respawn mode: ${mode}`);
  }

  /** Resolve the respawn duration (ticks) for a pickup entry by type/kind. */
  private respawnTicksFor(entry: PickupEntry): number {
    return Math.floor(itemRespawnSeconds(entry.type, entry.kind, this.weaponRespawnSeconds) * TICK_RATE);
  }

  /**
   * Register pickup items from the shared pickup table (extractPickups). Ids are
   * authoritative and shared with the client. Armor AND mega/ultra health spawn
   * after a delay (absent at match start, then appear) to prevent an instant
   * grab off spawn.
   *
   * Pickups whose classname the mode leaves out stay registered, permanently
   * inactive. Dropped from the list instead, they were missing from the active
   * mask the client hides pickups by, and one whose id lay past the mask's end
   * was never told it was gone and stayed on the floor.
   */
  setPickupItems(entries: PickupEntry[], excludedClassnames: ReadonlySet<string> = new Set()): void {
    this.pickups = entries.map((e) => {
      return {
        id: e.id,
        type: e.type,
        kind: e.kind,
        amount: e.amount,
        classname: e.classname,
        position: { ...e.position },
        active: true,
        respawnTick: 0,
        respawnTicks: this.respawnTicksFor(e),
        excluded: excludedClassnames.has(e.classname),
      };
    });
    this.resetForMatch(0);
  }

  /**
   * Restore the map's authoritative item generation for a fresh match.
   * Armor and mega/ultra health use a delay relative to the actual match-start
   * tick (not server tick zero, which may be minutes earlier after warmup).
   */
  resetForMatch(tickNum: number): void {
    if (this.respawnMode === "timed") this.dormant.clear();
    const firstSpawnDelayTicks = Math.floor(MAJOR_ITEM_FIRST_SPAWN_SECONDS * TICK_RATE);
    for (const pickup of this.pickups) {
      const delayed =
        pickup.type === "armor" ||
        pickup.type === "powerup" ||
        (pickup.type === "health" && (pickup.kind === "mega" || pickup.kind === "ultra"));
      const sittingOut = this.dormant.has(pickup.id) || pickup.excluded === true;
      pickup.active = !delayed && !sittingOut;
      // A dormant item must not come back on a timer either — it is out for the
      // whole round, not merely late.
      pickup.respawnTick = sittingOut ? Number.POSITIVE_INFINITY : delayed ? tickNum + firstSpawnDelayTicks : 0;
    }
    this.pendingPickupEvents = [];
    this.pendingPickupNotifies = [];
    this.pendingPowerupSpawns = [];
    this.useButtonPrev.clear();
  }

  /**
   * Deactivate a consumed pickup and schedule its return.
   *
   * In a round mode there is nothing to schedule: the item is gone for the rest
   * of the round, so there is one of each per round and taking it is a decision
   * rather than a timing exercise. `Number.POSITIVE_INFINITY` keeps the normal
   * `tickNum >= respawnTick` check honest without a mode test in the hot path.
   */
  private consumePickup(pickup: PickupItem, _playerId: EntityId, tickNum: number): void {
    pickup.active = false;
    this.consumedThisRound.add(pickup.id);
    pickup.respawnTick = this.respawnMode === "timed" ? tickNum + pickup.respawnTicks : Number.POSITIVE_INFINITY;
  }

  /**
   * Restore the map for a new round.
   *
   * Under `alternating`, whatever was taken during the round just played sits
   * this one out — so taking the Red Armor also denies it to everyone next
   * round, and the map is alternately rich and poor.
   */
  resetForRound(tickNum: number): void {
    this.dormant = this.respawnMode === "alternating" ? new Set(this.consumedThisRound) : new Set();
    this.consumedThisRound.clear();
    this.resetForMatch(tickNum);
    if (this.dormant.size > 0) {
      console.log(`[PickupSystem] ${this.dormant.size} items sitting out this round`);
    }
  }

  /**
   * Authoritative active-state of every tracked pickup, indexed by pickup id.
   * Replicated in full each snapshot (GameState.pickupActiveMask) so the client
   * converges on the server's truth — no events, no client respawn timer.
   */
  getActiveMask(): boolean[] {
    const mask: boolean[] = [];
    for (const pickup of this.pickups) {
      mask[pickup.id] = pickup.active;
    }
    return mask;
  }

  /**
   * Get pending pickup events (consumed by GameServer for broadcast)
   */
  getPendingPickupEvents(): PickupEvent[] {
    const events = this.pendingPickupEvents;
    this.pendingPickupEvents = [];
    return events;
  }

  /** Drain per-player pickup notifications (HUD toast labels). */
  getPendingPickupNotifies(): Array<{ entityId: number; label: string }> {
    const n = this.pendingPickupNotifies;
    this.pendingPickupNotifies = [];
    return n;
  }

  /** Drain powerup spawn announcements (broadcast to all clients). */
  getPendingPowerupSpawns(): Array<{ kind: string; x: number; y: number; z: number }> {
    const s = this.pendingPowerupSpawns;
    this.pendingPowerupSpawns = [];
    return s;
  }

  /** Queue a human-readable pickup label for the grabbing player. */
  private notifyPickup(entityId: EntityId, type: PickupType, kind: string): void {
    this.pendingPickupNotifies.push({ entityId: entityId as number, label: pickupLabel(type, kind) });
  }

  /**
   * Get all currently inactive pickups (for initial state sync when a client joins).
   * Returns pickup events so the client can deactivate visuals for already-consumed pickups.
   */
  getInactivePickups(): PickupEvent[] {
    const events: PickupEvent[] = [];
    for (const pickup of this.pickups) {
      if (!pickup.active) {
        events.push({
          pickupId: pickup.id,
          weaponId: pickup.type === "weapon" || pickup.type === "ammo" ? pickup.kind : "",
          entityId: entityId(0), // Not relevant for initial state
          x: pickup.position.x,
          y: pickup.position.y,
          z: pickup.position.z,
        });
      }
    }
    return events;
  }

  update(state: WorldState, _dt: number, tick: TickNumber): void {
    const tickNum = tick as number;

    // Handle respawn timers
    for (const pickup of this.pickups) {
      if (!pickup.active && pickup.respawnTick > 0 && tickNum >= pickup.respawnTick) {
        pickup.active = true;
        pickup.respawnTick = 0;
        if (pickup.type === "powerup") {
          this.pendingPowerupSpawns.push({
            kind: pickup.kind,
            x: pickup.position.x,
            y: pickup.position.y,
            z: pickup.position.z,
          });
        }
      }
    }

    // Mega-health overheal decay: once per second, bleed overhealed players
    // (health > 100) back toward 100 at 1 HP/s.
    if (tickNum % TICK_RATE === 0) {
      for (const player of state.entitiesByType(EntityType.Player)) {
        if (!player.health || player.health.dead) continue;
        const health = decayOverheal(player.health.health, 1);
        // Write through the copy-on-write handle (and only on a change): the
        // entity from entitiesByType() may still be shared with an earlier tick
        if (health !== player.health.health) {
          const mutable = state.getEntityMut(player.id)?.health;
          if (mutable) mutable.health = health;
        }
      }
    }

    // Dropped weapons, gathered once per tick on first need: walking every
    // entity for them inside the player loop scanned the world once per player
    let droppedItems: Array<{ id: EntityId }> | null = null;

    // Check each player against each active pickup
    for (const player of state.entitiesByType(EntityType.Player)) {
      if (!player.transform || !player.input || !player.health || player.health.dead) continue;

      const px = player.transform.position.x;
      const py = player.transform.position.y;
      const pz = player.transform.position.z;

      // Edge-detect USE button (only trigger on press, not hold)
      const usePressed = (player.input.buttons & USE_BUTTON) !== 0;
      const wasPressing = this.useButtonPrev.get(player.id) || false;
      this.useButtonPrev.set(player.id, usePressed);
      const useJustPressed = usePressed && !wasPressing;

      let pickedUpThisTick = false;

      for (const pickup of this.pickups) {
        if (!pickup.active) continue;

        // Cylindrical proximity check (matching client-side logic)
        const dx = px - pickup.position.x;
        const dz = pz - pickup.position.z;
        const dy = py - pickup.position.y;

        const horizDistSq = dx * dx + dz * dz;
        const inRange =
          horizDistSq < this.PICKUP_RADIUS_SQ && dy > this.VERTICAL_RANGE_MIN && dy < this.VERTICAL_RANGE_MAX;

        if (!inRange) continue;

        // ── ARMOR / HEALTH: auto-pickup when beneficial (no USE key, no capacity) ──
        if (pickup.type === "armor") {
          const before = player.health.armor;
          const after = armorAfterPickup(before, pickup.kind as ArmorKind);
          if (after <= before) continue; // full / no benefit — leave it
          const mutable = state.getEntityMut(player.id)?.health;
          if (!mutable) continue;
          mutable.armor = after;
          this.consumePickup(pickup, player.id, tickNum);
          this.notifyPickup(player.id, pickup.type, pickup.kind);
          pickedUpThisTick = true;
          break;
        }
        if (pickup.type === "health") {
          const before = player.health.health;
          const after = healthAfterPickup(before, pickup.kind as HealthKind);
          if (after <= before) continue;
          const mutable = state.getEntityMut(player.id)?.health;
          if (!mutable) continue;
          mutable.health = after;
          this.consumePickup(pickup, player.id, tickNum);
          this.notifyPickup(player.id, pickup.type, pickup.kind);
          pickedUpThisTick = true;
          break;
        }

        // ── POWERUP: auto-pickup, always beneficial (re-taking extends it) ──
        if (pickup.type === "powerup") {
          // `player` comes from entitiesByType() as Readonly<Entity>: granting goes
          // through the mutable handle, which also attaches a missing component.
          // Players built by createPlayerEntity() already carry one.
          const mut = state.getEntityMut(player.id);
          if (!mut) continue;
          mut.powerups ??= createPowerups();
          const powerups = mut.powerups;
          grantPowerup(powerups, pickup.kind as PowerupKind, tickNum, TICK_RATE);
          this.consumePickup(pickup, player.id, tickNum);
          this.notifyPickup(player.id, pickup.type, pickup.kind);
          pickedUpThisTick = true;
          break;
        }

        if (pickup.type === "ammo") {
          if (!this.weaponSystem) continue;
          const granted = this.weaponSystem.addAmmoByType(player.id, pickup.kind, pickup.amount ?? 0);
          if (!granted) continue;
          this.consumePickup(pickup, player.id, tickNum);
          this.notifyPickup(player.id, pickup.type, pickup.kind);
          this.pendingPickupEvents.push({
            pickupId: pickup.id,
            weaponId: pickup.kind,
            entityId: player.id,
            x: pickup.position.x,
            y: pickup.position.y,
            z: pickup.position.z,
          });
          pickedUpThisTick = true;
          break;
        }

        // ── WEAPON ──
        if (!this.weaponSystem) continue;

        const playerWeapons = this.weaponSystem.getWeapons(player.id);
        const nonDefaultCount = playerWeapons.filter((w) => !isDefaultWeapon(w)).length;
        const alreadyHasWeapon = playerWeapons.includes(pickup.kind);
        const hasRoom = nonDefaultCount < 2;

        // Auto-pickup if: player has room OR already owns weapon (ammo pickup)
        // Require USE key only for weapon swap (at capacity + new weapon)
        if (!hasRoom && !alreadyHasWeapon && !useJustPressed) continue;

        // Try to add weapon to player's inventory
        const result = this.weaponSystem.addWeapon(player.id, pickup.kind, player.transform.position);

        // addWeapon returns added=false for BOTH "already owned (ammo given)" AND "can't swap (holding default weapon)"
        // Only consume pickup if weapon was added or ammo was given (player already had it)
        if (!result.added && !alreadyHasWeapon) {
          // Swap failed (e.g., holding default weapon at capacity) — don't consume the pickup
          continue;
        }

        // Deactivate pickup and start respawn timer
        pickup.active = false;
        pickup.respawnTick = tickNum + pickup.respawnTicks;

        // Emit event for client sync (weapons only — armor/health visibility is
        // driven entirely by the active-set mask; weapon events still feed bots).
        this.pendingPickupEvents.push({
          pickupId: pickup.id,
          weaponId: pickup.kind,
          entityId: player.id,
          droppedWeaponId: result.dropped,
          x: pickup.position.x,
          y: pickup.position.y,
          z: pickup.position.z,
        });
        if (result.added) this.notifyPickup(player.id, "weapon", pickup.kind);

        // Only pick up one weapon per tick
        pickedUpThisTick = true;
        break;
      }

      // Check dropped weapons (EntityType.Item)
      // Skip if a static pickup already happened this tick (one pickup per tick)
      // Auto-pickup when player has room, require USE key when at capacity
      if (!pickedUpThisTick && this.droppedWeaponSystem) {
        droppedItems ??= [...state.entitiesByType(EntityType.Item)];
        for (const { id } of droppedItems) {
          // Read it afresh: another player may have taken it earlier this tick
          const itemEntity = state.getEntity(id);
          if (!itemEntity?.transform) continue;

          const dx = px - itemEntity.transform.position.x;
          const dz = pz - itemEntity.transform.position.z;
          const dy = py - itemEntity.transform.position.y;

          const horizDistSq = dx * dx + dz * dz;
          // Slightly wider vertical range for dropped weapons
          // (server ballistic sim may have minor Y drift from real floor)
          const inRange = horizDistSq < this.PICKUP_RADIUS_SQ && dy > -96 && dy < 128;

          if (!inRange) continue;
          if (!this.weaponSystem) continue;

          const meta = this.droppedWeaponSystem.getDroppedWeaponMeta(itemEntity.id);
          if (!meta) continue;

          // Check inventory capacity for pickup gating
          const playerWeapons = this.weaponSystem.getWeapons(player.id);
          const nonDefaultCount = playerWeapons.filter((w) => !isDefaultWeapon(w)).length;
          const alreadyHasWeapon = playerWeapons.includes(meta.weaponId);
          const hasRoom = nonDefaultCount < 2;

          // Auto-pickup if: player has room OR already owns weapon (ammo pickup)
          // Require USE key only for weapon swap (at capacity + new weapon)
          if (!hasRoom && !alreadyHasWeapon && !useJustPressed) continue;

          // Add weapon to player's inventory
          const alreadyHadWeapon = this.weaponSystem.getWeapons(player.id).includes(meta.weaponId);
          const result = this.weaponSystem.addWeapon(player.id, meta.weaponId, player.transform.position);

          // Set correct ammo from dropped weapon:
          // - New weapon: override addWeapon's default ammo with exact meta.ammo
          // - Already owned: add meta.ammo to existing (ammo pickup behavior)
          if (alreadyHadWeapon) {
            // Player already has this weapon — add dropped ammo to existing
            if (meta.ammo > 0) {
              const currentAmmo = this.weaponSystem.getAmmo(player.id, meta.weaponId);
              this.weaponSystem.setAmmo(player.id, meta.weaponId, currentAmmo + meta.ammo);
            }
          } else {
            // New weapon — set to exactly the dropped weapon's ammo (not default)
            this.weaponSystem.setAmmo(player.id, meta.weaponId, meta.ammo);
          }

          // Always remove from world — even if weapon wasn't added (ammo was given)
          state.removeEntity(itemEntity.id);
          this.droppedWeaponSystem.removeDroppedWeapon(itemEntity.id);

          // Emit event
          this.pendingPickupEvents.push({
            pickupId: -1, // Negative ID = dropped weapon pickup
            weaponId: meta.weaponId,
            entityId: player.id,
            droppedWeaponId: result.dropped,
            x: itemEntity.transform.position.x,
            y: itemEntity.transform.position.y,
            z: itemEntity.transform.position.z,
          });
          if (result.added) this.notifyPickup(player.id, "weapon", meta.weaponId);

          // Only pick up one item per tick
          break;
        }
      }
    }
  }
}

/** Human-readable pickup label for the HUD toast. */
const WEAPON_DISPLAY: Record<string, string> = {
  machinegun: "Machinegun",
  riotgun: "Riotgun",
  glauncher: "Grenade Launcher",
  rlauncher: "Rocket Launcher",
  plasmagun: "Plasma Gun",
  voltaic: "Voltaic",
  electrobolt: "Electrobolt",
  instagun: "Instagun",
};
const ARMOR_DISPLAY: Record<string, string> = {
  shard: "Armor Shard",
  ga: "Green Armor",
  ya: "Yellow Armor",
  ra: "Red Armor",
};
function pickupLabel(type: PickupType, kind: string): string {
  const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  switch (type) {
    case "weapon":
      return WEAPON_DISPLAY[kind] ?? titleCase(kind);
    case "ammo":
      return `${titleCase(kind)} Ammo`;
    case "armor":
      return ARMOR_DISPLAY[kind] ?? "Armor";
    case "health":
      return kind === "mega" ? "Mega Health" : kind === "ultra" ? "Ultra Health" : "Health";
    case "powerup":
      return POWERUP_DISPLAY[kind as PowerupKind] ?? titleCase(kind);
    default:
      return titleCase(kind);
  }
}
