/**
 * V2NetworkClient - Network client with Q3-style prediction and reconciliation
 *
 * ARCHITECTURE (per V2_NETWORK_CLIENT.md):
 * - V2NetworkClient handles ALL prediction (replaces NetworkGameHost prediction)
 * - Uses FPSMovementProfile for client prediction (same as server)
 * - Stores all inputs in InputHistory
 * - On server snapshot: reset to server state, replay unacked inputs
 * - Guaranteed physics parity with server
 */

import type { Vec3 } from "../../../engine/network/components/TransformComponent";
import type { CollisionWorld } from "../../../engine/network/systems/collision/CollisionWorld";
import type { MovementInput } from "../../../engine/network/systems/movement/MovementProfile";
import type { TriggerVolume } from "../../../shared/bsp/TriggerTable";
import { sanitizeMovementOrZero } from "../../../shared/server/simulation/InputSanitizer";
import type { AdvancedMovementResult } from "../simulation/MovementConfig";
import { MovementProfile as FPSMovementProfile } from "../simulation/MovementProfile";
import { InputHistory, type StoredInput } from "./InputHistory";

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface PlayerState {
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
}

/** Movement state predicted locally (for visual effects) */
export interface PredictedMovementState {
  isSliding: boolean;
  isCrouching: boolean;
  crouchViewOffset: number;
  wallJumpState: "none" | "available" | "charging";
  ledgeGrabState: "none" | "grabbing" | "pulling";
  actualHorizSpeed: number;
  slidePhase: number;
  ledgeGrabPhase: number;
  /**
   * How deep the predicted player is: 0 dry, 1 wading, 2 swimming, 3 under.
   *
   * Predicted rather than taken from the snapshot, so the local splash lands
   * on the frame the player feels the water instead of a round trip later.
   */
  waterLevel: 0 | 1 | 2 | 3;
}

export interface ServerSnapshot {
  tick: number;
  ackedInputSeq: number;
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
}

export interface V2ClientConfig {
  /** Physics tick rate (must match server) */
  tickRate: number;
}

// ═══════════════════════════════════════════════════════════════════
// KNOCKBACK AIR DRAG CONSTANTS (must match FPSMovementSubsystem)
// ═══════════════════════════════════════════════════════════════════

/** Ticks after KB before drag kicks in (~0.4s at 125Hz) */
const KB_DRAG_DELAY_TICKS = 50;
/** Duration over which drag ramps from 0→max (~0.6s at 125Hz) */
const KB_DRAG_RAMP_TICKS = 75;
/** Max per-tick horizontal speed multiplier during full drag */
const KB_HORIZ_DRAG = 0.96;
/** Extra downward acceleration during drag phase (units/s²) */
const KB_EXTRA_GRAVITY = 600;

// ═══════════════════════════════════════════════════════════════════
// V2 NETWORK CLIENT
// ═══════════════════════════════════════════════════════════════════

export class V2NetworkClient {
  // Physics (same as server)
  private movement: FPSMovementProfile;
  private collision: CollisionWorld | null = null;

  // Input tracking
  private inputHistory: InputHistory;

  // Local predicted state
  private localState: PlayerState;

  // Predicted movement state for visual effects (from latest simulate())
  private predictedMovement: PredictedMovementState = {
    isSliding: false,
    isCrouching: false,
    crouchViewOffset: 0,
    wallJumpState: "none",
    ledgeGrabState: "none",
    actualHorizSpeed: 0,
    slidePhase: 0,
    ledgeGrabPhase: 0,
    waterLevel: 0,
  };

  // Server sync

  // Config

  private dt: number; // Fixed timestep

  // Debug stats
  private reconcileCount: number = 0;
  private lastReconcileError: number = 0;
  private _diagOffsetLogTimer: number = 0;

  // Visual smoothing for reconciliation corrections
  // Instead of teleporting on correction, store the error and decay it
  private visualOffset: Vec3 = { x: 0, y: 0, z: 0 };

