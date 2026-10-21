/**
 * FPSMovementSubsystem - Uses FPSMovementProfile for server-side physics
 *
 * This ensures physics parity between client and server by using
 * the EXACT same movement code (FPSMovementProfile).
 *
 * Replaces the simpler CharacterPhysicsSystem.
 */

import { MovementVars } from "../../../../engine/movement/MovementVars";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import type { CollisionWorld } from "../../../../engine/network/systems/collision/CollisionWorld";
import type { MovementInput } from "../../../../engine/network/systems/movement/MovementProfile";
import { Subsystem, type SubsystemConfig } from "../../../../engine/server/core/Subsystem";
import type { WorldState } from "../../../../engine/server/core/WorldState";
import type { EntityId, TickNumber } from "../../../../engine/server/ecs/types";
import { EntityType } from "../../../../engine/server/ecs/types";
import type { LiftActor } from "../../../../shared/bsp/LiftSystem";
import type { TriggerVolume } from "../../../../shared/bsp/TriggerTable";
import { Contents } from "../../../../shared/collision/CollisionWorld";
import type { QueuedInput } from "../../../../shared/server/simulation/components/InputComponent";
import type { PhysicsComponent } from "../../../../shared/server/simulation/components/PhysicsComponent";
import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "../../../../shared/server/simulation/physics/constants";
import type { WaterLevel } from "../../liquid/LiquidTypes";
import { applyKnockbackDrag } from "../../simulation/Knockback";
import type { AdvancedMovementResult } from "../../simulation/MovementConfig";
import { MovementProfile as FPSMovementProfile } from "../../simulation/MovementProfile";
import { debugEnabled, debugLog } from "../DebugLog";
import { type CombatSystem, DamageType, HitLocation } from "./CombatSystem";
import { createLiquidEffectState, type LiquidEffectState, tickLiquidEffects } from "./LiquidWorldEffects";

const CONFIG: SubsystemConfig = {
  name: "FPSMovement",
  priority: 10,
  tickRate: 0, // every base tick — the rate comes from ServerTiming, not a per-subsystem literal (QA-24)
};

/**
 * Adapts server InputComponent to FPSMovementProfile's MovementInput
 *
 * Uses the stored buttons bitmask directly so ALL button flags
 * (including SPRINT) are correctly passed through to simulate().
 */
function adaptInput(
  input: {
    forward: number; // World-space Z component (= direction.z from client)
    right: number; // World-space X component (= direction.x from client)
    pitch: number;
    yaw: number;
    buttons: number; // Raw button bitmask from client
    sequence?: number; // Client command seq — command identity, not sim time
  },
  simStep: number,
): MovementInput {
  // Server receives world-space direction from client:
  // input.forward = command.direction.z
  // input.right = command.direction.x
  // These are ALREADY rotated by yaw on the client, so use them directly
  const wishX = input.right; // X component of world-space wish direction
  const wishZ = input.forward; // Z component of world-space wish direction

  // Use the stored buttons bitmask directly — preserves SPRINT and all flags
  const buttons = input.buttons;

  return {
    direction: { x: wishX, y: 0, z: wishZ },
    viewAngles: { pitch: input.pitch, yaw: input.yaw },
    buttons,
    sequence: input.sequence,
    // The effect clock counts server ticks, not command sequences. Physics
    // advances exactly one dt per tick whether or not a command arrived, so a
    // starved player's walljump window, slide, ladder cooldown and water jump
    // have to expire on the same schedule as the gravity pulling them down
    // (N04). A repeated command reuses its sequence; it never reuses a step.
    simStep: simStep,
    isPressed: (button: number) => (buttons & button) !== 0,
  };
}

/**
 * The keys behind a world-space wish direction: its part along the view's
 * right and forward axes. Diagonals count on both; a tiny remainder counts on
 * neither.
 */
export function movementKeys(
  wish: { forward: number; right: number },
  yaw: number,
): { strafe: -1 | 0 | 1; forward: -1 | 0 | 1 } {
  const along = (x: number, z: number) => wish.right * x + wish.forward * z;
  const key = (amount: number): -1 | 0 | 1 => (amount > 0.25 ? 1 : amount < -0.25 ? -1 : 0);
  return {
    strafe: key(along(Math.cos(yaw), -Math.sin(yaw))),
    forward: key(along(Math.sin(yaw), Math.cos(yaw))),
  };
}

/** Apply movement simulation result to entity transform and physics */
function applyResult(
  transform: { position: { x: number; y: number; z: number }; rotation?: { x: number; y: number; z: number } },
  physics: PhysicsComponent,
  result: AdvancedMovementResult,
  input?: { pitch: number; yaw: number; forward: number; right: number },
): void {
  transform.position = result.position;
  physics.velocity = result.velocity;
  physics.grounded = result.grounded;
  physics.isSliding = result.isSliding;
  physics.isCrouching = result.isCrouching;
  physics.crouchViewOffset = result.crouchViewOffset ?? 0;
  physics.wallJumpState = result.wallJumpState ?? "none";
  physics.ledgeGrabState = result.ledgeGrabState ?? "none";
  physics.actualHorizSpeed = result.actualHorizSpeed ?? 0;
  physics.slidePhase = result.slidePhase ?? 0;
  physics.ledgeGrabPhase = result.ledgeGrabPhase ?? 0;
  if (input) {
    const keys = movementKeys(input, input.yaw);
    physics.strafeInput = keys.strafe;
    physics.forwardInput = keys.forward;
  }
  physics.waterLevel = result.waterLevel ?? 0;
  physics.liquidContents = result.liquidContents ?? 0;

  // Sync player rotation so remote clients can orient the model
  if (input && transform.rotation) {
    transform.rotation.x = input.pitch;
    transform.rotation.y = input.yaw;
  }
}

/** Queued knockback impulse (applied before simulate to bypass ground friction/clipping) */
interface KnockbackImpulse {
  entityId: EntityId;
  /** Normalized direction (already has upward bias) */
  dirX: number;
  dirY: number;
  dirZ: number;
  /** Total force = damage × kbScale × selfMult */
  force: number;
  /** Fraction of horizontal speed to strip (0–0.8) */
  stunFraction: number;
}

/** Queued melee lunge (server-authoritative horizontal displacement). */
interface MeleeDash {
  entityId: EntityId;
  /** Normalized horizontal direction. */
  dirX: number;
  dirZ: number;
  /** Distance in world units. */
  distance: number;
}

