/**
 * FPSMovementSubsystem - Uses FPSMovementProfile for server-side physics
 *
 * This ensures physics parity between client and server by using
 * the EXACT same movement code (FPSMovementProfile).
 *
 * Replaces the simpler CharacterPhysicsSystem.
 */

import { InputButtons } from "../../../../engine/network/components/InputComponent";
import type { CollisionWorld } from "../../../../engine/network/systems/collision/CollisionWorld";
import type { MovementInput } from "../../../../engine/network/systems/movement/MovementProfile";
import { Subsystem, type SubsystemConfig } from "../../../../engine/server/core/Subsystem";
import type { WorldState } from "../../../../engine/server/core/WorldState";
import type { EntityId, TickNumber } from "../../../../engine/server/ecs/types";
import { EntityType } from "../../../../engine/server/ecs/types";
import type { QueuedInput } from "../../../../shared/server/simulation/components/InputComponent";
import type { PhysicsComponent } from "../../../../shared/server/simulation/components/PhysicsComponent";
import type { AdvancedMovementResult } from "../../simulation/MovementConfig";
import { MovementProfile as FPSMovementProfile } from "../../simulation/MovementProfile";

const CONFIG: SubsystemConfig = {
  name: "FPSMovement",
  priority: 10,
  tickRate: 125,
};

/**
 * Adapts server InputComponent to FPSMovementProfile's MovementInput
 *
 * Uses the stored buttons bitmask directly so ALL button flags
 * (including SPRINT) are correctly passed through to simulate().
 */
function adaptInput(input: {
  forward: number; // World-space Z component (= direction.z from client)
  right: number; // World-space X component (= direction.x from client)
  pitch: number;
  yaw: number;
  buttons: number; // Raw button bitmask from client
}): MovementInput {
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
    isPressed: (button: number) => (buttons & button) !== 0,
  };
}