  // Knockback air drag tracking (matches server FPSMovementSubsystem)
  // Tracks how many ticks since last KB to apply drag at the right time
  private kbTickCounter: number = -1; // -1 = no active KB

  // Cooldown counter for post-grab reconciliation skip.
  // Set to N when grab is active, decrements each reconciliation cycle after grab ends.
  // Reconciliation stays skipped until counter reaches 0, giving server and client
  // time to converge in normal movement before corrections resume.
  private grabReconcileSkipCount: number = 0;

  // Same pattern for walljumps — WallJump state machine replay diverges because
  // wall traces hit at slightly different sub-tick positions after server reset.
  private wallJumpReconcileSkipCount: number = 0;

  // Track if we've received at least one server snapshot
  // Position is (0,0,0) until first snapshot - camera should wait
  private hasReceivedSnapshot: boolean = false;
  /** Buffered snapshots waiting to be processed at frame boundary */
  private pendingSnapshots: ServerSnapshot[] = [];
  /** When true, next snapshot will snap position instantly (respawn, teleport) */
  private forceTeleportOnNextSnapshot: boolean = false;
  /** Fired when a FRESH predicted input teleports the local player (camera yaw + VFX). */
  private onTeleportCallback: ((exitYaw: number, from: Vec3, to: Vec3, entryYaw: number) => void) | null = null;

  constructor(config: V2ClientConfig) {
    this.dt = 1 / config.tickRate;

    // Same movement profile as server (CRITICAL for parity)
    this.movement = new FPSMovementProfile();
    this.inputHistory = new InputHistory();

    // Initial state
    this.localState = {
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      grounded: false,
    };

    console.log("[V2Client] Initialized with", config.tickRate, "Hz physics");
  }

  // ═══════════════════════════════════════════════════════════════════
  // SETUP
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Set collision world (after map loads)
   */
  setCollisionWorld(collision: CollisionWorld | null): void {
    this.collision = collision;
    console.log("[V2Client] Collision world set:", collision ? "yes" : "no");
  }

  /**
   * Install the map's trigger volumes (teleporters/jumppads) into the
   * prediction profile — MUST match what the server installs (same shared
   * TriggerTable extraction) or prediction diverges on every pad/teleporter.
   */
  setTriggerVolumes(volumes: TriggerVolume[]): void {
    this.movement.setTriggerVolumes(volumes);
    console.log(`[V2Client] ${volumes.length} trigger volumes set`);
  }

  /**
   * Called when a FRESH predicted input teleports the local player (not
   * reconciliation replays — those recompute past steps and must not touch
   * the camera). The game rotates the view to the teleporter's exit yaw and
   * plays the entry/exit VFX.
   */
  onTeleport(callback: (exitYaw: number, from: Vec3, to: Vec3, entryYaw: number) => void): void {
    this.onTeleportCallback = callback;
  }

  /**
   * Reset state (on spawn/respawn)
   */
  reset(position: Vec3): void {
    this.localState = {
      position: { ...position },
      velocity: { x: 0, y: 0, z: 0 },
      grounded: false,
    };
    this.inputHistory.clear();
    console.log("[V2Client] Reset to", position);
  }

