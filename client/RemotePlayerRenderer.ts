/**
 * RemotePlayerRenderer — Renders player models for all non-local entities
 *
 * Uses the shared PlayerModelManager for model loading, animation, and instancing.
 * Each remote entity gets a PlayerModelInstance from the manager.
 *
 * Architecture (V2):
 * - pushSnapshot() is called once per server state update (snapshot rate, ~30Hz)
 *   to feed entity data into the SnapshotBuffer
 * - render() is called every frame to sample interpolated positions via the buffer
 * - This decouples snapshot reception from rendering, giving smooth, framerate-
 *   independent interpolation with velocity-based extrapolation on packet loss
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';
import { PlayerModelManager, type PlayerModelInstance } from '../../../engine/animation/PlayerModelManager';
import type { GameState } from '../../../engine/network/core/GameState';
import { SnapshotBuffer, type EntitySnapshot, type InterpolatedEntity } from '../../../engine/network/client/SnapshotBuffer';

// ─── Types ───────────────────────────────────────────────────────

/** Per-entity wrapper around PlayerModelInstance */
interface RemotePlayerModel {
    instance: PlayerModelInstance;
    smoothedPos: Vector3;
    smoothedYaw: number;
}

// ─── Constants ───────────────────────────────────────────────────

/** Mixamo → BSP unit scale (same as cl_debugplayer_scale default) */
const MODEL_SCALE = 36;

/** Physics origin is 24 units above feet in Q3 */
const PLAYER_MINS_Z = -24;

// ─── Renderer ────────────────────────────────────────────────────

export class RemotePlayerRenderer {
    private manager: PlayerModelManager;
    private models: Map<string, RemotePlayerModel> = new Map();
    private loadingStarted = false;
    private snapshotBuffer: SnapshotBuffer = new SnapshotBuffer();
    private localEntityId: string = '';

    constructor(scene: Scene) {
        this.manager = new PlayerModelManager(scene);
    }

    // ── Public API ───────────────────────────────────────────────

    /**
     * Push a new snapshot into the interpolation buffer.
     * Called once per server state update (~30Hz).
     *
     * @param state Server game state
     * @param localEntityId ID of local player's entity (excluded from rendering)
     * @param serverLocalTime Optional server timestamp converted to local time via ClockSync
     */
    pushSnapshot(state: GameState, localEntityId: string, serverLocalTime?: number): void {
        this.localEntityId = localEntityId;

        // Extract entity data into snapshot format
        const entities = new Map<string, EntitySnapshot>();

        for (const [entityId, entity] of state.entities) {
            if (entityId === localEntityId) continue;

            const transform = entity.getComponent('transform') as any;
            const velocity = entity.getComponent('velocity') as any;

            if (!transform?.position) continue;

            entities.set(entityId, {
                x: transform.position.x,
                y: transform.position.y,
                z: transform.position.z,
                yaw: transform.rotation?.y ?? 0,
                vx: velocity?.linear?.x ?? velocity?.x ?? 0,
                vy: velocity?.linear?.y ?? velocity?.y ?? 0,
                vz: velocity?.linear?.z ?? velocity?.z ?? 0,
                grounded: velocity?.grounded ?? true,
            });
        }

        this.snapshotBuffer.push(state.tick, entities, serverLocalTime);
    }

    /**
     * Render all remote entities using interpolated positions.
     * Called every frame from the render loop.
     */
    render(): void {
        // Start loading on first render (idempotent)
        if (!this.manager.isLoaded && !this.loadingStarted) {
            this.loadingStarted = true;
            this.manager.loadModel();
        }

        // Get all entities from latest snapshot for lifecycle management
        const aliveIds = this.snapshotBuffer.getLatestEntityIds();

        // Sample interpolated state for each alive entity
        for (const entityId of aliveIds) {
            const interp = this.snapshotBuffer.sample(entityId);
            if (!interp) continue;

            let model = this.models.get(entityId);

            // Create model for new entity
            if (!model && this.manager.isLoaded) {
                const created = this.createModel(entityId, interp);
                if (created) {
                    this.models.set(entityId, created);
                    model = created;
                }
            }

            if (!model) continue;

            // Update position/rotation from interpolated data
            this.updatePositionInterpolated(model, interp);
            this.updateAnimationInterpolated(model, interp);
        }

        // Remove models for entities no longer alive
        for (const [entityId, model] of this.models) {
            if (!aliveIds.has(entityId)) {
                this.manager.disposeInstance(model.instance);
                this.models.delete(entityId);
            }
        }
    }