const MELEE_DASH_BOUNDS = {
  min: { x: -16, y: -24, z: -16 },
  max: { x: 16, y: 40, z: 16 },
};
const MAX_MELEE_DASH_DISTANCE = 96;
const MELEE_DASH_COLLISION_EPSILON = 0.02;
const PLAYER_SEPARATION_BOUNDS = {
  min: { x: -16, y: -24, z: -16 },
  max: { x: 16, y: 40, z: 16 },
};
const PLAYER_SEPARATION_COLLISION_EPSILON = 0.02;

const LIFT_RIDER_TYPES = [EntityType.Player, EntityType.Item] as const;

export class FPSMovementSubsystem extends Subsystem {
  private collisionWorld: CollisionWorld | null = null;

  // Per-entity movement profiles (each has its own state)
  private movementProfiles: Map<number, FPSMovementProfile> = new Map();

  /** Pending knockback impulses queued by CombatSystem */
  private pendingImpulses: KnockbackImpulse[] = [];

  /** Pending blade/melee dashes queued by WeaponSystem. */
  private pendingMeleeDashes: MeleeDash[] = [];

  /** Map trigger volumes (teleporters/jumppads) installed into every profile. */
  private triggerVolumes: TriggerVolume[] = [];

  /** Effect-clock step each entity's knockback drag started from (for air drag timing). */
  private knockbackStart: Map<number, number> = new Map();
  private lastMovementTick = 0;

  /**
   * Drag age AFTER the last simulated step (Simulation's published tick is one
   * later), counted in movement steps. Null until the impulse's first step: a
   * player waiting for its commands has taken none yet.
   */
  getKnockbackAge(entityId: number): number | null {
    const start = this.knockbackStart.get(entityId);
    if (start === undefined) return null;
    const age = this.lastMovementTick + (this.stepOffset.get(entityId) ?? 0) - start;
    return age >= 0 ? age : null;
  }

  /** Per-entity speed bonus from weapon (e.g., +25 for blade) */
  private weaponSpeedBonuses: Map<number, number> = new Map();

  /** Per-player air and burn timers. Dropped on death, so a respawn breathes. */
  private liquidEffects: Map<number, LiquidEffectState> = new Map();

  /**
   * Last input consumed per entity — repeated when no fresh command arrives this
   * tick, so physics advances at the fixed server rate regardless of a client's
   * input rate (server-authoritative; no client can slow/skip its own physics).
   */
  private lastInput: Map<number, QueuedInput> = new Map();

  /** Consecutive ticks each entity has heard nothing from its client, late commands included. */
  private starvationTicks: Map<number, number> = new Map();

  /**
   * Ticks each entity has waited without a step and not yet made up. Catch-up
   * repays them; nothing else may run a second step in a tick.
   */
  private pauseDebt: Map<number, number> = new Map();

  /**
   * Each entity's effect clock relative to the world tick: one less for every
   * tick it waited, one more for every catch-up step. Movement steps, not
   * ticks, are what the client counts.
   */
  private stepOffset: Map<number, number> = new Map();

  /**
   * Newest command sequence each entity's physics has accounted for: the command
   * it simulated, or the one a guess stood in for. It is the ACK clients replay from.
   */
  private accountedSeq: Map<number, number> = new Map();

  /** Newest real command sequence each entity has taken from its queue, run or dropped. */
  private newestRealSeq: Map<number, number> = new Map();

  /** Smallest queue depth seen in the current drain window, and the window's age in ticks. */
  private drainWindow: Map<number, { minDepth: number; ticks: number }> = new Map();

  /**
   * Max buffered commands per entity: two seconds. A stalled upload delivers
   * its backlog at once, and every command dropped here is a step the client
   * predicted and the server never takes. Catch-up is bounded by owed ticks,
   * so a deep queue banks nothing.
   */
  private static readonly MAX_INPUT_BUFFER = 2 * TICK_RATE;
  /**
   * Owed ticks past which a silent player is guessed for instead of waiting
   * (500 ms). Bounds how far behind real time a player can fall, and so how
   * long anyone can hang frozen or slowed by withholding commands.
   */
  private static readonly MAX_PAUSE_TICKS = TICK_RATE / 2;
  /**
   * Queue depth from which owed ticks are repaid at once, a second step per
   * tick: deeper than a 10 FPS client's per-frame burst, so ordinary frame
   * bursts keep their jitter buffer and only a stall's backlog runs fast.
   */
  private static readonly CATCH_UP_DEPTH = 12;
  /** Furthest a run of guesses may account ahead of the newest real command (256 ms). */
  private static readonly MAX_CLAIMED_AHEAD = 32;
  /** A queue that never fell below this depth for a whole window catches up, or gives, one command. */
  private static readonly DRAIN_MIN_DEPTH = 3;
  private static readonly DRAIN_WINDOW_TICKS = TICK_RATE;
  /** Ticks of repeated stale input tolerated before action buttons are cleared —
   *  ~24ms @125Hz, enough to ride out one dropped packet without stuttering. */
  private static readonly BUTTON_HOLD_GRACE_TICKS = 3;
  /**
   * Action buttons stripped once an entity starves past the grace window, so a
   * frozen/silent client stops *acting* (movement axes are still repeated). Trade-offs:
   *  - JUMP: prevents a silent client from auto-bunny-hopping forever. Cost: a real
   *    bhopper who drops >grace ticks of packets falls out of the hop — acceptable
   *    (no fresh input ⇒ we don't assume the key is still held).
   *  - ALT_FIRE: for the blade's hold-to-charge alt, stripping mid-charge reads as a
   *    release and may auto-fire one charged shot. Deliberate: it fires along the last
   *    aim and can't repeat, which still satisfies "no continuous fire from a frozen client."
   */
  private static readonly ACTION_BUTTON_MASK =
    InputButtons.FIRE |
    InputButtons.ALT_FIRE |
    InputButtons.AUTO_ADS |
    InputButtons.RELOAD |
    InputButtons.USE |
    InputButtons.JUMP;
  /** Log-only authority tripwire; high enough to avoid normal movement/KB false positives. */
  private static readonly MAX_TICK_STEP = 128;
  /** Per-entity count of tripwire firings, surfaced as an anti-cheat signal (WO-AC2). */
  private tripwireHits: Map<number, number> = new Map();

