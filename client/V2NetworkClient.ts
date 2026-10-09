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
import { applyKnockbackDrag, readKnockbackAge } from "../simulation/Knockback";
import type { AdvancedMovementResult } from "../simulation/MovementConfig";
import { MovementProfile as FPSMovementProfile } from "../simulation/MovementProfile";
import { devLog } from "./DevLog";
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
  /** Attached to a ladder, predicted locally for the same reason. */
  onLadder: boolean;
  /**
   * A jumppad replaced velocity this step. Held for as long as the player
   * overlaps the pad — consumers must edge-detect (see playJumppadLaunch).
   */
  jumppadLaunch: boolean;
}

export interface ServerSnapshot {
  lifts?: import("../../../shared/bsp/LiftSystem").LiftState[];
  tick: number;
  ackedInputSeq: number;
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  /**
   * Knockback drag age after the tick this snapshot describes, or null when no
   * drag is active. Travels with position and velocity, which already include
   * every impulse through that tick — so replay restores the age and never
   * re-applies an impulse.
   */
  knockbackAgeTicks?: number | null;
}

export interface V2ClientConfig {
  /** Physics tick rate (must match server) */
  tickRate: number;
}

// ═══════════════════════════════════════════════════════════════════
// RECONCILIATION SUPPRESSION BACKSTOPS (N05)
// ═══════════════════════════════════════════════════════════════════
// Suppression exists because a replayed wall jump or ledge grab re-runs its
// traces from the server's position and hits at slightly different sub-tick
// points, so adopting authority every snapshot reads as jitter. It is a
// workaround for replay disagreement, not a fix for it — restoring the full
// movement state is (T01). Until then it needs limits that do not depend on
// the player eventually becoming ineligible.

/**
 * Hard cap on CONTINUOUS suppression. Measured in ms rather than snapshots
 * because the same count means different durations at different snapshot rates
 * (the ten-snapshot window is 160ms at 62.5Hz but about 333ms at 30Hz). Well
 * past the window suppression is meant to cover, so it only fires when
 * eligibility keeps re-arming.
 */
const MAX_SUPPRESSION_MS = 500;

/**
 * Divergence past which a snapshot is a discontinuity, not a trace
 * disagreement, and must be adopted however eligible the player looks.
 * Deliberately far above ordinary prediction lead — a strafe-jumping player on
 * a 300ms link is legitimately a few hundred units ahead of authority — so this
 * catches an unpredicted teleport or an authoritative move the client never
 * simulated, and nothing that suppression is there to smooth.
 */