  // ═══════════════════════════════════════════════════════════════════
  // INPUT HANDLING
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Process local input - instant prediction + store for replay
   *
   * Per V2_NETWORK_CLIENT.md design:
   * 1. Store input in history with sequence number
   * 2. Apply locally via physics.simulate() for instant feedback
   * 3. Return sequence number (caller sends to server)
   *
   * @returns The sequence number assigned to this input (send to server)
   */
  processInput(input: { direction: Vec3; pitch: number; yaw: number; buttons: number; clientTick: number }): number {
    // Apply the SAME clamp the server applies on ingest, so predicted and
    // server-simulated states never diverge (steep pitch / oversized wish dir).
    const clean = sanitizeMovementOrZero(input);
    const sanitizedInput = { ...clean, clientTick: input.clientTick };

    // 1. Store input for potential replay during reconciliation
    const seq = this.inputHistory.add({
      direction: { ...sanitizedInput.direction },
      pitch: sanitizedInput.pitch,
      yaw: sanitizedInput.yaw,
      buttons: sanitizedInput.buttons,
      clientTick: sanitizedInput.clientTick,
    });

    // 2. Apply locally for instant feedback (same physics as server)
    const movementInput = this.toMovementInput(sanitizedInput, seq);
    const result = this.movement.simulate(
      this.localState.position,
      this.localState.velocity,
      movementInput,
      this.dt,
      this.collision,
    );

    // 3. Update local state with prediction result
    this.localState.position = result.position;
    this.localState.velocity = result.velocity;
    this.localState.grounded = result.grounded;

    // Fresh prediction teleported → rotate the local camera to the exit yaw
    // + play VFX. Only here, never in the reconciliation replay loop (replays
    // recompute past steps; re-firing there would fight the mouse and
    // double-spawn effects).
    if (result.teleported && this.onTeleportCallback) {
      this.onTeleportCallback(
        result.teleportYaw ?? 0,
        result.teleportFrom ?? this.localState.position,
        result.position,
        sanitizedInput.yaw, // view yaw at entry — the self-afterimage faces the way you walked in
      );
    }

    // 4. Apply KB air drag (matches server FPSMovementSubsystem)
    this.applyKBDrag(this.localState.velocity, this.localState.grounded);

    // 5. Store predicted movement state for visual effects
    this.updatePredictedMovement(result);

    return seq;
  }

  // ═══════════════════════════════════════════════════════════════════
  // SERVER RECONCILIATION
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Buffer a server snapshot for processing at next frame boundary.
   * Called from NetworkGameHost callback (async, any time).
   */
  bufferSnapshot(snapshot: ServerSnapshot): void {
    this.pendingSnapshots.push(snapshot);
  }

  /**
   * Process all buffered snapshots. Called once per frame BEFORE input processing.
   * Processes only the LATEST snapshot (older ones are stale).
   * Returns true if a snapshot was processed (state may have changed).
   */
  processBufferedSnapshots(): boolean {
    if (this.pendingSnapshots.length === 0) return false;

    // Process only the LATEST snapshot — older ones are stale
    const latest = this.pendingSnapshots[this.pendingSnapshots.length - 1];
    this.pendingSnapshots = [];

    this.applySnapshot(latest);
    return true;
  }