  /** Combat system ref for server-authoritative landing damage. */
  private combatSystem: CombatSystem | null = null;

  /**
   * Airborne fall tracking: last grounded Y is the BSP/map height the player
   * actually left. Peak Y is retained for diagnostics/fallback, but damage uses
   * floor-to-floor drop so a normal jump arc does not inflate a short ledge.
   */
  private fallStartY: Map<number, number> = new Map();
  private fallPeakY: Map<number, number> = new Map();
  private lastGroundY: Map<number, number> = new Map();

  /**
   * Entities that have touched the ground at least once since (re)spawn.
   * Spawns place players airborne (grounded=false) and the spawn-point floor
   * snap only covers ~72u, so an elevated spawn would otherwise register as a
   * damaging fall. Tracking is armed by the first grounded tick after spawn.
   */
  private fallArmed: Set<number> = new Set();
  private lastSpawnTick: Map<number, number> = new Map();

  constructor(collisionWorld?: CollisionWorld) {
    super(CONFIG);
    this.collisionWorld = collisionWorld ?? null;
  }

  /**
   * Set the collision world (e.g., after BSP load)
   */
  setCollisionWorld(world: CollisionWorld | null): void {
    this.collisionWorld = world;
    debugLog("setup", () => `[FPSMovementSubsystem] Collision world set: ${world ? "yes" : "no"}`);
  }

  /**
   * Get the current collision world
   */
  getCollisionWorld(): CollisionWorld | null {
    return this.collisionWorld;
  }

  /**
   * Get or create movement profile for an entity
   */
  private getProfile(entityId: number): FPSMovementProfile {
    let profile = this.movementProfiles.get(entityId);
    if (!profile) {
      profile = new FPSMovementProfile();
      profile.setTriggerVolumes(this.triggerVolumes);
      this.movementProfiles.set(entityId, profile);
    }
    return profile;
  }

  /**
   * Set the map's trigger volumes (teleporters/jumppads, shared TriggerTable).
   * Applied to every existing profile and to profiles created later.
   */
  setTriggerVolumes(volumes: TriggerVolume[]): void {
    this.triggerVolumes = volumes;
    for (const profile of this.movementProfiles.values()) {
      profile.setTriggerVolumes(volumes);
    }
  }

  /**
   * Reset grounded state for an entity (called by CombatSystem after knockback
   * so friction doesn't eat the impulse on the next movement tick)
   */
  resetGroundedState(entityId: number, grounded: boolean): void {
    this.getProfile(entityId).resetPhysicsState(grounded);
  }

  /** Wire combat so movement can enqueue fall damage on landing. */
  setCombatSystem(combat: CombatSystem): void {
    this.combatSystem = combat;
  }

  /**
   * Remove the oldest `count` queued commands and return the newest of them.
   *
   * A dropped command forfeits its physics; that is what stops a flooding
   * client banking time. It must not forfeit a one-shot INTENT that no later
   * command repeats: a frame hitch makes the client emit a burst, and a weapon
   * switch rides only the first of them (N10). The request rides the oldest
   * surviving command, or the returned one when nothing survives, so carrying
   * it costs no extra physics step. Only the newest request survives, and only
   * when nothing newer already asks for a different weapon.
   */
  private dropOldest(queue: QueuedInput[], count: number): QueuedInput | undefined {
    const dropped = queue.splice(0, count);
    let requested = 0;
    for (const cmd of dropped) {
      if (cmd.weaponSlot > 0) requested = cmd.weaponSlot;
    }
    let newest = dropped[dropped.length - 1];
    if (requested > 0) {
      if (queue.length > 0) {
        if (queue[0].weaponSlot === 0) queue[0] = { ...queue[0], weaponSlot: requested };
      } else if (newest && newest.weaponSlot === 0) {
        newest = { ...newest, weaponSlot: requested };
      }
    }
    return newest;
  }

  /** Clear movement history/impulses that must not cross warmup into live play. */
  resetForMatch(): void {
    this.movementProfiles.clear();
    this.pendingImpulses = [];
    this.pendingMeleeDashes = [];
    this.knockbackStart.clear();
    this.weaponSpeedBonuses.clear();
    this.lastInput.clear();
    this.starvationTicks.clear();
    this.pauseDebt.clear();
    this.stepOffset.clear();
    this.accountedSeq.clear();
    this.newestRealSeq.clear();
    this.drainWindow.clear();
    this.fallStartY.clear();
    this.fallPeakY.clear();
    this.lastGroundY.clear();
    this.fallArmed.clear();
    this.lastSpawnTick.clear();
  }

  private clearFallTracking(entityId: number): void {
    this.fallStartY.delete(entityId);
    this.fallPeakY.delete(entityId);
  }

  private updateFallDamageTracking(
    entityId: EntityId,
    positionY: number,
    grounded: boolean,
    buttons: number,
    waterLevel: WaterLevel = 0,
  ): void {
    const eid = entityId as number;

    // Liquid breaks a fall, and it also breaks the accounting. A swimmer is
    // ungrounded, so without this the tracker keeps measuring from wherever
    // they left solid ground and bills them for the whole drop the moment they
    // touch the bottom — a player who dived safely into a pool takes damage
    // for it several seconds later.
    if (waterLevel > 0) {
      this.clearFallTracking(eid);
      this.lastGroundY.set(eid, positionY);
      this.fallArmed.add(eid);
      return;
    }

    if (!grounded) {
      // Not armed = still in the post-spawn drop -> never a damaging fall.
      if (!this.fallArmed.has(eid)) return;
      if (!this.fallStartY.has(eid)) {
        this.fallStartY.set(eid, this.lastGroundY.get(eid) ?? positionY);
      }
      const peak = this.fallPeakY.get(eid);
      this.fallPeakY.set(eid, peak === undefined ? positionY : Math.max(peak, positionY));
      return;
    }

    this.fallArmed.add(eid);

    const peakY = this.fallPeakY.get(eid);
    const startY = this.fallStartY.get(eid);
    this.clearFallTracking(eid);
    this.lastGroundY.set(eid, positionY);
    if (peakY === undefined && startY === undefined) return;

    // Use the map height the player left, not jump/knockback apex height. This
    // keeps thresholds in BSP units: a short ledge remains short even if the
    // player hops before landing.
    const mapDrop = (startY ?? peakY ?? positionY) - positionY;
    this.queueFallDamage(entityId, mapDrop, buttons);
  }