const MAX_SUPPRESSED_DIVERGENCE = 400;

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
    onLadder: false,
    jumppadLaunch: false,
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

  /** When the current unbroken run of suppressed snapshots began; null if none. */
  private suppressionStartedAtMs: number | null = null;
  private suppressedSnapshots: number = 0;
  private maxSuppressedDivergence: number = 0;
  /** Why the last run of suppression ended — for capture, not for logic. */
  private lastSuppressionRelease: string | null = null;
  /** Times the replay budget was exceeded and prediction restarted from authority. */
  private resyncCount: number = 0;

  /**
   * Knockback drag age after the last simulated step, or null when inactive —
   * the quantity the server publishes. Reconciliation adopts it together with
   * authoritative position and velocity, and every simulated step, fresh or
   * replayed, advances it by exactly one. The client never predicts an impulse:
   * impulses arrive already applied to snapshot velocity.
   */
  private kbAge: number | null = null;
  /** Server snapshot tick of the last adopted impulse, not a local replay clock. */
  private authoritativeKnockbackStartTick: number | null = null;

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
  /**
   * Newest authoritative tick already reconciled against. Selecting the newest
   * of one frame's arrivals is not enough on its own — a stale datagram that
   * arrives a frame later would still rewind prediction (N06). Ticks belong to
   * one connection, and this client is rebuilt per connect, so it never needs
   * clearing; a respawn is not a new session and must not reset it.
   */
  private lastAppliedTick: number | null = null;
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
    this.kbAge = null;
    this.authoritativeKnockbackStartTick = null;
    devLog("[V2Client] Reset to", position);
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
    this.collision?.lifts?.step(this.dt, [this.localState]);
    // KB air drag runs BEFORE movement, reading the grounded state this step
    // starts from — the order the server's tick uses. Running it afterwards
    // fed movement an undragged velocity and judged the landing a step late.
    this.stepKnockback();
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

    // 4. Store predicted movement state for visual effects
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
   * Processes only the NEWEST snapshot (older ones are stale).
   * Returns true if a snapshot was processed (state may have changed).
   */
  processBufferedSnapshots(): boolean {
    if (this.pendingSnapshots.length === 0) return false;

    // Newest by tick, not by arrival: reconciling against an older authoritative
    // state rewinds the predicted position by however far the two ticks are
    // apart (N06). The host filters stale arrivals too; this does not rely on it.
    let newest = this.pendingSnapshots[0];
    for (const snapshot of this.pendingSnapshots) {
      if (snapshot.tick > newest.tick) newest = snapshot;
    }
    this.pendingSnapshots = [];

    return this.applySnapshot(newest);
  }

  /**
   * Apply a server snapshot — Q3-style reconciliation (internal)
   *
   * Per V2_NETWORK_CLIENT.md design:
   * 1. Reset to server's authoritative position
   * 2. Replay all unacknowledged inputs
   * 3. Result is our new predicted position
   */
  private applySnapshot(snapshot: ServerSnapshot): boolean {
    // Reconciling against an older authoritative state rewinds the predicted
    // position by however far the two ticks are apart. Nothing downstream —
    // replay, ACK pruning, lift restore — may run for one.
    if (this.lastAppliedTick !== null && snapshot.tick <= this.lastAppliedTick) return false;
    this.lastAppliedTick = snapshot.tick;

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

    // Movers are world state, not player state. Sync them even when this player's
    // own reconciliation is skipped, or one grab/walljump desyncs every lift on the map.
    if (snapshot.lifts) this.collision?.lifts?.restore(snapshot.lifts);

    // How far prediction has drifted from authority, measured before any
    // correction. This has to be known BEFORE deciding to skip: a skip that
    // returns without looking cannot tell a sub-unit trace disagreement from a
    // teleport (N05). It includes ordinary prediction lead, so it bounds
    // suppression but is not a desync metric on its own.
    const divergence = Math.hypot(
      this.localState.position.x - snapshot.position.x,
      this.localState.position.y - snapshot.position.y,
      this.localState.position.z - snapshot.position.z,
    );

    let releasedBy: string | null = null;
    const authoritativeAge = readKnockbackAge(snapshot.knockbackAgeTicks);
    // Snapshot ticks and published ages advance together, even when input ACKs
    // stall. Their difference identifies the impulse's server timeline. A new
    // impulse or cancellation must not wait behind wall/ledge suppression.
    const knockbackStartTick = authoritativeAge === null ? null : snapshot.tick - authoritativeAge;
    const knockbackChanged = knockbackStartTick !== this.authoritativeKnockbackStartTick;
    let skipReconcile = (this.grabReconcileSkipCount > 0 || this.wallJumpReconcileSkipCount > 0) && !isFirstSnapshot;
    if (skipReconcile) {
      const now = performance.now();
      this.suppressionStartedAtMs ??= now;
      this.maxSuppressedDivergence = Math.max(this.maxSuppressedDivergence, divergence);
      const heldMs = now - this.suppressionStartedAtMs;

      const release = knockbackChanged
        ? "knockback"
        : divergence > MAX_SUPPRESSED_DIVERGENCE
          ? "divergence"
          : heldMs > MAX_SUPPRESSION_MS
            ? "timeout"
            : null;
      if (release) {
        // Take the correction now. Clearing the counters matters as much as the
        // decision: leaving them armed would suppress the very next snapshot
        // again, so the bound would have delayed one correction rather than
        // ending the run. Eligibility that genuinely persists re-arms them
        // below on the next snapshot, which bounds suppression to a duty cycle
        // instead of letting it run forever.
        console.warn(
          `[V2Client] Reconciliation suppression released (${release}): held=${heldMs.toFixed(0)}ms ` +
            `snapshots=${this.suppressedSnapshots} divergence=${divergence.toFixed(1)} ` +
            `grab=${this.predictedMovement.ledgeGrabState} wallJump=${this.predictedMovement.wallJumpState}`,
        );
        releasedBy = release;
        this.grabReconcileSkipCount = 0;
        this.wallJumpReconcileSkipCount = 0;
        skipReconcile = false;
      }
    }

    if (skipReconcile) {
      this.suppressedSnapshots++;
      this.inputHistory.pruneAcked(snapshot.ackedInputSeq);
      if (!inActiveGrab && this.grabReconcileSkipCount > 0) {
        this.grabReconcileSkipCount--;
      }
      if (!inActiveWallJump && this.wallJumpReconcileSkipCount > 0) {
        this.wallJumpReconcileSkipCount--;
      }
      return true;
    }

    // A correction is about to be adopted, so the current run of suppression is
    // over however it ended — by the player becoming ineligible or by a bound.
    if (this.suppressionStartedAtMs !== null) {
      this.lastSuppressionRelease = releasedBy ?? "eligibility-ended";
      this.suppressionStartedAtMs = null;
      this.suppressedSnapshots = 0;
      this.maxSuppressedDivergence = 0;
    }

    // Get inputs we need to replay (those after server's acked sequence)
    const unacked = this.inputHistory.getUnacked(snapshot.ackedInputSeq);

    // Same quantity the suppression bounds were measured against.
    const preError = divergence;

    // === DIAGNOSTIC: Capture pre-reconciliation movement state ===
    const preGrounded = this.localState.grounded;
    const preHSpeed = this.predictedMovement.actualHorizSpeed;

    // === STEP 1: Save pre-reconciliation position for visual smoothing ===
    const preReconcilePos = { ...this.localState.position };

    // === STEP 2: Reset to server state (authoritative) ===
    this.localState.position = { ...snapshot.position };
    this.localState.velocity = { ...snapshot.velocity };
    this.localState.grounded = snapshot.grounded;
    // Drag age is authoritative state from the same tick as the three above;
    // the replay below advances it once per replayed step.
    this.kbAge = authoritativeAge;
    this.authoritativeKnockbackStartTick = knockbackStartTick;

    // CRITICAL: Also reset FPSMovementProfile's internal grounded state!
    // Without this, the movement profile's isGrounded doesn't match the server,
    // causing gravity to be skipped/applied incorrectly during input replay.
    this.movement.resetPhysicsState(snapshot.grounded);

    // === STEP 2: Replay unacked inputs (re-predict from server state) ===
    // DEATH SPIRAL PREVENTION: replaying an unbounded backlog tanks FPS, which
    // accumulates more backlog. The cap is deliberate; what it used to do when
    // it fired was not.
    //
    // It replayed the newest 32 and dropped the rest. Those 32 commands assume
    // the dropped ones already happened, but the replay starts from the server
    // state that precedes ALL of them — so the client resumed from a position
    // its own history never passed through, and its sequence-derived clocks ran
    // ahead of the steps that actually moved it. At the boundary that showed up
    // as free fall gaining 2.624 units of height with authority in perfect
    // agreement (N08).
    //
    // A suffix cannot be made correct here: the intermediate state it needs was
    // never kept. So this is an explicit RESYNCHRONISATION instead — adopt
    // authority, discard the commands that can no longer be honoured, and
    // predict forward from the next one. The player loses the input in that
    // window, which is visible and truthful, rather than being left somewhere
    // neither side simulated.
    const MAX_REPLAY = 32;
    let inputsToReplay = unacked;

    if (unacked.length > MAX_REPLAY) {
      this.resyncCount++;
      inputsToReplay = [];
      // Drop the whole unacked range. Keeping it would replay the same
      // un-honourable commands against every later snapshot.
      this.inputHistory.pruneAcked(unacked[unacked.length - 1].seq);
      console.warn(
        `[V2Client] Resynchronising: ${unacked.length} unacked inputs exceeds the ${MAX_REPLAY} replay budget. ` +
          `Adopting authority at tick ${snapshot.tick} (acked seq ${snapshot.ackedInputSeq}) and discarding them.`,
      );
    }

    for (const input of inputsToReplay) {
      this.collision?.lifts?.step(this.dt, [this.localState]);
      const movementInput = this.storedToMovementInput(input);
      // Same order as fresh prediction and as the server's tick.
      this.stepKnockback();
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
    // KB changes grounded state deliberately. Keeping the old cosmetic flag
    // here would friction-cancel a small authoritative impulse on the next step.
    if (inputsToReplay.length === 0 && preError < 1.0 && authoritativeAge === null && !knockbackChanged) {
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
          devLog(
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
      devLog(
        `[V2Client] RECONCILE #${this.reconcileCount}: unacked=${unacked.length} preErr=${preError.toFixed(2)} postErr=${postError.toFixed(2)} grounded=${this.localState.grounded} hSpeed=${hSpeed.toFixed(1)} ackedSeq=${snapshot.ackedInputSeq} storedInputs=${this.inputHistory.getCount()} collision=${this.collision ? "YES" : "NO"}`,
      );
    }
    return true;
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
    this.suppressionStartedAtMs = null;
    this.suppressedSnapshots = 0;
    this.maxSuppressedDivergence = 0;

    // Force first-snapshot path: bypasses skipReconcile, snaps camera
    this.hasReceivedSnapshot = false;
    this.forceTeleportOnNextSnapshot = true;

    // Zero visual offset
    this.visualOffset.x = 0;
    this.visualOffset.y = 0;
    this.visualOffset.z = 0;

    // Reset KB tracking
    this.kbAge = null;
    this.authoritativeKnockbackStartTick = null;

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
      onLadder: false,
      jumppadLaunch: false,
    };

    devLog("[V2Client] resetForRespawn: cleared all death-period state");
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
        devLog(
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

  getDebugInfo(): {
    reconcileCount: number;
    lastError: number;
    pendingInputs: number;
    suppressedSnapshots: number;
    suppressedForMs: number;
    maxSuppressedDivergence: number;
    lastSuppressionRelease: string | null;
    resyncCount: number;
  } {
    return {
      reconcileCount: this.reconcileCount,
      lastError: this.lastReconcileError,
      pendingInputs: this.inputHistory.getCount(),
      // Correction debt while suppressed: how long, how many snapshots, how far
      // out authority got, and what ended the run (N05 capture list).
      suppressedSnapshots: this.suppressedSnapshots,
      suppressedForMs: this.suppressionStartedAtMs === null ? 0 : performance.now() - this.suppressionStartedAtMs,
      maxSuppressedDivergence: this.maxSuppressedDivergence,
      lastSuppressionRelease: this.lastSuppressionRelease,
      resyncCount: this.resyncCount,
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
   * Advance knockback drag by one simulated step, BEFORE that step's movement.
   * Shared with the server, so identical velocity, grounded state and age give
   * identical drag. A landing or the end of the window ends it; only a snapshot
   * can start one.
   */
  private stepKnockback(): void {
    if (this.kbAge === null) return;
    this.kbAge = applyKnockbackDrag(this.localState.velocity, this.localState.grounded, this.kbAge + 1, this.dt);
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
      sequence: seq,
      // One command is one client step, and a replay re-simulates the same
      // command, so the sequence is also a valid step index here — replays
      // recompute the same slide/walljump/ledge timelines instead of advancing
      // them again. The server counts ticks instead; see MovementInput.simStep.
      simStep: seq,
      isPressed: (btn: number) => (input.buttons & btn) !== 0,
    };
  }

  private storedToMovementInput(stored: StoredInput): MovementInput {
    return {
      direction: stored.direction,
      viewAngles: { pitch: stored.pitch, yaw: stored.yaw },
      buttons: stored.buttons,
      sequence: stored.seq,
      simStep: stored.seq,
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
    this.predictedMovement.onLadder = result.onLadder ?? false;
    this.predictedMovement.jumppadLaunch = result.jumppadLaunch ?? false;
  }
}