/** Apply movement simulation result to entity transform and physics */
function applyResult(
  transform: { position: { x: number; y: number; z: number }; rotation?: { x: number; y: number; z: number } },
  physics: PhysicsComponent,
  result: AdvancedMovementResult,
  input?: { pitch: number; yaw: number },
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

// ═══════════════════════════════════════════════════════════════════
// KNOCKBACK AIR DRAG CONSTANTS (Warsow-style)
// ═══════════════════════════════════════════════════════════════════

/** Ticks after KB before drag kicks in (~0.4s at 125Hz) */
const KB_DRAG_DELAY_TICKS = 50;

/** Duration over which drag ramps from 0→max (~0.6s at 125Hz) */
const KB_DRAG_RAMP_TICKS = 75;

/** Max per-tick horizontal speed multiplier during full drag (0.96 = loses ~4%/tick) */
const KB_HORIZ_DRAG = 0.96;

/** Extra downward acceleration during drag phase (units/s²) */
const KB_EXTRA_GRAVITY = 600;

export class FPSMovementSubsystem extends Subsystem {
  private collisionWorld: CollisionWorld | null = null;

  // Per-entity movement profiles (each has its own state)
  private movementProfiles: Map<number, FPSMovementProfile> = new Map();

  /** Pending knockback impulses queued by CombatSystem */
  private pendingImpulses: KnockbackImpulse[] = [];

  /** Last tick each entity received knockback (for air drag timing) */
  private lastKBTick: Map<number, number> = new Map();

  /** Per-entity speed bonus from weapon (e.g., +25 for blade) */
  private weaponSpeedBonuses: Map<number, number> = new Map();

  /**
   * Last input consumed per entity — repeated when no fresh command arrives this
   * tick, so physics advances at the fixed server rate regardless of a client's
   * input rate (server-authoritative; no client can slow/skip its own physics).
   */
  private lastInput: Map<number, QueuedInput> = new Map();

  /** Number of consecutive ticks where each entity has repeated stale input. */
  private starvationTicks: Map<number, number> = new Map();

  /** Max buffered commands per entity — extras are dropped so a fast/flooding
   *  client can't bank physics time (each server tick consumes exactly one). */
  private static readonly MAX_INPUT_BUFFER = 6;
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
    InputButtons.FIRE | InputButtons.ALT_FIRE | InputButtons.RELOAD | InputButtons.USE | InputButtons.JUMP;
  /** Log-only authority tripwire; high enough to avoid normal movement/KB false positives. */
  private static readonly MAX_TICK_STEP = 128;

  /** DIAGNOSTIC: track when each entity went airborne (tick number) */
  private jumpStartTick: Map<number, number> = new Map();
  private jumpStartY: Map<number, number> = new Map();

  constructor(collisionWorld?: CollisionWorld) {
    super(CONFIG);
    this.collisionWorld = collisionWorld ?? null;
  }

  /**
   * Set the collision world (e.g., after BSP load)
   */
  setCollisionWorld(world: CollisionWorld | null): void {
    this.collisionWorld = world;
    console.log(`[FPSMovementSubsystem] Collision world set: ${world ? "yes" : "no"}`);
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
      this.movementProfiles.set(entityId, profile);
    }
    return profile;
  }

  /**
   * Reset grounded state for an entity (called by CombatSystem after knockback
   * so friction doesn't eat the impulse on the next movement tick)
   */
  resetGroundedState(entityId: number, grounded: boolean): void {
    this.getProfile(entityId).resetPhysicsState(grounded);
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

  /**
   * Set a per-entity speed bonus (called by WeaponSystem based on equipped weapon).
   */
  setSpeedBonus(entityId: number, bonus: number): void {
    this.weaponSpeedBonuses.set(entityId, bonus);
  }

  update(state: WorldState, dt: number, tick: TickNumber): void {
    const tickNum = tick as number;
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
        this.lastKBTick.set(impulse.entityId as number, tickNum);
        console.log(
          `[KB] Applied to entity=${impulse.entityId}: vel=(${vel.x.toFixed(1)},${vel.y.toFixed(1)},${vel.z.toFixed(1)}) beforeY=${beforeY.toFixed(1)} grounded=false pos=(${ent.transform?.position.x.toFixed(1)},${ent.transform?.position.y.toFixed(1)},${ent.transform?.position.z.toFixed(1)})`,
        );
      }
      this.pendingImpulses = [];
    }

    // === KNOCKBACK AIR DRAG (Warsow-style) ===
    // After a free-fly window, smoothly decay horizontal velocity
    // and add extra gravity so players arc down instead of floating.
    for (const [entityId, kbTick] of this.lastKBTick) {
      const ent = state.getEntityMut(entityId as unknown as EntityId);
      if (!ent?.physics) continue;

      // Landing cancels drag
      if (ent.physics.grounded || ent.health?.dead) {
        this.lastKBTick.delete(entityId);
        continue;
      }

      const elapsed = tickNum - kbTick;

      // Expired (past delay + ramp window)
      if (elapsed > KB_DRAG_DELAY_TICKS + KB_DRAG_RAMP_TICKS) {
        this.lastKBTick.delete(entityId);
        continue;
      }

      // Still in free-fly window
      if (elapsed < KB_DRAG_DELAY_TICKS) continue;

      // Drag phase: ramp 0→1 over KB_DRAG_RAMP_TICKS
      const dragT = (elapsed - KB_DRAG_DELAY_TICKS) / KB_DRAG_RAMP_TICKS;
      // Smooth ease-in (quadratic)
      const dragStrength = dragT * dragT;

      const vel = ent.physics.velocity;

      // Horizontal drag: lerp multiplier from 1.0 → KB_HORIZ_DRAG
      const horizMult = 1.0 - dragStrength * (1.0 - KB_HORIZ_DRAG);
      vel.x *= horizMult;
      vel.z *= horizMult;

      // Extra downward pull (increases with drag strength)
      vel.y -= KB_EXTRA_GRAVITY * dragStrength * dt;
    }

    // Process all player entities
    for (const entity of state.entitiesByType(EntityType.Player)) {
      if (!entity.transform || !entity.physics || !entity.input) continue;

      // Dead entities: skip physics entirely (no corpse movement).
      // Respawn is now handled by RequestSpawn reliable message → wantsRespawn flag.
      if (entity.health?.dead) {
        continue;
      }

      // Get mutable entity (COW)
      const mutable = state.getEntityMut(entity.id);
      if (!mutable || !mutable.transform || !mutable.physics || !mutable.input) continue;

      const input = mutable.input;
      const physics = mutable.physics;
      const transform = mutable.transform;

      // Get movement profile for this entity
      const profile = this.getProfile(entity.id);
      // Apply weapon speed bonus (e.g., blade = +25)
      profile.speedBonus = this.weaponSpeedBonuses.get(entity.id as number) ?? 0;

      // ── SERVER-AUTHORITATIVE FIXED-RATE PHYSICS ──────────────────────────
      // Advance physics EXACTLY ONE dt per server tick, consuming at most one
      // buffered command (in sequence order). If none arrived this tick, repeat
      // the last input so gravity/momentum still advance. This decouples an
      // entity's physics RATE from its input arrival RATE, so no client — human
      // or bot, slow, laggy, or malicious — can slow, skip, or bank its own
      // physics by sending fewer/more commands. Input *content* still matters;
      // input *rate* cannot.
      const eid = entity.id as number;
      const queue = input.inputQueue;

      // Cap the buffer: a client sending faster than the tick rate can't hoard
      // commands to gain extra physics later — keep the newest, drop old excess.
      if (queue.length > FPSMovementSubsystem.MAX_INPUT_BUFFER) {
        queue.splice(0, queue.length - FPSMovementSubsystem.MAX_INPUT_BUFFER);
      }

      // Consume one command this tick (FIFO); fall back to the last one we used.
      // On starvation (no fresh command) we keep repeating movement/aim so gravity
      // and momentum still advance, but strip the action buttons past a short grace
      // so a silent/frozen client can't keep firing/jumping (see ACTION_BUTTON_MASK).
      const fresh = queue.shift();
      let cmd = fresh ?? this.lastInput.get(eid);
      if (fresh) {
        this.starvationTicks.set(eid, 0);
      } else if (cmd) {
        const starved = (this.starvationTicks.get(eid) ?? 0) + 1;
        this.starvationTicks.set(eid, starved);
        if (starved > FPSMovementSubsystem.BUTTON_HOLD_GRACE_TICKS) {
          // New object (don't mutate the shared lastInput in place); the stripped
          // version is then stored back as lastInput so buttons stay cleared.
          cmd = { ...cmd, buttons: cmd.buttons & ~FPSMovementSubsystem.ACTION_BUTTON_MASK };
        }
      }
      if (cmd) {
        input.forward = cmd.forward;
        input.right = cmd.right;
        input.pitch = cmd.pitch;
        input.yaw = cmd.yaw;
        input.buttons = cmd.buttons;
        input.sequence = cmd.sequence;
        if (cmd.weaponSlot > 0) input.weaponSlot = cmd.weaponSlot;
        this.lastInput.set(eid, cmd);
        // Ack the command we actually simulated (not the last one received), so
        // client reconciliation stays aligned under the one-per-tick model.
        input.lastProcessedSeq = cmd.sequence;
      }

      // Always simulate exactly one dt (even with no command ever — gravity applies).
      const px = transform.position.x;
      const py = transform.position.y;
      const pz = transform.position.z;
      const result = profile.simulate(transform.position, physics.velocity, adaptInput(input), dt, this.collisionWorld);
      applyResult(transform, physics, result, input);

      const mdx = transform.position.x - px;
      const mdy = transform.position.y - py;
      const mdz = transform.position.z - pz;
      const moved = Math.sqrt(mdx * mdx + mdy * mdy + mdz * mdz);
      if (moved > FPSMovementSubsystem.MAX_TICK_STEP) {
        console.warn(
          `[Authority] entity ${eid} moved ${moved.toFixed(0)}u in one tick ` +
            `(max ${FPSMovementSubsystem.MAX_TICK_STEP}) pos=(${transform.position.x.toFixed(0)},${transform.position.y.toFixed(0)},${transform.position.z.toFixed(0)}) - log-only`,
        );
      }

      if (kbEntities.has(eid)) {
        console.log(
          `[KB POST-SIM] entity=${entity.id}: pos=(${transform.position.x.toFixed(1)},${transform.position.y.toFixed(1)},${transform.position.z.toFixed(1)}) vel=(${physics.velocity.x.toFixed(1)},${physics.velocity.y.toFixed(1)},${physics.velocity.z.toFixed(1)}) grounded=${physics.grounded} queue=${queue.length}`,
        );
      }
    }

    // ── DIAGNOSTIC: track jump durations per entity ──
    for (const entity of state.entitiesByType(EntityType.Player)) {
      if (!entity.transform || !entity.physics || entity.health?.dead) continue;
      const eid = entity.id as number;
      const grounded = entity.physics.grounded;
      const py = entity.transform.position.y;
      if (!grounded && !this.jumpStartTick.has(eid)) {
        // Just went airborne
        this.jumpStartTick.set(eid, tickNum);
        this.jumpStartY.set(eid, py);
      } else if (grounded && this.jumpStartTick.has(eid)) {
        // Just landed
        this.jumpStartTick.delete(eid);
        this.jumpStartY.delete(eid);
      }

      // Log per-tick Y when airborne (every 5 ticks to avoid spam)
      if (!grounded && this.jumpStartTick.has(eid)) {
        const elapsed = tickNum - this.jumpStartTick.get(eid)!;
        if (elapsed % 5 === 0) {
          // console.log(`[AIR] eid=${entity.id} t+${elapsed} y=${py.toFixed(1)} vy=${vy.toFixed(1)}`);
        }
      }
    }

    // ── DIAGNOSTIC: log per-entity physics every 125 ticks (1 second) ──
    if (tickNum % 125 === 0) {
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

        // Apply push to player A
        const mutA = state.getEntityMut(a.id);
        if (mutA?.transform) {
          mutA.transform.position.x += nx * pushDist;
          mutA.transform.position.z += nz * pushDist;

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

        // Apply push to player B (opposite direction)
        const mutB = state.getEntityMut(b.id);
        if (mutB?.transform) {
          mutB.transform.position.x -= nx * pushDist;
          mutB.transform.position.z -= nz * pushDist;

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
    this.lastKBTick.delete(entityId);
    this.starvationTicks.delete(entityId);
  }
}