  /**
   * Drowning, and the damage lava and slime deal.
   *
   * Runs after movement so it reads the water level the step actually ended
   * with rather than the one it started from. A dead player is dropped from
   * the map entirely: a corpse does not drown, and clearing the entry is what
   * makes a respawn start with full lungs.
   */
  private applyLiquidWorldEffects(entityId: EntityId, physics: PhysicsComponent, dead: boolean, dt: number): void {
    const eid = entityId as number;

    if (dead) {
      this.liquidEffects.delete(eid);
      return;
    }

    let state = this.liquidEffects.get(eid);
    if (!state) {
      state = createLiquidEffectState();
      this.liquidEffects.set(eid, state);
    }

    // `liquidContents` is in the SHARED vocabulary — translated once at the
    // collision boundary, not raw BSP flags. Reading it with the engine's
    // ContentFlags would report slime for every lava pit, which is the exact
    // aliasing that translation exists to prevent.
    const isLava = (physics.liquidContents & Contents.LAVA) !== 0;
    const isSlime = (physics.liquidContents & Contents.SLIME) !== 0;

    const effect = tickLiquidEffects(state, physics.waterLevel, isLava, isSlime, dt);

    if (effect.burnDamage > 0) {
      this.combatSystem?.queueDamage({
        victimId: entityId,
        attackerId: entityId,
        damage: effect.burnDamage,
        armorPiercing: 0,
        damageType: DamageType.World,
        hitLocation: HitLocation.Body,
      });
    }

    if (effect.drownDamage > 0) {
      this.combatSystem?.queueDamage({
        victimId: entityId,
        attackerId: entityId,
        damage: effect.drownDamage,
        // Armor does not help your lungs.
        armorPiercing: 1,
        damageType: DamageType.World,
        hitLocation: HitLocation.Body,
      });
    }
  }

  /**
   * Telefrag: kill any living player whose bounding box overlaps the
   * teleporter exit the moment someone comes through (Q3 behavior). Credits
   * the frag to the teleporting player.
   */
  private telefragAtExit(
    state: WorldState,
    teleporterId: EntityId,
    exitPos: { x: number; y: number; z: number },
  ): void {
    if (!this.combatSystem) return;

    // Q3 player box: radius 16, −24 feet / +40 head around the origin.
    const R2 = 32; // sum of both players' radii
    for (const other of state.entitiesByType(EntityType.Player)) {
      if (other.id === teleporterId || !other.transform || other.health?.dead) continue;

      const o = other.transform.position;
      if (
        Math.abs(o.x - exitPos.x) < R2 &&
        Math.abs(o.z - exitPos.z) < R2 &&
        exitPos.y - 24 < o.y + 40 &&
        exitPos.y + 40 > o.y - 24
      ) {
        this.combatSystem.queueDamage({
          victimId: other.id,
          attackerId: teleporterId,
          damage: 9999,
          armorPiercing: 1,
          damageType: DamageType.Telefrag,
          hitLocation: HitLocation.Body,
        });
      }
    }
  }

  private queueFallDamage(victimId: EntityId, rawDrop: number, buttons: number): void {
    if (!this.combatSystem || rawDrop <= 0) return;

    const vars = MovementVars.getInstance();
    if (vars.get("sv_falldamage") <= 0) return;

    const minDrop = Math.max(0, vars.get("sv_falldamage_min"));
    const fullDrop = Math.max(minDrop + 1, vars.get("sv_falldamage_full"));
    const fatalDrop = Math.max(fullDrop + 1, vars.get("sv_falldamage_fatal"));
    const crouchSoften = Math.max(0, vars.get("sv_falldamage_crouchsoften"));
    const crouched = (buttons & InputButtons.CROUCH) !== 0;
    const effectiveDrop = Math.max(0, rawDrop - (crouched ? crouchSoften : 0));

    // DIAGNOSTIC: ground-truth the fall distance in raw sim units (= BSP units, 1:1
    // with the sv_falldamage_* thresholds — no Babylon scaling in the sim path).
    // Server-console only; read these against how big the drop *looked* in-game.
    const band =
      effectiveDrop >= fatalDrop
        ? "FATAL"
        : effectiveDrop >= fullDrop
          ? "CRUSH"
          : effectiveDrop >= minDrop
            ? "RAMP"
            : "SAFE";
    debugLog(
      "falldamage",
      () =>
        `[FallDamage] eid=${victimId} rawDrop=${rawDrop.toFixed(1)}u effective=${effectiveDrop.toFixed(1)}u` +
        ` crouched=${crouched} band=${band} (min=${minDrop} full=${fullDrop} fatal=${fatalDrop})`,
    );

    if (effectiveDrop < minDrop) return;

    if (effectiveDrop >= fatalDrop) {
      this.combatSystem.queueDamage({
        victimId,
        attackerId: victimId,
        damage: 9999,
        armorPiercing: 1,
        damageType: DamageType.Fall,
        hitLocation: HitLocation.Body,
      });
      return;
    }

    if (effectiveDrop >= fullDrop) {
      this.combatSystem.queueDamage({
        victimId,
        attackerId: victimId,
        damage: 0,
        armorPiercing: 0,
        damageType: DamageType.FallCrush,
        hitLocation: HitLocation.Body,
      });
      return;
    }

    const t = (effectiveDrop - minDrop) / (fullDrop - minDrop);
    const damage = Math.round(Math.max(0, Math.min(100, t * 100)));
    // Skip sub-1 damage at the band's low edge - a 0-damage event would still
    // emit a processed-damage entry (pain flash/indicator) for no effect.
    if (damage < 1) return;
    this.combatSystem.queueDamage({
      victimId,
      attackerId: victimId,
      damage,
      armorPiercing: 0,
      damageType: DamageType.Fall,
      hitLocation: HitLocation.Body,
    });
  }

  /**
   * Queue a knockback impulse to be applied at the start of the next movement tick.
   * This ensures KB bypasses ground friction/clipping by being applied BEFORE simulate().
   */
  queueImpulse(impulse: {
    entityId: EntityId;
    dirX: number;
    dirY: number;
    dirZ: number;
    force: number;
    stunFraction: number;
  }): void {
    this.pendingImpulses.push(impulse);
  }

