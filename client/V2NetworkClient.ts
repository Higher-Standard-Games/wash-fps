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
import { FPSMovementProfile } from '../simulation/FPSMovementProfile';
import { InputHistory, type StoredInput } from './InputHistory';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface PlayerState {
    position: Vec3;
    velocity: Vec3;
    grounded: boolean;
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

    // Server sync
    private lastAckedSeq: number = 0;
    private serverTick: number = 0;

    // Config
    private config: V2ClientConfig;
    private dt: number; // Fixed timestep

    // Debug stats
    private reconcileCount: number = 0;
    private lastReconcileError: number = 0;

    // Track if we've received at least one server snapshot
    // Position is (0,0,0) until first snapshot - camera should wait
    private hasReceivedSnapshot: boolean = false;

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

        return seq;
    }

    // ═══════════════════════════════════════════════════════════════════
    // SERVER RECONCILIATION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Handle server snapshot - Q3-style reconciliation
     * 
     * Per V2_NETWORK_CLIENT.md design:
     * 1. Reset to server's authoritative position
     * 2. Replay all unacknowledged inputs
     * 3. Result is our new predicted position
     */
    onServerSnapshot(snapshot: ServerSnapshot): void {
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

        // === STEP 1: Reset to server state (authoritative) ===
        this.localState.position = { ...snapshot.position };
        this.localState.velocity = { ...snapshot.velocity };
        this.localState.grounded = snapshot.grounded;

        // CRITICAL: Also reset FPSMovementProfile's internal grounded state!
        // Without this, the movement profile's isGrounded doesn't match the server,
        // causing gravity to be skipped/applied incorrectly during input replay.
        this.movement.resetPhysicsState(snapshot.grounded);

        // === STEP 2: Replay unacked inputs (re-predict from server state) ===
        for (const input of unacked) {
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
        }

        // === STEP 3: Prune acknowledged inputs ===
        this.inputHistory.pruneAcked(snapshot.ackedInputSeq);
        this.lastAckedSeq = snapshot.ackedInputSeq;

        // Track reconciliation count and error for diagnostics
        this.reconcileCount++;
        this.lastReconcileError = preError;
    }

    // ═══════════════════════════════════════════════════════════════════
    // GETTERS
    // ═══════════════════════════════════════════════════════════════════

    getPosition(): Vec3 {
        return { ...this.localState.position };
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
}
