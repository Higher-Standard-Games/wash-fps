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
import type { LagCompensation, RewindView } from "@engine/server/lagcomp/LagCompensation";
import type { WeaponLoadout } from "@shared/server/gametype";
import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "@shared/server/simulation/physics/constants";
import type { Vec3 } from "@shared/server/simulation/types";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import { type CollisionWorld, SHOT_CONTENT_MASK } from "../../../../engine/network/systems/collision/CollisionWorld";
import { DEFAULT_VIEWHEIGHT } from "../../../../engine/physics/PlayerPhysicsConstants";
import { rngFrom } from "../../../../shared/DeterministicRng";
import type { ProjectileDef } from "../../../../shared/entities/ProjectileDef";
import type { WeaponDef } from "../../../../shared/entities/WeaponDef";
import { fireIntervalTicks } from "../../../../shared/entities/WeaponDef";
import {
  bloomIdleSeconds,
  computeSpreadSeed,
  coolSpreadHeat,
  generateSpreadDirections,
  heatAfterShot,
  type SpreadDir,
  spreadCone,
} from "../../../../shared/SpreadUtils";
import { GRENADE } from "../../shared/entities/definitions/projectiles/grenade";
import { canonicalWeaponId, WEAPONS } from "../../shared/entities/definitions/weapons/WeaponsTable";
import { debugLog } from "../DebugLog";
import { classifyHitLocation, type DamageEvent, DamageType, HitLocation } from "./CombatSystem";
import type { DroppedWeaponSystem } from "./DroppedWeaponSystem";
import { caughtInDischarge, dischargeDamageAt, dischargesInWater } from "./ElectricalDischarge";
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

const PROJECTILE_DEFS: Record<string, ProjectileDef> = {
  [GRENADE.id]: GRENADE,
};

/** Refire interval in ticks; defined with the weapon definitions, shared with the client. */
export { fireIntervalTicks };

/** A weapon that fires a spread of pellets in one shot (the riotgun). */
export function firesPellets(weapon: WeaponDef): weapon is WeaponDef & { pelletCount: number; spread: number } {
  return !!weapon.pelletCount && weapon.pelletCount > 1 && !!weapon.spread;
}

/**
 * Where a hit by `weapon` counts as landing, given its height above or below the target's origin.
 *
 * A spread of pellets is a distributed blast, not an aimed shot, so no pellet is a headshot: one
 * that lands high counts as a body hit. Leg hits still count.
 */
export function locateHit(weapon: WeaponDef, yOffset: number): HitLocation {
  const location = classifyHitLocation(yOffset);
  return location === HitLocation.Head && firesPellets(weapon) ? HitLocation.Body : location;
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
  dirX: number; // fire direction (normalized), with the shot's spread in it
  dirY: number;
  dirZ: number;
  /** A pellet shot's seed and cone: every client rebuilds the server's pellets from them. */
  pelletSeed?: number;
  pelletSpread?: number;
}

/**
 * Where a shot goes, decided once per trigger pull for the damage and the fire
 * event alike (`aimShot`).
 */
interface ShotAim {
  /** The direction of a single-ray shot, spread included; the look direction for anything else. */
  dir: SpreadDir;
  /** A pellet shot's seed and cone (half-angle, degrees). */
  pellets?: { seed: number; spreadDeg: number };
}