  /** Queue a server-authoritative melee lunge for the next movement tick. */
  queueMeleeDash(dash: { entityId: EntityId; dirX: number; dirZ: number; distance: number }): void {
    const len = Math.hypot(dash.dirX, dash.dirZ);
    if (len <= 0.001 || dash.distance <= 0) return;

    this.pendingMeleeDashes.push({
      entityId: dash.entityId,
      dirX: dash.dirX / len,
      dirZ: dash.dirZ / len,
      distance: Math.min(MAX_MELEE_DASH_DISTANCE, Math.max(0, dash.distance)),
    });
  }

  /**
   * Set a per-entity speed bonus (called by WeaponSystem based on equipped weapon).
   */
  setSpeedBonus(entityId: number, bonus: number): void {
    this.weaponSpeedBonuses.set(entityId, bonus);
  }

  update(state: WorldState, dt: number, tick: TickNumber): void {
    const tickNum = tick as number;
    this.lastMovementTick = tickNum;
    // Track KB'd entities for post-simulate debug logging
    const kbEntities = new Set<number>();

    // === DRAIN KNOCKBACK IMPULSES (before simulate!) ===
    // Apply queued impulses to entity velocity and set airborne.
    // This MUST happen before simulate() so the movement profile
    // processes the KB'd velocity as airborne (no ground friction/clipping).
    if (this.pendingImpulses.length > 0) {
      for (const impulse of this.pendingImpulses) {
        const ent = state.getEntityMut(impulse.entityId);
        if (!ent?.physics || ent.health?.dead) continue;

        const vel = ent.physics.velocity;
        const beforeY = vel.y;

        // 1. STUN — strip horizontal speed
        vel.x *= 1 - impulse.stunFraction;
        vel.z *= 1 - impulse.stunFraction;

        // 2. KB — add impulse
        vel.x += impulse.dirX * impulse.force;
        vel.y += impulse.dirY * impulse.force;
        vel.z += impulse.dirZ * impulse.force;

        // 3. Mark airborne so simulate() uses air physics (no ground friction)
        ent.physics.grounded = false;
        this.getProfile(impulse.entityId as number).resetPhysicsState(false);

        kbEntities.add(impulse.entityId as number);
        // Drag ages from the player's next movement step, which may come in a
        // later tick if the player is waiting for its commands.
        const kbId = impulse.entityId as number;
        this.knockbackStart.set(kbId, tickNum + (this.stepOffset.get(kbId) ?? 0));
        debugLog(
          "kb",
          () =>
            `[KB] Applied to entity=${impulse.entityId}: vel=(${vel.x.toFixed(1)},${vel.y.toFixed(1)},${vel.z.toFixed(1)}) beforeY=${beforeY.toFixed(1)} grounded=false pos=(${ent.transform?.position.x.toFixed(1)},${ent.transform?.position.y.toFixed(1)},${ent.transform?.position.z.toFixed(1)})`,
        );
      }
      this.pendingImpulses = [];
    }

    // === DRAIN MELEE DASHES (position step, not knockback velocity) ===
    if (this.pendingMeleeDashes.length > 0) {
      for (const dash of this.pendingMeleeDashes) {
        const ent = state.getEntityMut(dash.entityId);
        if (!ent?.transform || ent.health?.dead) continue;

        const pos = ent.transform.position;
        const end = {
          x: pos.x + dash.dirX * dash.distance,
          y: pos.y,
          z: pos.z + dash.dirZ * dash.distance,
        };

        let fraction = 1;
        if (this.collisionWorld) {
          const trace = this.collisionWorld.trace(pos, end, MELEE_DASH_BOUNDS);
          if (trace.hit) {
            fraction = Math.max(0, Math.min(1, trace.fraction) - MELEE_DASH_COLLISION_EPSILON);
          }
        }

        pos.x += dash.dirX * dash.distance * fraction;
        pos.z += dash.dirZ * dash.distance * fraction;
      }
      this.pendingMeleeDashes = [];
    }

    // Process all player entities
    // Advance shared map movers ONCE per world tick, with all live riders.
    // Position references are obtained through COW before a lift can carry them.
    if (this.collisionWorld?.lifts?.definitions.length) {
      const actors: LiftActor[] = [];
      // Anything with a body rides, so corpses and dropped weapons travel with
      // the floor instead of hanging in the air. Only a live player calls a lift.
      for (const type of LIFT_RIDER_TYPES)
        for (const entity of state.entitiesByType(type)) {
          // Check before taking a writable copy: most items have no body.
          if (!entity.transform || !entity.physics) continue;
          const mutable = state.getEntityMut(entity.id);
          if (!mutable?.transform || !mutable.physics) continue;
          actors.push({
            id: entity.id as number,
            position: mutable.transform.position,
            velocity: mutable.physics.velocity,
            passive: type !== EntityType.Player || !!entity.health?.dead || !entity.input,
          });
        }
      // Being squashed by a mover is world damage, credited like drowning is.
      for (const crush of this.collisionWorld.lifts.step(dt, actors)) {
        if (crush.id === undefined) continue;
        const victimId = crush.id as EntityId;
        this.combatSystem?.queueDamage({
          victimId,
          attackerId: victimId,
          damage: crush.damage,
          armorPiercing: 0,
          damageType: DamageType.World,
          hitLocation: HitLocation.Body,
        });
      }
    }
    for (const entity of state.entitiesByType(EntityType.Player)) {
      if (!entity.transform || !entity.physics || !entity.input) continue;

      const eid = entity.id as number;
      const spawnTick = entity.spawnTick ?? 0;
      if (this.lastSpawnTick.get(eid) !== spawnTick) {
        this.clearFallTracking(eid);
        this.lastGroundY.delete(eid);
        this.fallArmed.delete(eid); // re-arm on first grounded tick after spawn
        this.lastSpawnTick.set(eid, spawnTick);
        // A new life owes nothing: commands from before the death were cleared.
        this.pauseDebt.delete(eid);
      }

      // Dead entities: skip physics entirely (no corpse movement).
      // Respawn is now handled by RequestSpawn reliable message -> wantsRespawn flag.
      if (entity.health?.dead) {
        this.clearFallTracking(eid);
        this.knockbackStart.delete(eid);
        continue;
      }

      // Get mutable entity (COW)
      const mutable = state.getEntityMut(entity.id);
      if (!mutable?.transform || !mutable.physics || !mutable.input) continue;

      const input = mutable.input;

      // Get movement profile for this entity
      const profile = this.getProfile(entity.id);
      // Apply weapon speed bonus (e.g., blade = +25)
      profile.speedBonus = this.weaponSpeedBonuses.get(entity.id as number) ?? 0;

      // ── SERVER-AUTHORITATIVE MOVEMENT: ONE STEP PER COMMAND ──────────────
      // Each command the client predicted is one movement step here, so the
      // client's prediction and this simulation take the same steps from the
      // same commands, and reconciliation has nothing to correct.
      //
      // A tick normally runs the next queued command. When none has arrived the
      // player PAUSES (Quake behaviour): no step, and the tick is owed. Owed
      // ticks are repaid by running a second command in a later tick while a
      // backlog is queued (catch-up), so a stall costs the player nothing in
      // the end and other players see a brief hold. The debt is what bounds it:
      // catch-up only repays ticks already lost, so no client can take more
      // steps than real time allows by sending extra commands.
      //
      // A player cannot stay frozen or slowed for long either: past
      // MAX_PAUSE_TICKS of debt the server guesses instead — repeating the last
      // command so gravity and momentum go on — and each guess stands in for
      // the next command, advancing the ACK. That command, arriving late, is
      // dropped, and its aim, buttons and weapon request become the next guess.
      const queue = input.inputQueue;
      let accounted = this.accountedSeq.get(eid) ?? 0;
      let newestReal = this.newestRealSeq.get(eid) ?? 0;
      let debt = this.pauseDebt.get(eid) ?? 0;

      // De-duplication on ingest means sequences only rise within one command
      // stream. A command at or below the newest real one starts a new stream:
      // a resumed connection numbers its commands from 1 again.
      if (queue.length > 0 && queue[0].sequence <= newestReal) {
        accounted = queue[0].sequence - 1;
        newestReal = accounted;
        debt = 0;
      }

      // Cap the buffer. Catch-up cannot outrun the debt, so this bound is about
      // memory and the longest stall worth holding; past it the oldest go.
      if (queue.length > FPSMovementSubsystem.MAX_INPUT_BUFFER) {
        this.dropOldest(queue, queue.length - FPSMovementSubsystem.MAX_INPUT_BUFFER);
      }

      // A guess stood in for these commands, and its step has been taken.
      let late: QueuedInput | undefined;
      let lateCount = 0;
      while (lateCount < queue.length && queue[lateCount].sequence <= accounted) lateCount++;
      if (lateCount > 0) {
        late = this.dropOldest(queue, lateCount);
        if (late) newestReal = Math.max(newestReal, late.sequence);
      }

      // A queue that stayed this deep for a whole second holds latency no
      // jitter used. With ticks owed it catches one command up; with none owed
      // (a client sending ahead of real time) the oldest command is given up.
      let drainCatchUp = false;
      const drain = this.drainWindow.get(eid) ?? { minDepth: Number.POSITIVE_INFINITY, ticks: 0 };
      drain.minDepth = Math.min(drain.minDepth, queue.length);
      if (++drain.ticks >= FPSMovementSubsystem.DRAIN_WINDOW_TICKS) {
        if (drain.minDepth >= FPSMovementSubsystem.DRAIN_MIN_DEPTH) {
          if (debt > 0) {
            drainCatchUp = true;
          } else {
            const given = this.dropOldest(queue, 1);
            if (given) {
              accounted = Math.max(accounted, given.sequence);
              newestReal = Math.max(newestReal, given.sequence);
            }
          }
        }
        drain.minDepth = Number.POSITIVE_INFINITY;
        drain.ticks = 0;
      }
      this.drainWindow.set(eid, drain);

      const commands: QueuedInput[] = [];
      const fresh = queue.shift();
      if (fresh) {
        commands.push(fresh);
        accounted = fresh.sequence;
        newestReal = Math.max(newestReal, fresh.sequence);
        this.starvationTicks.set(eid, 0);
        // Repay one owed tick when a backlog has built up behind this one.
        if (debt > 0 && queue.length > 0 && (drainCatchUp || queue.length >= FPSMovementSubsystem.CATCH_UP_DEPTH)) {
          const next = queue.shift() as QueuedInput;
          commands.push(next);
          accounted = next.sequence;
          newestReal = Math.max(newestReal, next.sequence);
          debt--;
        }
      } else {
        const base = late ?? this.lastInput.get(eid);
        const silent = late ? 0 : (this.starvationTicks.get(eid) ?? 0) + 1;
        this.starvationTicks.set(eid, silent);
        // Past the grace window a silent client stops acting, whether it waits
        // or is guessed for (see ACTION_BUTTON_MASK).
        const held =
          base && silent > FPSMovementSubsystem.BUTTON_HOLD_GRACE_TICKS
            ? { ...base, buttons: base.buttons & ~FPSMovementSubsystem.ACTION_BUTTON_MASK }
            : base;
        // A late command with nothing behind it means the client runs behind
        // the guesses. Guessing again would make its next command late too, so
        // the player waits for it instead.
        const guess =
          held !== undefined &&
          !late &&
          debt >= FPSMovementSubsystem.MAX_PAUSE_TICKS &&
          accounted - newestReal < FPSMovementSubsystem.MAX_CLAIMED_AHEAD;
        if (held && guess) {
          commands.push(held);
          accounted++;
        } else if (!held && debt >= FPSMovementSubsystem.MAX_PAUSE_TICKS) {
          // Never heard from at all: once the pause runs out, gravity and
          // momentum still apply. The step stands in for no command.
          commands.push({
            forward: 0,
            right: 0,
            pitch: input.pitch,
            yaw: input.yaw,
            buttons: 0,
            sequence: accounted,
            weaponSlot: 0,
          });
        } else {
          debt = Math.min(debt + 1, FPSMovementSubsystem.MAX_INPUT_BUFFER);
          if (held) {
            this.lastInput.set(eid, held);
            input.buttons = held.buttons;
            input.pitch = held.pitch;
            input.yaw = held.yaw;
            if (held.weaponSlot > 0) input.weaponSlot = held.weaponSlot;
          }
        }
      }
      this.accountedSeq.set(eid, accounted);
      this.newestRealSeq.set(eid, newestReal);
      this.pauseDebt.set(eid, debt);

      // The effect clock and drag age count movement steps, not ticks: a
      // paused tick takes none and a catch-up tick takes two, exactly as the
      // client's prediction counted one per command.
      const firstStep = tickNum + (this.stepOffset.get(eid) ?? 0);
      this.stepOffset.set(eid, firstStep + commands.length - 1 - tickNum);

      // Weapons run once per tick, after movement. They see the newest command,
      // with any action button or weapon request an earlier command of this
      // tick carried, so a catch-up tick loses no press.
      let actions = 0;
      let weaponRequest = 0;
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        actions |= cmd.buttons & FPSMovementSubsystem.ACTION_BUTTON_MASK;
        if (cmd.weaponSlot > 0) weaponRequest = cmd.weaponSlot;
        input.forward = cmd.forward;
        input.right = cmd.right;
        input.pitch = cmd.pitch;
        input.yaw = cmd.yaw;
        input.buttons = cmd.buttons;
        input.sequence = cmd.sequence;
        // Weapons run after movement, so this is the view tick of the very
        // command whose fire button they are about to act on.
        input.viewTick = cmd.viewTick ?? 0;
        // A step for a player never heard from is no command to guess from later.
        if (this.lastInput.has(eid) || cmd.sequence > 0) this.lastInput.set(eid, cmd);
        this.stepPlayer(state, entity.id, profile, firstStep + i, dt);
      }
      if (commands.length > 0) {
        input.buttons |= actions;
        if (weaponRequest > 0) input.weaponSlot = weaponRequest;
        // Ack the newest command this entity's physics has accounted for (not the
        // last one received), so client reconciliation replays exactly the rest.
        input.lastProcessedSeq = accounted;
      }

      // Air and burn run on world time, stepping or not.
      const physics = mutable.physics;
      this.applyLiquidWorldEffects(entity.id, physics, entity.health?.dead ?? false, dt);

      if (kbEntities.has(eid)) {
        const transform = mutable.transform;
        debugLog(
          "kb",
          () =>
            `[KB POST-SIM] entity=${entity.id}: pos=(${transform.position.x.toFixed(1)},${transform.position.y.toFixed(1)},${transform.position.z.toFixed(1)}) vel=(${physics.velocity.x.toFixed(1)},${physics.velocity.y.toFixed(1)},${physics.velocity.z.toFixed(1)}) grounded=${physics.grounded} queue=${queue.length}`,
        );
      }
    }

