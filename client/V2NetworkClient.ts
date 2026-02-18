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

import type { Vec3 } from '../../../engine/network/components/TransformComponent';
import type { CollisionWorld } from '../../../engine/network/systems/collision/CollisionWorld';
import type { MovementInput } from '../../../engine/network/systems/movement/MovementProfile';
import { FPSMovementProfile, type AdvancedMovementResult } from '../simulation/FPSMovementProfile';
import { InputHistory, type StoredInput } from './InputHistory';

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
    wallJumpState: 'none' | 'available' | 'charging';
    ledgeGrabState: 'none' | 'grabbing' | 'pulling';
    actualHorizSpeed: number;
    slidePhase: number;
    ledgeGrabPhase: number;
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
        wallJumpState: 'none',
        ledgeGrabState: 'none',
        actualHorizSpeed: 0,
        slidePhase: 0,
        ledgeGrabPhase: 0,
    };

    // Server sync
    private lastAckedSeq: number = 0;
    private serverTick: number = 0;

    // Config
    private config: V2ClientConfig;
    private dt: number; // Fixed timestep

    // Debug stats
    private reconcileCount: number = 0;
    private lastReconcileError: number = 0;

    // Visual smoothing for reconciliation corrections
    // Instead of teleporting on correction, store the error and decay it
    private visualOffset: Vec3 = { x: 0, y: 0, z: 0 };

    // Track if we've received at least one server snapshot
    // Position is (0,0,0) until first snapshot - camera should wait
    private hasReceivedSnapshot: boolean = false;
    /** Buffered snapshots waiting to be processed at frame boundary */
    private pendingSnapshots: ServerSnapshot[] = [];

    constructor(config: V2ClientConfig) {
        this.config = config;
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

        console.log('[V2Client] Initialized with', config.tickRate, 'Hz physics');
    }

    // ═══════════════════════════════════════════════════════════════════
    // SETUP
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Set collision world (after map loads)
     */
    setCollisionWorld(collision: CollisionWorld | null): void {
        this.collision = collision;
        console.log('[V2Client] Collision world set:', collision ? 'yes' : 'no');
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
        this.lastAckedSeq = 0;
        console.log('[V2Client] Reset to', position);
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
    processInput(input: {
        direction: Vec3;
        pitch: number;
        yaw: number;
        buttons: number;
        clientTick: number;
    }): number {
        // 1. Store input for potential replay during reconciliation
        const seq = this.inputHistory.add({
            direction: { ...input.direction },
            pitch: input.pitch,
            yaw: input.yaw,
            buttons: input.buttons,
            clientTick: input.clientTick,
        });

        // 2. Apply locally for instant feedback (same physics as server)
        const movementInput = this.toMovementInput(input);
        const result = this.movement.simulate(
            this.localState.position,
            this.localState.velocity,
            movementInput,
            this.dt,
            this.collision
        );

        // 3. Update local state with prediction result
        this.localState.position = result.position;
        this.localState.velocity = result.velocity;
        this.localState.grounded = result.grounded;

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
            console.log(`[V2Client] FIRST SNAPSHOT RECEIVED: pos=(${snapshot.position.x.toFixed(1)}, ${snapshot.position.y.toFixed(1)}, ${snapshot.position.z.toFixed(1)}), grounded=${snapshot.grounded}`);
            console.log(`[V2Client] RESETTING localState to server position`);
        }

        // Track server tick
        this.serverTick = snapshot.tick;

        // Get inputs we need to replay (those after server's acked sequence)
        const unacked = this.inputHistory.getUnacked(snapshot.ackedInputSeq);

        // Calculate pre-reconciliation error (for debugging)
        const preDx = this.localState.position.x - snapshot.position.x;
        const preDy = this.localState.position.y - snapshot.position.y;
        const preDz = this.localState.position.z - snapshot.position.z;
        const preError = Math.sqrt(preDx * preDx + preDy * preDy + preDz * preDz);

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
        const inputsToReplay = unacked.length > MAX_REPLAY
            ? unacked.slice(-MAX_REPLAY)  // Keep only the most recent inputs
            : unacked;

        if (unacked.length > MAX_REPLAY) {
            console.warn(`[V2Client] Too many unacked inputs (${unacked.length}), replaying only last ${MAX_REPLAY} to prevent death spiral`);
        }

        for (const input of inputsToReplay) {
            const movementInput = this.storedToMovementInput(input);
            const result = this.movement.simulate(
                this.localState.position,
                this.localState.velocity,
                movementInput,
                this.dt,
                this.collision
            );

            this.localState.position = result.position;
            this.localState.velocity = result.velocity;
            this.localState.grounded = result.grounded;

            // Update predicted movement state from final replay result
            this.updatePredictedMovement(result);
        }

        // === STEP 4: Prune acknowledged inputs ===
        this.inputHistory.pruneAcked(snapshot.ackedInputSeq);
        this.lastAckedSeq = snapshot.ackedInputSeq;

        // === STEP 5: Compute visual offset for smoothing ===
        // The difference between where we were visually and where we are now
        // after reconciliation. This gets decayed over time for smooth camera.
        if (!isFirstSnapshot) {
            this.visualOffset.x += preReconcilePos.x - this.localState.position.x;
            this.visualOffset.y += preReconcilePos.y - this.localState.position.y;
            this.visualOffset.z += preReconcilePos.z - this.localState.position.z;
        }

        // Track reconciliation count and error for diagnostics
        this.reconcileCount++;
        this.lastReconcileError = preError;

        // === DIAGNOSTIC: Log reconciliation stats periodically ===
        if (this.reconcileCount % 250 === 0) {
            const postDx = this.localState.position.x - snapshot.position.x;
            const postDy = this.localState.position.y - snapshot.position.y;
            const postDz = this.localState.position.z - snapshot.position.z;
            const postError = Math.sqrt(postDx * postDx + postDy * postDy + postDz * postDz);
            const hSpeed = Math.sqrt(this.localState.velocity.x * this.localState.velocity.x + this.localState.velocity.z * this.localState.velocity.z);
            console.log(`[V2Client] RECONCILE #${this.reconcileCount}: unacked=${unacked.length} preErr=${preError.toFixed(2)} postErr=${postError.toFixed(2)} grounded=${this.localState.grounded} hSpeed=${hSpeed.toFixed(1)} ackedSeq=${snapshot.ackedInputSeq} storedInputs=${this.inputHistory.getCount()} collision=${this.collision ? 'YES' : 'NO'}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // GETTERS
    // ═══════════════════════════════════════════════════════════════════

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
     * ~83ms to fully decay (factor of 12/sec).
     */
    decayVisualOffset(dt: number): void {
        const factor = Math.min(1.0, dt * 12);
        this.visualOffset.x *= (1 - factor);
        this.visualOffset.y *= (1 - factor);
        this.visualOffset.z *= (1 - factor);
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

    // ═══════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════

    private toMovementInput(input: {
        direction: Vec3;
        pitch: number;
        yaw: number;
        buttons: number;
    }): MovementInput {
        return {
            direction: input.direction,
            viewAngles: { pitch: input.pitch, yaw: input.yaw },
            buttons: input.buttons,
            isPressed: (btn: number) => (input.buttons & btn) !== 0,
        };
    }

    private storedToMovementInput(stored: StoredInput): MovementInput {
        return {
            direction: stored.direction,
            viewAngles: { pitch: stored.pitch, yaw: stored.yaw },
            buttons: stored.buttons,
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
    }
}