  /**
   * Apply a server snapshot — Q3-style reconciliation (internal)
   *
   * Per V2_NETWORK_CLIENT.md design:
   * 1. Reset to server's authoritative position
   * 2. Replay all unacknowledged inputs
   * 3. Result is our new predicted position
   */
  private applySnapshot(snapshot: ServerSnapshot): void {
    // Track that we've received at least one snapshot
    // This is crucial - position is (0,0,0) until first snapshot
    const isFirstSnapshot = !this.hasReceivedSnapshot;
    this.hasReceivedSnapshot = true;

    if (isFirstSnapshot) {
      console.log(
        `[V2Client] FIRST SNAPSHOT RECEIVED: pos=(${snapshot.position.x.toFixed(1)}, ${snapshot.position.y.toFixed(1)}, ${snapshot.position.z.toFixed(1)}), grounded=${snapshot.grounded}`,
      );
      console.log(`[V2Client] RESETTING localState to server position`);
    }

    // Track server tick

    // === LEDGE GRAB: Skip reconciliation while grab is active + cooldown ===
    // Both server and client simulate ledge grabs (same MovementProfile), but
    // sub-tick timing differences cause position divergence during the grab.
    // Skip reconciliation during the grab AND for ~10 cycles after (~0.33s at
    // 30Hz), giving both sides time to converge in normal movement.
    const inActiveGrab = this.predictedMovement.ledgeGrabState !== "none";
    if (inActiveGrab) {
      this.grabReconcileSkipCount = 10; // Reset counter while grab is active
    }

    // === WALLJUMP: Same skip pattern ===
    // WallJump state machine runs wall traces during input replay. After server
    // reset, traces hit at slightly different sub-tick positions, causing the
    // replayed walljump to produce different velocity/position than the server.
    // Each walljump compounds the error. Skip reconciliation during + after.
    const inActiveWallJump = this.predictedMovement.wallJumpState !== "none";
    if (inActiveWallJump) {
      this.wallJumpReconcileSkipCount = 10;
    }

    const skipReconcile = (this.grabReconcileSkipCount > 0 || this.wallJumpReconcileSkipCount > 0) && !isFirstSnapshot;
    if (skipReconcile) {
      this.inputHistory.pruneAcked(snapshot.ackedInputSeq);
      if (!inActiveGrab && this.grabReconcileSkipCount > 0) {
        this.grabReconcileSkipCount--;
      }
      if (!inActiveWallJump && this.wallJumpReconcileSkipCount > 0) {
        this.wallJumpReconcileSkipCount--;
      }
      return;
    }

    // Get inputs we need to replay (those after server's acked sequence)
    const unacked = this.inputHistory.getUnacked(snapshot.ackedInputSeq);

    // Calculate pre-reconciliation error (for debugging)
    const preDx = this.localState.position.x - snapshot.position.x;
    const preDy = this.localState.position.y - snapshot.position.y;
    const preDz = this.localState.position.z - snapshot.position.z;
    const preError = Math.sqrt(preDx * preDx + preDy * preDy + preDz * preDz);

    // === DIAGNOSTIC: Capture pre-reconciliation movement state ===
    const preGrounded = this.localState.grounded;
    const preHSpeed = this.predictedMovement.actualHorizSpeed;

    // === STEP 1: Save pre-reconciliation position for visual smoothing ===
    const preReconcilePos = { ...this.localState.position };

    // === STEP 2: Reset to server state (authoritative) ===
    this.localState.position = { ...snapshot.position };
    this.localState.velocity = { ...snapshot.velocity };
    this.localState.grounded = snapshot.grounded;

    // CRITICAL: Also reset FPSMovementProfile's internal grounded state!
    // Without this, the movement profile's isGrounded doesn't match the server,
    // causing gravity to be skipped/applied incorrectly during input replay.
    this.movement.resetPhysicsState(snapshot.grounded);

    // === STEP 2: Replay unacked inputs (re-predict from server state) ===
    // DEATH SPIRAL PREVENTION: If too many unacked inputs accumulated,
    // replaying all of them tanks FPS, causing MORE inputs to accumulate.
    // Cap at 32 replays — if further behind, just accept server position.
    const MAX_REPLAY = 32;
    const inputsToReplay =
      unacked.length > MAX_REPLAY
        ? unacked.slice(-MAX_REPLAY) // Keep only the most recent inputs
        : unacked;

    if (unacked.length > MAX_REPLAY) {
      console.warn(
        `[V2Client] Too many unacked inputs (${unacked.length}), replaying only last ${MAX_REPLAY} to prevent death spiral`,
      );
    }

    for (const input of inputsToReplay) {
      const movementInput = this.storedToMovementInput(input);
      const result = this.movement.simulate(
        this.localState.position,
        this.localState.velocity,
        movementInput,
        this.dt,
        this.collision,
      );

      this.localState.position = result.position;
      this.localState.velocity = result.velocity;
      this.localState.grounded = result.grounded;

      // Apply KB air drag during replay (matches server)
      this.applyKBDrag(this.localState.velocity, this.localState.grounded);

      // Update predicted movement state from final replay result
      this.updatePredictedMovement(result);
    }

    // === FIX: Preserve client grounded state when no inputs were replayed ===
    // When unacked=0, reconciliation adopts the server's grounded state directly.
    // But the server snapshot can report grounded=false even when the player is
    // clearly on the ground (standing still, velY=0). This causes WalkBobEffect
    // to decay bobCycle on every snapshot frame → animation restarts.
    // The client's 125Hz simulation is more accurate for this cosmetic state
    // than the server's 60Hz snapshots, so trust the client when there's
    // nothing to replay and the position divergence is small.
    if (inputsToReplay.length === 0 && preError < 1.0) {
      this.localState.grounded = preGrounded;
      this.movement.resetPhysicsState(preGrounded);
    }

    // === STEP 4: Prune acknowledged inputs ===
    this.inputHistory.pruneAcked(snapshot.ackedInputSeq);

    // === STEP 5: Compute visual offset for smoothing ===
    // Maintain visual position continuity: camera stays where it was,
    // then decays toward the new physics position.
    if (!isFirstSnapshot) {
      // Where camera was visually BEFORE reconciliation
      const preVisualX = preReconcilePos.x + this.visualOffset.x;
      const preVisualY = preReconcilePos.y + this.visualOffset.y;
      const preVisualZ = preReconcilePos.z + this.visualOffset.z;

      // New physics position after reconciliation
      const postX = this.localState.position.x;
      const postY = this.localState.position.y;
      const postZ = this.localState.position.z;

      // Correction magnitude for snap threshold
      const corrX = preVisualX - postX;
      const corrY = preVisualY - postY;
      const corrZ = preVisualZ - postZ;
      const corrMag = Math.sqrt(corrX * corrX + corrY * corrY + corrZ * corrZ);

      // Large correction = KB, teleport, or respawn → SNAP camera immediately.
      const SNAP_THRESHOLD = 50;
      const inLedgeGrab = this.predictedMovement.ledgeGrabState !== "none";
      if (corrMag > SNAP_THRESHOLD || inLedgeGrab || this.forceTeleportOnNextSnapshot) {
        // Snap: reset offset to zero — camera jumps to new position instantly
        this.visualOffset.x = 0;
        this.visualOffset.y = 0;
        this.visualOffset.z = 0;
        if (this.forceTeleportOnNextSnapshot) {
          console.log(
            `[V2Client] Force teleport on snapshot: snapping to (${postX.toFixed(1)}, ${postY.toFixed(1)}, ${postZ.toFixed(1)})`,
          );
          this.forceTeleportOnNextSnapshot = false;
        }
      } else {
        // SET offset to maintain visual position continuity
        this.visualOffset.x = corrX;
        this.visualOffset.z = corrZ;

        // Suppress Y correction during crouch slides
        if (!this.predictedMovement.isSliding) {
          this.visualOffset.y = corrY;
        }

        // HARD CAP: prevent unbounded drift from systematic simulation bias
        // (server float64 vs client float32 start positions diverge slightly
        // each cycle, and the bias accumulates faster than decay can drain it)
        const MAX_OFFSET = 5;
        this.visualOffset.x = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, this.visualOffset.x));
        this.visualOffset.y = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, this.visualOffset.y));
        this.visualOffset.z = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, this.visualOffset.z));
      }
    }

    // Track reconciliation count and error for diagnostics
    this.reconcileCount++;
    this.lastReconcileError = preError;

    // === PERIODIC DIAGNOSTIC (every ~4 seconds) ===
    // Grounded-flip and speed-change warnings moved here to prevent console spam
    // during crouchslide (previously fired every reconciliation → 30-60Hz log storm)
    if (this.reconcileCount % 250 === 0) {
      const postGrounded = this.localState.grounded;
      const postHSpeed = this.predictedMovement.actualHorizSpeed;
      if (preGrounded !== postGrounded) {
        console.warn(
          `[V2Client] RECONCILE GROUNDED FLIP: ${preGrounded} → ${postGrounded} (unacked=${unacked.length} preErr=${preError.toFixed(2)} posY=${this.localState.position.y.toFixed(3)} velY=${this.localState.velocity.y.toFixed(1)})`,
        );
      }
      if (preHSpeed > 10 && Math.abs(postHSpeed - preHSpeed) / preHSpeed > 0.2) {
        console.warn(
          `[V2Client] RECONCILE SPEED CHANGE: ${preHSpeed.toFixed(1)} → ${postHSpeed.toFixed(1)} (delta=${(postHSpeed - preHSpeed).toFixed(1)}, unacked=${unacked.length})`,
        );
      }
      const postDx = this.localState.position.x - snapshot.position.x;
      const postDy = this.localState.position.y - snapshot.position.y;
      const postDz = this.localState.position.z - snapshot.position.z;
      const postError = Math.sqrt(postDx * postDx + postDy * postDy + postDz * postDz);
      const hSpeed = Math.sqrt(
        this.localState.velocity.x * this.localState.velocity.x +
          this.localState.velocity.z * this.localState.velocity.z,
      );
      console.log(
        `[V2Client] RECONCILE #${this.reconcileCount}: unacked=${unacked.length} preErr=${preError.toFixed(2)} postErr=${postError.toFixed(2)} grounded=${this.localState.grounded} hSpeed=${hSpeed.toFixed(1)} ackedSeq=${snapshot.ackedInputSeq} storedInputs=${this.inputHistory.getCount()} collision=${this.collision ? "YES" : "NO"}`,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // GETTERS
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Signal that the next server snapshot should snap the camera instantly
   * (zero visual offset). Used on respawn to avoid ghost spawn at death location.
   */
  forceTeleport(): void {
    this.forceTeleportOnNextSnapshot = true;
    // Also clear visual offset immediately so we don't render at stale position
    this.visualOffset.x = 0;
    this.visualOffset.y = 0;
    this.visualOffset.z = 0;
  }

  /**
   * Full reset for respawn — clears ALL stale state from the death period.
   *
   * During death the server omits the player entity from snapshots, so
   * V2NetworkClient receives ZERO snapshots for 3-6 seconds. This causes:
   * - inputHistory to accumulate hundreds of unacked entries
   * - skipReconcile counters to freeze (never decremented)
   * - localState.position to stay at death location
   *
   * This method nukes everything so the first post-respawn snapshot
   * is treated like a fresh spawn (first-snapshot path in applySnapshot).
   */
  resetForRespawn(): void {
    // Clear stale inputs from death period
    this.inputHistory.clear();

    // Reset skip counters (may have frozen during death)
    this.grabReconcileSkipCount = 0;
    this.wallJumpReconcileSkipCount = 0;

    // Force first-snapshot path: bypasses skipReconcile, snaps camera
    this.hasReceivedSnapshot = false;
    this.forceTeleportOnNextSnapshot = true;

    // Zero visual offset
    this.visualOffset.x = 0;
    this.visualOffset.y = 0;
    this.visualOffset.z = 0;

    // Reset KB tracking
    this.kbTickCounter = -1;

    // Reset predicted movement state
    this.predictedMovement = {
      isSliding: false,
      isCrouching: false,
      crouchViewOffset: 0,
      wallJumpState: "none",
      ledgeGrabState: "none",
      actualHorizSpeed: 0,
      slidePhase: 0,
      ledgeGrabPhase: 0,
      waterLevel: 0,
    };

    console.log("[V2Client] resetForRespawn: cleared all death-period state");
  }

  getPosition(): Vec3 {
    return { ...this.localState.position };
  }

  /**
   * Get visually smoothed position for camera rendering.
   * This is the logical position + a decaying visual offset that
   * absorbs reconciliation corrections to prevent jitter.
   */
  getVisualPosition(): Vec3 {
    return {
      x: this.localState.position.x + this.visualOffset.x,
      y: this.localState.position.y + this.visualOffset.y,
      z: this.localState.position.z + this.visualOffset.z,
    };
  }

  /**
   * Decay the visual smoothing offset toward zero.
   * Call once per frame with frame delta time.
   * Uses fast decay (dt*20 ≈ 50ms) so offset settles before next snapshot.
   * Snaps to zero when below threshold to prevent endless micro-drift.
   */
  decayVisualOffset(dt: number): void {
    const factor = Math.min(1.0, dt * 20);
    this.visualOffset.x *= 1 - factor;
    this.visualOffset.y *= 1 - factor;
    this.visualOffset.z *= 1 - factor;

    // Snap to zero when offset is sub-perceptual (prevents endless asymptotic decay)
    const mag = Math.abs(this.visualOffset.x) + Math.abs(this.visualOffset.y) + Math.abs(this.visualOffset.z);
    if (mag < 0.05) {
      this.visualOffset.x = 0;
      this.visualOffset.y = 0;
      this.visualOffset.z = 0;
    }

    // Periodic diagnostic: log visual offset magnitude
    this._diagOffsetLogTimer += dt;
    if (this._diagOffsetLogTimer >= 2.0) {
      this._diagOffsetLogTimer = 0;
      if (mag > 0.001) {
        console.log(
          `[V2Client] visualOffset: (${this.visualOffset.x.toFixed(4)}, ${this.visualOffset.y.toFixed(4)}, ${this.visualOffset.z.toFixed(4)}) mag=${mag.toFixed(4)}`,
        );
      }
    }
  }

  getVelocity(): Vec3 {
    return { ...this.localState.velocity };
  }

  isGrounded(): boolean {
    return this.localState.grounded;
  }

  getState(): PlayerState {
    return {
      position: { ...this.localState.position },
      velocity: { ...this.localState.velocity },
      grounded: this.localState.grounded,
    };
  }

  /**
   * Check if client has received at least one server snapshot
   * Position is (0,0,0) until first snapshot - camera should wait for valid position
   */
  hasValidPosition(): boolean {
    return this.hasReceivedSnapshot;
  }

  /**
   * Get predicted movement state for visual effects (crouchslide, walljump, etc.)
   * These come from the client's local simulation, not from the server wire protocol.
   */
  getMovementState(): PredictedMovementState {
    return this.predictedMovement;
  }

  getDebugInfo(): { reconcileCount: number; lastError: number; pendingInputs: number } {
    return {
      reconcileCount: this.reconcileCount,
      lastError: this.lastReconcileError,
      pendingInputs: this.inputHistory.getCount(),
    };
  }

  /**
   * Set weapon speed bonus on the client-side movement profile.
   * Must match server's per-entity speed bonus for prediction parity.
   */
  setSpeedBonus(bonus: number): void {
    this.movement.speedBonus = bonus;
  }

  /**
   * Apply knockback impulse to local predicted state (client-side prediction).
   * Called when client detects self-damage — provides immediate KB feedback
   * without waiting for server snapshot confirmation.
   *
   * Uses same formula as server CombatSystem.processDamage():
   * 1. Stun: strip horizontal speed proportional to damage
   * 2. KB: push in direction with upward bias
   *
   * @param damage - Final damage amount
   * @param dir - Knockback direction (from explosion/shot to victim)
   * @param kbScale - Weapon's knockback scale
   * @param isSelf - Whether this is self-inflicted damage
   */
  applyKnockback(damage: number, dir: { x: number; y: number; z: number }, kbScale: number, isSelf: boolean): void {
    const vel = this.localState.velocity;

    // 1. STUN — strip horizontal speed (same as server)
    const stunFraction = Math.min(damage / 100, 0.8);
    vel.x *= 1 - stunFraction;
    vel.z *= 1 - stunFraction;

    // 2. KNOCKBACK — direction with upward bias
    const kbDir = { x: dir.x, y: Math.max(dir.y, 0.4), z: dir.z };
    const len = Math.sqrt(kbDir.x * kbDir.x + kbDir.y * kbDir.y + kbDir.z * kbDir.z);
    if (len > 0.001) {
      kbDir.x /= len;
      kbDir.y /= len;
      kbDir.z /= len;
    }

    const selfMult = isSelf ? 1.2 : 1.0;
    const force = damage * kbScale * selfMult;

    vel.x += kbDir.x * force;
    vel.y += kbDir.y * force;
    vel.z += kbDir.z * force;

    // 3. Reset grounded so movement sim doesn't friction-cancel the impulse
    this.localState.grounded = false;
    this.movement.resetPhysicsState(false);

    // 4. Start KB air drag timer
    this.kbTickCounter = 0;
  }

  /**
   * Apply Warsow-style KB air drag (must match server FPSMovementSubsystem).
   * After a free-fly window, smoothly decays horizontal velocity and
   * adds extra gravity so players arc down instead of floating.
   * Called once per tick during both live prediction and reconciliation replay.
   */
  private applyKBDrag(velocity: Vec3, grounded: boolean): void {
    if (this.kbTickCounter < 0) return; // No active KB

    this.kbTickCounter++;

    // Landing or expired → cancel drag
    if (grounded || this.kbTickCounter > KB_DRAG_DELAY_TICKS + KB_DRAG_RAMP_TICKS) {
      this.kbTickCounter = -1;
      return;
    }

    // Still in free-fly window
    if (this.kbTickCounter < KB_DRAG_DELAY_TICKS) return;

    // Drag phase: ramp 0→1 over KB_DRAG_RAMP_TICKS
    const dragT = (this.kbTickCounter - KB_DRAG_DELAY_TICKS) / KB_DRAG_RAMP_TICKS;
    const dragStrength = dragT * dragT; // Quadratic ease-in

    // Horizontal drag
    const horizMult = 1.0 - dragStrength * (1.0 - KB_HORIZ_DRAG);
    velocity.x *= horizMult;
    velocity.z *= horizMult;

    // Extra downward pull
    velocity.y -= KB_EXTRA_GRAVITY * dragStrength * this.dt;
  }

  // ═══════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════

  private toMovementInput(
    input: { direction: Vec3; pitch: number; yaw: number; buttons: number },
    seq: number,
  ): MovementInput {
    return {
      direction: input.direction,
      viewAngles: { pitch: input.pitch, yaw: input.yaw },
      buttons: input.buttons,
      // Sequence drives the profile's sim clock — replays with the same seq
      // recompute the same slide/walljump/ledge timelines (no double-advance)
      sequence: seq,
      isPressed: (btn: number) => (input.buttons & btn) !== 0,
    };
  }

  private storedToMovementInput(stored: StoredInput): MovementInput {
    return {
      direction: stored.direction,
      viewAngles: { pitch: stored.pitch, yaw: stored.yaw },
      buttons: stored.buttons,
      sequence: stored.seq,
      isPressed: (btn: number) => (stored.buttons & btn) !== 0,
    };
  }

  /** Update predicted movement state from simulate() result */
  private updatePredictedMovement(result: AdvancedMovementResult): void {
    this.predictedMovement.isSliding = result.isSliding;
    this.predictedMovement.isCrouching = result.isCrouching;
    this.predictedMovement.crouchViewOffset = result.crouchViewOffset;
    this.predictedMovement.wallJumpState = result.wallJumpState;
    this.predictedMovement.ledgeGrabState = result.ledgeGrabState;
    this.predictedMovement.actualHorizSpeed = result.actualHorizSpeed;
    this.predictedMovement.slidePhase = result.slidePhase;
    this.predictedMovement.ledgeGrabPhase = result.ledgeGrabPhase;
    this.predictedMovement.waterLevel = result.waterLevel ?? 0;
  }
}