/** Salt for a single-ray shot's spread seed, apart from the pellet seeds' shot counts. */
const BULLET_SPREAD_SALT = 7919;

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
  /** First tick of uninterrupted aim; null means the sights are down. */
  adsStartTick: number | null;
  /** Manual aim is tracked separately from primary-fire auto-aim. */
  manualAdsStartTick: number | null;
  /**
   * Tick of the first trigger pull on an empty gun (0 = not pending). Pulling
   * again, or simply holding, trades the dead weapon for one that fires.
   */
  dryFireTick: number;
  /**
   * Tick before which a weapon we raised on the player's behalf may not fire, so
   * an automatic swap plays its switch animation instead of appearing already up
   * and shooting. 0 for a switch the player asked for themselves.
   */
  switchReadyTick: number;
  /** Bloom heat (0 = cold, 1 = fully opened spread) as of `spreadHeatTick`; see `aimShot`. */
  spreadHeat: number;
  spreadHeatTick: number;
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
  /** Players whose weapon the server just changed for them; see `autoSwitch`. */
  private slotResync: Set<EntityId> = new Set();
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
  private wantsAutoSwitch: (entityId: EntityId) => boolean = () => true;
  private collisionWorld: CollisionWorld | null = null;
  private lagCompensation: LagCompensation | null = null;
  /**
   * Snapshot intervals a client is assumed to render behind its newest snapshot.
   *
   * One, because `SnapshotBuffer` settles on `avg + stddev` of snapshot
   * inter-arrival times — one interval plus whatever the connection jitters.
   * Assuming two double-counted it: `npm run net:viewlag` shows the server
   * already observing ~32ms of view lag at zero network latency from snapshot
   * quantisation and queueing alone, so a second assumed interval on top handed
   * a LAN player ~65ms of rewind and shot people well after they reached cover.
   *
   * Erring low is deliberate. Guessing high punishes the player who took cover,
   * who did nothing wrong; guessing low costs the shooter on a jittery line a
   * little extra lead.
   */
  private static readonly INTERP_SNAPSHOT_INTERVALS = 1;
  private interpTicks = 1;
  /** Gametype self-damage multiplier (1.0 = full, 0 = none). Mirrors ProjectileSystem. */
  selfDamageMultiplier: number = 1.0;
  private movementSubsystem: import("./FPSMovementSubsystem").FPSMovementSubsystem | null = null;
  /** Pending drop positions — set by GameServer before tick when a swap happens */
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
  /**
   * How long a trigger must stay down on an empty gun before we swap for you
   * (~200ms at 125Hz). Long enough that a tap still only clicks and leaves the
   * choice yours; short enough that holding the trigger is not left hanging.
   */
  private static readonly DRY_FIRE_SWAP_TICKS = 25;
  /**
   * How long a weapon we raised for the player stays un-fireable (~264ms at
   * 125Hz), covering WeaponSwitchAnim's 120ms drop plus 140ms raise. Without it
   * the swapped-in weapon is legal to fire the instant it is equipped, so the
   * same trigger pull that traded the gun also shot it, before the new one had
   * visibly come up.
   */
  private static readonly WEAPON_RAISE_TICKS = 33;

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

  /**
   * Drop everything held for an entity that has left the world for good (a
   * disconnect, or going to spectate). A rejoin gets a new entity id, so
   * without this every rejoin left one weapon state behind for the server's
   * lifetime.
   */
  forget(entityId: EntityId): void {
    this.weaponStates.delete(entityId);
    this.lastWeaponSlot.delete(entityId);
    this.lastSwitchTick.delete(entityId);
    this.slotResync.delete(entityId);
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
  /**
   * Whether a player wants to switch to a weapon they pick up. Players who
   * turned it off (`cl_autoswitch 0`) keep what they hold, blade included.
   */
  setAutoSwitchPreference(wants: (entityId: EntityId) => boolean): void {
    this.wantsAutoSwitch = wants;
  }

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
   * Wire hit registration to the rewind history. Without it, hitscan resolves
   * against the present, which makes a moving target harder to hit the worse
   * your connection is. With it, a shot is judged against the world the shooter
   * actually saw.
   */
  setLagCompensation(lag: LagCompensation | null, ticksPerSnapshot = 1): void {
    this.lagCompensation = lag;
    // A client does not render the newest snapshot it holds — it renders behind
    // it, so it always has two frames to interpolate between. That lag has to
    // come off the rewind or we judge the shot against a world the shooter had
    // not seen yet.
    //
    // The server assumes this rather than being told: cl_interp is a client
    // cvar, and a value the client chooses is a value a cheater inflates to be
    // judged ever further into the past. Two snapshot intervals covers the one
    // interval of render lag plus room for jitter.
    this.interpTicks = Math.max(1, Math.round(ticksPerSnapshot * WeaponSystem.INTERP_SNAPSHOT_INTERVALS));
  }

  /**
   * Where the world was when `shooter` pulled the trigger, or null for "now".
   *
   * Keyed off the view tick the command carried rather than a reported ping: it
   * costs no extra bandwidth, needs no assumption that a connection is equally
   * slow in both directions, and can be checked against the server's own clock.
   * A shooter with no view tick (a bot, or a client yet to see its first
   * snapshot) has no latency to compensate and is judged against the present.
   */
  private rewindFor(state: WorldState, shooter: Readonly<Entity>): RewindView | null {
    const viewTick = shooter.input?.viewTick ?? 0;
    if (!this.lagCompensation || viewTick <= 0) return null;
    return this.lagCompensation.rewindToTick(state.tick, viewTick - this.interpTicks);
  }

  /** Run a world query with movers put back where the shooter saw them. */
  private withRewoundMovers<T>(rewind: RewindView | null, query: () => T): T {
    const lifts = this.collisionWorld?.lifts;
    return lifts && rewind?.liftOffsets ? lifts.rewind(rewind.liftOffsets, query) : query();
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

  /** Keep the authoritative muzzle offset on the shooter's side of nearby world geometry. */
  private clipProjectileSpawn(origin: Vec3, proposed: Vec3): Vec3 {
    if (!this.collisionWorld) return proposed;
    const trace = this.collisionWorld.trace(
      origin,
      proposed,
      { min: { x: -2, y: -2, z: -2 }, max: { x: 2, y: 2, z: 2 } },
      SHOT_CONTENT_MASK,
    );
    if (trace.fraction >= 1 || !trace.hitPoint) return proposed;
    const normal = trace.normal ?? { x: 0, y: 0, z: 0 };
    return {
      x: trace.hitPoint.x + normal.x * 0.1,
      y: trace.hitPoint.y + normal.y * 0.1,
      z: trace.hitPoint.z + normal.z * 0.1,
    };
  }

  private reloadModel(weapon: WeaponDef): "clip" | "pool" | "none" {
    return weapon.reloadModel ?? "pool";
  }

  /**
   * A trigger pull on an empty gun.
   *
   * The first pull only reports the problem — the client plays the empty click
   * off its own ammo state. Swapping on that first pull would tear you off your
   * rocket launcher for a stray tap, so the swap needs a second pull, or a held
   * trigger, either of which says you actually want to be shooting something.
   */
  private handleDryFire(entityId: EntityId, state: WeaponState, tickNum: number, freshPress: boolean): void {
    if (state.dryFireTick === 0) {
      // First pull: click only, and start the clock for a held trigger.
      state.dryFireTick = tickNum;
      return;
    }
    const heldLongEnough = !freshPress && tickNum - state.dryFireTick >= WeaponSystem.DRY_FIRE_SWAP_TICKS;
    if (!freshPress && !heldLongEnough) return;

    const next = this.nextWeaponWithAmmo(state);
    // Nothing else to offer — keep clicking rather than silently doing nothing.
    if (!next) return;
    this.equip(entityId, state, next, tickNum, WeaponSystem.WEAPON_RAISE_TICKS);
  }

  /**
   * The next owned weapon, in slot order from the one in hand, that can actually
   * fire. Wraps, so the search always ends on the starter weapon at worst.
   */
  private nextWeaponWithAmmo(state: WeaponState): string | null {
    const owned = state.weapons;
    const from = owned.indexOf(state.currentWeapon);
    for (let step = 1; step <= owned.length; step++) {
      const id = owned[(from + step) % owned.length];
      const weapon = id ? WEAPONS[canonicalWeaponId(id)] : undefined;
      if (!weapon || id === state.currentWeapon) continue;
      if (this.reloadModel(weapon) === "none") return id; // never runs dry
      const ammo = this.getAmmoState(state, weapon);
      if (ammo.clip > 0 || ammo.reserve > 0) return id;
    }
    return null;
  }

  /**
   * Put a weapon in hand, cancelling whatever the old one was in the middle of.
   *
   * `raiseTicks` holds fire until the switch animation has played. It is zero for
   * a switch the player asked for — firing straight out of a manual switch is a
   * technique, not a bug — and non-zero only when we swapped for them.
   */
  private equip(entityId: EntityId, state: WeaponState, weaponId: string, tickNum: number, raiseTicks = 0): void {
    this.endCharge(entityId, state);
    state.currentWeapon = weaponId;
    state.reloading = false;
    state.reloadEndTick = 0;
    // An alt-fire held over from the old weapon is not a charge on this one.
    // Left set, releasing it fired the blade's full charge with no charge-up
    // (heldTicks counted from tick 0). Still held, it now starts a fresh charge.
    state.wasAltFireDown = false;
    state.adsStartTick = null;
    state.manualAdsStartTick = null;
    state.dryFireTick = 0;
    state.switchReadyTick = raiseTicks > 0 ? tickNum + raiseTicks : 0;
    this.lastSwitchTick.set(entityId, tickNum);
  }

  /**
   * Drop a charge in progress and tell the clients, as a release does.
   *
   * A switch or a death ended the charge silently: everyone else kept the
   * charger's glow, back on them after respawn, and the charger's own client
   * still thought it was charging and skipped its next blade slash (L5).
   */
  private endCharge(entityId: EntityId, state: WeaponState): void {
    if (state.chargeStartTick > 0) {
      this.pendingChargeEvents.push({ entityId, weaponId: state.currentWeapon, charging: false });
    }
    state.chargeStartTick = 0;
  }

  /**
   * A switch the server makes for the player, on a pickup.
   *
   * It cancels what the old weapon was doing, as any switch does. It does not
   * start the manual switch delay: the player did not ask for it, so it must
   * not hold up the switch they ask for next.
   *
   * The slot key needs care. The server keeps the last slot the player pressed
   * and switches when that value changes. Forgetting it here (as this code
   * used to) made the next tick read the old value as a fresh press and switch
   * straight back. Keeping it would make a press of that same key read as no
   * change. So `update` re-baselines on the next tick instead (`slotResync`).
   */
  private autoSwitch(entityId: EntityId, state: WeaponState, weaponId: string): void {
    const lastSwitch = this.lastSwitchTick.get(entityId);
    this.equip(entityId, state, weaponId, this.currentTick);
    if (lastSwitch === undefined) this.lastSwitchTick.delete(entityId);
    else this.lastSwitchTick.set(entityId, lastSwitch);
    this.slotResync.add(entityId);
  }

  private maxTotalAmmo(weapon: WeaponDef): number {
    const model = this.reloadModel(weapon);
    if (model === "none") return weapon.maxAmmo || 1;
    if (model === "clip") return Math.max(0, weapon.clipSize) + Math.max(0, weapon.maxAmmo);
    return Math.max(0, weapon.maxAmmo);
  }

  /** A melee weapon's full ammo, worked out once per weapon definition. */
  private readonly fullMeleeAmmo = new WeakMap<WeaponDef, WeaponAmmo>();

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
   * `position` is where a swapped-out weapon lands. Without it the swap still happens
   * but the old weapon is not dropped into the world.
   * @returns { added: true, dropped?: weaponId } or { added: false } if already owned
   */
  addWeapon(
    entityId: EntityId,
    weaponId: string,
    position?: Readonly<{ x: number; y: number; z: number }>,
  ): { added: boolean; dropped?: string } {
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
      if (isDefaultWeapon(state.currentWeapon) && !isDefaultWeapon(weaponId) && this.wantsAutoSwitch(entityId)) {
        this.autoSwitch(entityId, state, weaponId);
      }
      return { added: false };
    }

    const MAX_PICKABLE = 2; // not counting default weapon
    const nonDefaultWeapons = state.weapons.filter((w) => !isDefaultWeapon(w));

    if (nonDefaultWeapons.length < MAX_PICKABLE) {
      // Have room — just add
      state.weapons.push(weaponId);
      if (this.wantsAutoSwitch(entityId)) this.autoSwitch(entityId, state, weaponId);
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
      if (firstReal && this.wantsAutoSwitch(entityId)) {
        this.autoSwitch(entityId, state, firstReal);
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
    const pos = position;
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
    this.autoSwitch(entityId, state, weaponId);
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
  dropAllWeapons(eId: EntityId, pos: Readonly<{ x: number; y: number; z: number }>): void {
    const state = this.weaponStates.get(eId);
    if (!state) return;

    if (!this.droppedWeaponSystem) return;

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
      adsStartTick: null,
      manualAdsStartTick: null,
      dryFireTick: 0,
      switchReadyTick: 0,
      spreadHeat: 0,
      spreadHeatTick: 0,
    });
    // Reset edge detection so weapon slot changes are detected cleanly after respawn
    this.lastWeaponSlot.delete(id);
    this.lastSwitchTick.delete(id);
    this.slotResync.delete(id);
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
        const dead = this.weaponStates.get(entity.id);
        if (dead && entity.health?.dead) {
          this.endCharge(entity.id, dead);
          // Still held at respawn, it starts a fresh charge rather than firing this one.
          dead.wasAltFireDown = false;
          dead.adsStartTick = null;
          dead.manualAdsStartTick = null;
        }
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
      // After a server-made switch, the slot the player last pressed no longer
      // names the weapon in hand. If no new press has arrived since, clear it, so
      // that a press of ANY key (that one included) reads as a change.
      if (this.slotResync.delete(entity.id) && entity.input.weaponSlot === (this.lastWeaponSlot.get(entity.id) || 0)) {
        entity.input.weaponSlot = 0;
      }
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
          this.equip(entity.id, weaponState, newWeapon, tickNum);
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
          // Keep ammo at max (infinite melee). Only replaced when it changed:
          // this runs every tick a blade is held, and it is nearly always full.
          let full = this.fullMeleeAmmo.get(weapon);
          if (!full) {
            full = this.createAmmoState(weapon, weapon.maxAmmo || 1);
            this.fullMeleeAmmo.set(weapon, full);
          }
          const held = weaponState.ammo.get(weaponState.currentWeapon);
          if (!held || held.clip !== full.clip || held.reserve !== full.reserve) {
            weaponState.ammo.set(weaponState.currentWeapon, { ...full });
          }

          // --- Primary fire: melee slash (semi-auto on press) ---
          if (isFiring && !weaponState.wasFireButtonDown) {
            const fireInterval = fireIntervalTicks(weapon);
            const timeSinceFire = tickNum - weaponState.lastFireTick;
            if (timeSinceFire >= fireInterval && tickNum >= weaponState.switchReadyTick) {
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
              const delayTicks = Math.ceil((weapon.meleeDamageDelay || 0) * TICK_RATE);
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
          const chargeMaxTicks = Math.ceil((weapon.chargeTime || 1.0) * TICK_RATE);
          const chargeMinTicks = Math.ceil((weapon.chargeMinTime || 0.5) * TICK_RATE);

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

          const autoAds = (entity.input.buttons & InputButtons.AUTO_ADS) !== 0;
          const aiming = isAltFiring || (weapon.hipfireBlocked && isFiring);
          weaponState.adsStartTick = aiming ? (weaponState.adsStartTick ?? tickNum) : null;
          weaponState.manualAdsStartTick = isAltFiring && !autoAds ? (weaponState.manualAdsStartTick ?? tickNum) : null;
          if (isFiring && weapon.hipfireBlocked) {
            const adsTimeTicks = Math.ceil((weapon.ads?.time ?? 0.08) * TICK_RATE);
            hipfireAllowFire = tickNum - (weaponState.adsStartTick ?? tickNum) >= adsTimeTicks;
          }

          if (isFiring && hipfireAllowFire) {
            const fireInterval = fireIntervalTicks(weapon); // ticks between shots
            const timeSinceFire = tickNum - weaponState.lastFireTick;

            if (timeSinceFire >= fireInterval && tickNum >= weaponState.switchReadyTick) {
              const ammo = this.getAmmoState(weaponState, weapon);
              if (ammo.clip > 0 || this.reloadModel(weapon) === "none") {
                this.fireWeapon(state, entity, weapon, tick);
                this.consumeShot(weaponState, weapon);

                weaponState.lastFireTick = tickNum;
                weaponState.dryFireTick = 0;

                // Auto-reload clip weapons when the magazine is depleted.
                if (this.reloadModel(weapon) === "clip" && ammo.clip <= 0) {
                  this.startReload(weaponState, weapon, tickNum);
                }
              } else if (this.canReload(weaponState, weapon)) {
                // Reloadable again — a dry pull from before must not still be
                // armed, or the next time this gun runs out it would swap on the
                // very first pull instead of clicking.
                weaponState.dryFireTick = 0;
                this.startReload(weaponState, weapon, tickNum);
              } else {
                // Empty, and nothing left to reload from. Pulling on a dead gun
                // used to do nothing at all, which reads as the game ignoring you.
                this.handleDryFire(entity.id, weaponState, tickNum, !weaponState.wasFireButtonDown);
              }
            }
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

  /**
   * Where a shot goes, decided once for the damage ray and the fire event alike.
   *
   * - Pellet weapons: the look direction, plus a seed and cone from which the
   *   server and every client build the same pellets.
   * - Single-ray hitscan with a spread (the machinegun): one deviation inside
   *   the cone, which blooms open under sustained fire. The cone is taken at
   *   the current heat, then the shot heats the weapon; the heat drains while
   *   the trigger is off. Seeded by tick and shooter, so the re-sim and demos
   *   reproduce it.
   * - Everything else: the look direction (with Voltaic's beam wander).
   */
  private aimShot(shooter: Readonly<Entity>, weapon: WeaponDef, tick: TickNumber): ShotAim {
    const input = shooter.input!;
    // yaw/pitch are in radians from the client (Babylon.js camera). Negate pitch:
    // Babylon uses negative rotationX for looking UP. Beam wander bends the shot.
    const weaponState = this.weaponStates.get(shooter.id);
    const timedAim = weapon.adsRequireReady;
    const isADS =
      (input.buttons & ALT_FIRE_BUTTON) !== 0 &&
      (input.buttons & InputButtons.AUTO_ADS) === 0 &&
      (!timedAim ||
        (weaponState?.manualAdsStartTick != null &&
          (tick as number) - weaponState.manualAdsStartTick >= Math.ceil((weapon.ads?.time ?? 0.08) * TICK_RATE)));
    const wander = this.beamWanderOffset(weapon, shooter.id, tick, isADS);
    const yaw = input.yaw + wander.dYaw;
    const pitch = -input.pitch + wander.dPitch;
    const look = {
      x: Math.sin(yaw) * Math.cos(pitch),
      y: Math.sin(pitch),
      z: Math.cos(yaw) * Math.cos(pitch),
    };
    if (weapon.meleeRadius || (!weapon.hitscan && !weapon.adsRequireReady)) return { dir: look };

    if (firesPellets(weapon)) {
      const shotCount = (this.shotCounts.get(shooter.id) || 0) + 1;
      this.shotCounts.set(shooter.id, shotCount);
      const spreadDeg = isADS && weapon.adsSpread !== undefined ? weapon.adsSpread : weapon.spread;
      return {
        dir: look,
        pellets: { seed: computeSpreadSeed(tick as number, shooter.id as number, shotCount), spreadDeg },
      };
    }

    if (weapon.hitscanType === "beam" || !(weapon.spread || weapon.spreadBloom)) {
      return { dir: look };
    }
    const sinceLastShot = weaponState ? ((tick as number) - weaponState.spreadHeatTick) / TICK_RATE : Infinity;
    const idle = bloomIdleSeconds(sinceLastShot, fireIntervalTicks(weapon) / TICK_RATE);
    const heat = weaponState ? coolSpreadHeat(weapon, weaponState.spreadHeat, idle) : 0;
    const cone = spreadCone(weapon, heat, isADS);
    if (weaponState) {
      weaponState.spreadHeat = heatAfterShot(weapon, heat);
      weaponState.spreadHeatTick = tick as number;
    }
    if (cone <= 0) return { dir: look };
    const seed = computeSpreadSeed(tick as number, shooter.id as number, BULLET_SPREAD_SALT);
    return { dir: generateSpreadDirections(seed, 1, cone, yaw, -pitch)[0] };
  }

  private fireWeapon(state: WorldState, shooter: Readonly<Entity>, weapon: WeaponDef, tick: TickNumber): void {
    // An electrical weapon fired underwater puts its charge into the water
    // instead of down the barrel. The ammo is already spent by the time we get
    // here, which is correct — discharging is a mistake, not a free action.
    if (dischargesInWater(weapon.id, shooter.physics?.waterLevel ?? 0)) {
      this.dischargeIntoWater(state, shooter, weapon);
      return;
    }

    // Emit fire event for network broadcast. Its direction is the shot's own,
    // spread included, so every client (the shooter's too) draws the tracer
    // where the damage ray went.
    const aim = shooter.input ? this.aimShot(shooter, weapon, tick) : null;
    if (aim) {
      const origin = this.getFireViewOrigin(shooter);
      if (origin) {
        this.pendingFireEvents.push({
          entityId: shooter.id,
          weaponId: weapon.id,
          originX: origin.x,
          originY: origin.y,
          originZ: origin.z,
          dirX: aim.dir.x,
          dirY: aim.dir.y,
          dirZ: aim.dir.z,
          ...(aim.pellets ? { pelletSeed: aim.pellets.seed, pelletSpread: aim.pellets.spreadDeg } : {}),
        });
      }
    }

    // Route to melee or ranged
    if (weapon.meleeRadius) {
      this.fireMelee(state, shooter, weapon);
    } else if (weapon.hitscan && aim) {
      this.fireHitscan(state, shooter, weapon, aim);
    } else {
      this.fireProjectile(state, shooter, weapon, weapon.adsRequireReady ? aim?.dir : undefined);
    }
  }

  /**
   * The charge goes into the water.
   *
   * The shooter dies outright — gibbed, since this is an explosion in a
   * conductor rather than a bullet — and everyone else sharing the liquid
   * takes falloff damage. Being in water is what connects a bystander to it:
   * someone standing dry on the poolside is safe at any distance, which is
   * what makes the pool itself the hazard rather than the radius.
   *
   * Routed through the ordinary damage queue so scoring, obituaries, armor and
   * knockback all behave exactly as they do for any other kill.
   */
  private dischargeIntoWater(state: WorldState, shooter: Readonly<Entity>, weapon: WeaponDef): void {
    const origin = shooter.transform?.position;
    if (!origin) return;

    debugLog(
      "discharge",
      () =>
        `[Discharge] ${shooter.id} fired ${weapon.id} at water level ${shooter.physics?.waterLevel ?? 0} — discharging`,
    );

    // No dedicated wire event yet: the kill and its obituary already reach the
    // client through the ordinary damage path, so the rule is complete and
    // scoreable. A burst and a crack of its own are owed presentation.
    for (const other of state.entitiesByType(EntityType.Player)) {
      if (other.id === shooter.id || other.health?.dead) continue;
      const pos = other.transform?.position;
      if (!pos) continue;

      const dx = pos.x - origin.x;
      const dy = pos.y - origin.y;
      const dz = pos.z - origin.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (!caughtInDischarge(other.physics?.waterLevel ?? 0, distSq)) continue;

      this.pendingDamage.push({
        victimId: other.id,
        attackerId: shooter.id,
        damage: dischargeDamageAt(Math.sqrt(distSq)),
        armorPiercing: 0,
        damageType: DamageType.Rail,
        hitLocation: HitLocation.Body,
      });
    }

    // The shooter last, so the bystanders above are credited to a living
    // attacker rather than to a corpse.
    this.pendingDamage.push({
      victimId: shooter.id,
      attackerId: shooter.id,
      // Far past any health/armor combination: this is not survivable, and a
      // number that merely usually kills would be a worse rule than a lethal
      // one.
      damage: 1000,
      armorPiercing: 1,
      damageType: DamageType.Rail,
      hitLocation: HitLocation.Body,
    });
  }

  /** Queue a step-in only while forward input and horizontal motion agree. */
  private queueMeleeDash(shooter: Readonly<Entity>, weapon: WeaponDef): void {
    const distance = weapon.meleeDashDistance ?? 0;
    if (distance <= 0 || !this.movementSubsystem || !shooter.input || !shooter.physics) return;
    const buttons = shooter.input.buttons;
    if (!(buttons & InputButtons.FORWARD) || buttons & InputButtons.BACK) return;

    const yaw = shooter.input.yaw;
    const dirX = Math.sin(yaw);
    const dirZ = Math.cos(yaw);
    const velocity = shooter.physics.velocity;
    // Ignore tiny perpendicular projection noise at rotated view angles.
    if (!(velocity.x * dirX + velocity.z * dirZ > 0.001)) return;
    this.movementSubsystem.queueMeleeDash({
      entityId: shooter.id,
      dirX,
      dirZ,
      distance,
    });
  }

  /** Melee cone check for all targets within range and meleeRadius. */
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
      const hitLocation = locateHit(weapon, yOffset);

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
    const position = this.clipProjectileSpawn(origin, {
      x: origin.x + Math.sin(yaw) * Math.cos(pitch) * offset,
      y: origin.y + Math.sin(pitch) * offset,
      z: origin.z + Math.cos(yaw) * Math.cos(pitch) * offset,
    });

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

  private fireHitscan(state: WorldState, shooter: Readonly<Entity>, weapon: WeaponDef, aim: ShotAim): void {
    if (!shooter.transform || !shooter.input) return;

    // Calculate fire direction from view angles (already in radians)
    const yaw = shooter.input.yaw;

    const start = this.getFireViewOrigin(shooter);
    if (!start) return;
    const maxRange = weapon.range || 5000;
    // Resolved once per trigger pull, so every pellet of a shot is judged
    // against the same instant of the world.
    const rewind = this.rewindFor(state, shooter);

    // Pellet weapons (riotgun): fire N rays from the shot's seed and cone (aimShot)
    if (firesPellets(weapon) && aim.pellets) {
      const { seed, spreadDeg } = aim.pellets;
      const directions = generateSpreadDirections(seed, weapon.pelletCount, spreadDeg, yaw, shooter.input.pitch);

      // Trace each pellet individually
      for (const dir of directions) {
        this.traceHitscanRay(state, shooter, weapon, start, dir, maxRange, rewind);
      }
      return;
    }

    // Standard single-ray hitscan (machinegun, electrobolt, etc.)
    // Use the same look-direction convention as fireProjectile/fireMelee and the
    // pendingFireEvents tracer visual: dir.y = sin(-input.pitch). This previously
    // double-negated (`const p = -pitch`, where pitch is already -input.pitch),
    // inverting vertical aim so the damage ray disagreed with the tracer and every
    // other fire path — machinegun/electrobolt/instagun hit low when aiming up (F2).
    // The shot's direction from aimShot: the machinegun's spread, or Voltaic's
    // hip-fire wander, already in it, and the same as the fire event's.
    const dir = aim.dir;
    const primaryHit = this.traceHitscanRay(state, shooter, weapon, start, dir, maxRange, rewind);
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
    rewind: RewindView | null = null,
  ): HitscanHitResult | null {
    // World occlusion: a hitscan ray stops at the first solid surface, so find
    // where it meets the BSP world. Any target beyond that distance is standing
    // behind a wall/floor and must NOT be hit (the "bots shoot through the floor"
    // bug — the sphere test alone had no notion of world geometry). With no
    // collision world wired in (unit tests, headless), this stays +Infinity and
    // the trace behaves exactly as before.
    const worldBlock = this.withRewoundMovers(rewind, () => this.traceWorldImpactDetails(start, dir, maxRange));
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

      // Judge the shot against where the shooter saw this body, not where it has
      // since run to. A target with no recorded position (just spawned) falls
      // back to the present rather than being made unhittable.
      const targetPos = rewind?.positions.get(target.id) ?? target.transform.position;

      // Simple sphere intersection test
      const toTarget = {
        x: targetPos.x - start.x,
        y: targetPos.y - start.y,
        z: targetPos.z - start.z,
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
        (closestPoint.x - targetPos.x) ** 2 + (closestPoint.y - targetPos.y) ** 2 + (closestPoint.z - targetPos.z) ** 2;

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
      const normalX = impactPoint.x - targetPos.x;
      const normalY = impactPoint.y - targetPos.y;
      const normalZ = impactPoint.z - targetPos.z;
      const normalLength = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ) || 1;
      // Hit! Determine location based on Y offset
      const yOffset = closestPoint.y - targetPos.y;
      const hitLocation = locateHit(weapon, yOffset);

      best = {
        entryDistance,
        id: target.id,
        position: { ...targetPos },
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

  private fireProjectile(state: WorldState, shooter: Readonly<Entity>, weapon: WeaponDef, direction?: Vec3): void {
    if (!shooter.transform || !shooter.input || !shooter.ownerId) return;

    // Calculate fire direction (already in radians from client)
    // Negate pitch: Babylon uses negative rotationX for looking UP
    let yaw = shooter.input.yaw;
    let pitch = -shooter.input.pitch;

    if (!direction && weapon.spread) {
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
      x: (direction?.x ?? Math.sin(yaw) * Math.cos(pitch)) * speed,
      y: (direction?.y ?? Math.sin(pitch)) * speed,
      z: (direction?.z ?? Math.cos(yaw) * Math.cos(pitch)) * speed,
    };

    // Spawn projectile slightly in front of shooter, along look direction
    // Q3-style: spawn point follows crosshair (pitch-aware), not fixed eye height
    const offset = 50;
    const origin = this.getFireViewOrigin(shooter);
    if (!origin) return;
    const position = this.clipProjectileSpawn(origin, {
      x: origin.x + Math.sin(yaw) * Math.cos(pitch) * offset,
      y: origin.y + Math.sin(pitch) * offset,
      z: origin.z + Math.cos(yaw) * Math.cos(pitch) * offset,
    });

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