    /**
     * Legacy update method — calls pushSnapshot + render for backward compat.
     * NOTE: Prefer using pushSnapshot() + render() separately for proper
     * decoupled interpolation. This method is only kept for smooth migration.
     */
    update(state: GameState, localEntityId: string): void {
        this.pushSnapshot(state, localEntityId);
        this.render();
    }

    /** Clean up all models */
    dispose(): void {
        for (const model of this.models.values()) {
            this.manager.disposeInstance(model.instance);
        }
        this.models.clear();
        this.manager.dispose();
    }

    /** Get diagnostics */
    getDiagnostics(): { bufferSize: number; interpDelay: number } {
        return {
            bufferSize: this.snapshotBuffer.getBufferSize(),
            interpDelay: this.snapshotBuffer.getInterpDelay(),
        };
    }

    // ── Instance Creation ────────────────────────────────────────

    private createModel(entityId: string, initialState: InterpolatedEntity): RemotePlayerModel | null {
        const instance = this.manager.createInstance(entityId, MODEL_SCALE);
        if (!instance) return null;

        const smoothedPos = new Vector3(
            initialState.x,
            initialState.y + PLAYER_MINS_Z,
            initialState.z,
        );

        instance.anchor.position.copyFrom(smoothedPos);

        // Start idle
        this.manager.playAnimation(instance, 'idle');

        return {
            instance,
            smoothedPos,
            smoothedYaw: initialState.yaw,
        };
    }

    // ── Position & Animation Update (Interpolated) ───────────────

    private updatePositionInterpolated(model: RemotePlayerModel, interp: InterpolatedEntity): void {
        const targetX = interp.x;
        const targetY = interp.y + PLAYER_MINS_Z;
        const targetZ = interp.z;

        // Direct interpolated position — no fixed-factor lerp needed!
        // The SnapshotBuffer already handles smooth time-based interpolation.
        model.smoothedPos.set(targetX, targetY, targetZ);
        model.instance.anchor.position.copyFrom(model.smoothedPos);

        // Zero root-motion bone positions
        this.manager.resetRootMotion(model.instance);

        // Rotation from interpolated yaw (already shortest-path lerped in buffer)
        model.smoothedYaw = interp.yaw;
        if (model.instance.anchor.rotationQuaternion) model.instance.anchor.rotationQuaternion = null;
        model.instance.anchor.rotation.set(0, model.smoothedYaw, 0);
    }

    private updateAnimationInterpolated(model: RemotePlayerModel, interp: InterpolatedEntity): void {
        // Derive animation from interpolated velocity
        let anim = 'idle';

        const speed = Math.sqrt(interp.vx * interp.vx + interp.vz * interp.vz);

        if (!interp.grounded && interp.vy > 50) {
            anim = 'jump';
        } else if (speed > 300) {
            anim = 'run';
        } else if (speed > 50) {
            anim = 'walk';
        }

        this.manager.playAnimation(model.instance, anim);

        // Scale anim speed based on velocity
        if (model.instance.masterGroup) {
            if (model.instance.currentAnim === 'run') {
                model.instance.masterGroup.speedRatio = Math.max(0.5, Math.min(3, speed / 400));
            } else if (model.instance.currentAnim === 'walk') {
                model.instance.masterGroup.speedRatio = Math.max(0.5, Math.min(3, speed / 50));
            }
        }
    }
}