    // NOTE: the old "track jump durations" diagnostic loop was removed — it
    // double-wrote the airborne-tracking maps the fall-damage path now owns
    // (two writers on shared state), and its only output was commented out.

    // ── DIAGNOSTIC: log per-entity physics every 125 ticks (1 second) ──
    // Off unless SHAG_DEBUG=phys is set. It was added for v0.9.10 QA with a note to remove it, and it
    // printed a line per player every second on every server (16 lines a second at 16 players), in
    // the one tick in 125 that was already the slowest.
    if (debugEnabled("phys") && tickNum % TICK_RATE === 0) {
      for (const entity of state.entitiesByType(EntityType.Player)) {
        if (!entity.transform || !entity.physics || entity.health?.dead) continue;
        const v = entity.physics.velocity;
        const p = entity.transform.position;
        const hSpeed = Math.sqrt(v.x * v.x + v.z * v.z);
        const qLen = entity.input?.inputQueue.length ?? -1;
        const fwd = entity.input?.forward?.toFixed(2) ?? "?";
        const rt = entity.input?.right?.toFixed(2) ?? "?";
        const btns = entity.input?.buttons ?? 0;
        console.log(
          `[PHYS] eid=${entity.id} owner=${entity.ownerId} hSpeed=${hSpeed.toFixed(1)} vy=${v.y.toFixed(1)} grounded=${entity.physics.grounded} pos=(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}) fwd=${fwd} rt=${rt} btns=${btns} qLen=${qLen}`,
        );
      }
    }

    // After all movement: push overlapping players apart (Q3-style)
    this.separatePlayers(state);
  }

  /**
   * One movement step for a live player, with the command already written to
   * its input component. `simStep` is the step's place on the player's effect
   * clock, the one its walljump, slide, ladder and water-jump deadlines use.
   */
  private stepPlayer(
    state: WorldState,
    entityId: EntityId,
    profile: FPSMovementProfile,
    simStep: number,
    dt: number,
  ): void {
    const mutable = state.getEntityMut(entityId);
    if (!mutable?.transform || !mutable.physics || !mutable.input) return;
    const { transform, physics, input } = mutable;
    const eid = entityId as number;

    // Knockback drag runs before the step's movement, at the step's age — the
    // order client prediction uses too.
    const kbStart = this.knockbackStart.get(eid);
    if (
      kbStart !== undefined &&
      applyKnockbackDrag(physics.velocity, physics.grounded, simStep - kbStart, dt) === null
    ) {
      this.knockbackStart.delete(eid);
    }

    const px = transform.position.x;
    const py = transform.position.y;
    const pz = transform.position.z;
    const result = profile.simulate(
      transform.position,
      physics.velocity,
      adaptInput(input, simStep),
      dt,
      this.collisionWorld,
    );
    applyResult(transform, physics, result, input);

    if (result.teleported) {
      // A teleport is not a fall: measure any post-teleport drop from the
      // exit, not from wherever the player left the ground pre-teleport.
      this.clearFallTracking(eid);
      this.lastGroundY.delete(eid);
      // Server-only side effect: telefrag players occupying the exit (Q3).
      this.telefragAtExit(state, entityId, transform.position);
    }
    this.updateFallDamageTracking(entityId, transform.position.y, physics.grounded, input.buttons, physics.waterLevel);

    const mdx = transform.position.x - px;
    const mdy = transform.position.y - py;
    const mdz = transform.position.z - pz;
    const moved = Math.sqrt(mdx * mdx + mdy * mdy + mdz * mdz);
    // Teleports legitimately move the whole map in one tick — whitelisted
    // from the position-delta tripwire (the profile applied them itself).
    if (moved > FPSMovementSubsystem.MAX_TICK_STEP && !result.teleported) {
      this.tripwireHits.set(eid, (this.tripwireHits.get(eid) ?? 0) + 1);
      console.warn(
        `[Authority] entity ${eid} moved ${moved.toFixed(0)}u in one tick ` +
          `(max ${FPSMovementSubsystem.MAX_TICK_STEP}) pos=(${transform.position.x.toFixed(0)},${transform.position.y.toFixed(0)},${transform.position.z.toFixed(0)}) - log-only`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Player-vs-player collision (post-movement separation)
  // ────────────────────────────────────────────────────────────────

  /** Player cylinder radius for entity-entity blocking */
  private static readonly PLAYER_RADIUS = 16;
  /** Combined radius: two players touching */
  private static readonly SEPARATION_DIST = FPSMovementSubsystem.PLAYER_RADIUS * 2; // 32
  /** Player bounds Y: origin at waist, -24 feet to +40 head */
  private static readonly PLAYER_MIN_Y = -24;
  private static readonly PLAYER_MAX_Y = 40;

  private clampPlayerSeparationPush(
    start: { x: number; y: number; z: number },
    end: { x: number; y: number; z: number },
  ): { x: number; y: number; z: number } {
    if (!this.collisionWorld) return end;

    const trace = this.collisionWorld.trace(start, end, PLAYER_SEPARATION_BOUNDS);
    if (!trace.hit || trace.fraction >= 1) return end;

    const safeFraction = Math.max(0, trace.fraction - PLAYER_SEPARATION_COLLISION_EPSILON);
    return {
      x: start.x + (end.x - start.x) * safeFraction,
      y: start.y + (end.y - start.y) * safeFraction,
      z: start.z + (end.z - start.z) * safeFraction,
    };
  }

  /**
   * Block overlapping players — Q3-style solid entity blocking.
   * Players are pushed apart symmetrically, and velocity is clipped
   * along the collision normal so they can't continuously push into each other.
   * If a push would move a player into BSP geometry, that push is clamped.
   */
  private separatePlayers(state: WorldState): void {
    const players: { id: EntityId; x: number; y: number; z: number }[] = [];
    for (const entity of state.entitiesByType(EntityType.Player)) {
      if (!entity.transform || entity.health?.dead) continue;
      players.push({
        id: entity.id,
        x: entity.transform.position.x,
        y: entity.transform.position.y,
        z: entity.transform.position.z,
      });
    }

    const sepDist = FPSMovementSubsystem.SEPARATION_DIST;
    const sepDistSq = sepDist * sepDist;

    // For each pair, resolve overlap
    for (let i = 0; i < players.length; i++) {
      const a = players[i];
      for (let j = i + 1; j < players.length; j++) {
        const b = players[j];

        // Y overlap check (cylinder)
        const aBottom = a.y + FPSMovementSubsystem.PLAYER_MIN_Y;
        const aTop = a.y + FPSMovementSubsystem.PLAYER_MAX_Y;
        const bBottom = b.y + FPSMovementSubsystem.PLAYER_MIN_Y;
        const bTop = b.y + FPSMovementSubsystem.PLAYER_MAX_Y;
        if (aTop <= bBottom || bTop <= aBottom) continue;

        // XZ distance
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        const distSq = dx * dx + dz * dz;
        if (distSq >= sepDistSq) continue;

        const dist = Math.sqrt(distSq);
        const overlap = sepDist - dist;
        if (overlap <= 0) continue;

        // Normal direction from B to A
        let nx: number, nz: number;
        if (dist > 0.001) {
          nx = dx / dist;
          nz = dz / dist;
        } else {
          // Exactly overlapping — arbitrary push
          nx = 1;
          nz = 0;
        }

        // Push each player half the overlap
        const pushDist = overlap * 0.5 + 0.5; // small extra margin

        // Apply push to player A, clamped against BSP/world geometry.
        const mutA = state.getEntityMut(a.id);
        if (mutA?.transform) {
          const start = { ...mutA.transform.position };
          const end = { x: start.x + nx * pushDist, y: start.y, z: start.z + nz * pushDist };
          mutA.transform.position = this.clampPlayerSeparationPush(start, end);

          // Clip velocity along collision normal
          if (mutA.physics) {
            const vDotN = mutA.physics.velocity.x * nx + mutA.physics.velocity.z * nz;
            if (vDotN < 0) {
              // Moving toward the other player — strip that component
              mutA.physics.velocity.x -= nx * vDotN;
              mutA.physics.velocity.z -= nz * vDotN;
            }
          }
        }

        // Apply push to player B (opposite direction), clamped against BSP/world geometry.
        const mutB = state.getEntityMut(b.id);
        if (mutB?.transform) {
          const start = { ...mutB.transform.position };
          const end = { x: start.x - nx * pushDist, y: start.y, z: start.z - nz * pushDist };
          mutB.transform.position = this.clampPlayerSeparationPush(start, end);

          // Clip velocity along collision normal
          if (mutB.physics) {
            const vDotN = mutB.physics.velocity.x * -nx + mutB.physics.velocity.z * -nz;
            if (vDotN < 0) {
              mutB.physics.velocity.x -= -nx * vDotN;
              mutB.physics.velocity.z -= -nz * vDotN;
            }
          }
        }

        // Update snapshot positions for subsequent pair checks
        if (mutA?.transform) {
          a.x = mutA.transform.position.x;
          a.z = mutA.transform.position.z;
        }
        if (mutB?.transform) {
          b.x = mutB.transform.position.x;
          b.z = mutB.transform.position.z;
        }
      }
    }
  }

  /**
   * Clean up profiles for disconnected entities
   */
  removeEntity(entityId: number): void {
    this.movementProfiles.delete(entityId);
    this.clearFallTracking(entityId);
    this.fallArmed.delete(entityId);
    // Air and burn timers. Dropped on death too, but a player can disconnect
    // alive — and entity ids are reused, so a leftover entry would hand the
    // next occupant of this id someone else's half-drowned lungs.
    this.liquidEffects.delete(entityId);
    this.lastSpawnTick.delete(entityId);
    this.lastGroundY.delete(entityId);
    this.knockbackStart.delete(entityId);
    this.pendingMeleeDashes = this.pendingMeleeDashes.filter((dash) => (dash.entityId as number) !== entityId);
    this.lastInput.delete(entityId);
    this.starvationTicks.delete(entityId);
    this.pauseDebt.delete(entityId);
    this.stepOffset.delete(entityId);
    this.accountedSeq.delete(entityId);
    this.newestRealSeq.delete(entityId);
    this.drainWindow.delete(entityId);
    this.tripwireHits.delete(entityId);
  }

  /** Cumulative authority-tripwire firings for an entity (anti-cheat signal, WO-AC2). */
  getTripwireHits(entityId: number): number {
    return this.tripwireHits.get(entityId) ?? 0;
  }
}
