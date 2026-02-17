/**
 * RemotePlayerRenderer — Renders player models for all non-local entities
 *
 * Uses the shared PlayerModelManager for model loading, animation, and instancing.
 * Each remote entity gets a PlayerModelInstance from the manager.
 *
 * Called each server snapshot to sync positions, derive animations from
 * velocity/movementState, and clean up disconnected entities.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';
import { PlayerModelManager, type PlayerModelInstance } from '../../../engine/animation/PlayerModelManager';
import type { GameState } from '../../../engine/network/core/GameState';

// ─── Types ───────────────────────────────────────────────────────

/** Per-entity wrapper around PlayerModelInstance with smoothing state */
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

/** Position interpolation factor (0 = no smoothing, 1 = instant) */
const POS_SMOOTH = 0.35;

/** Yaw interpolation factor */
const YAW_SMOOTH = 0.2;

// ─── Renderer ────────────────────────────────────────────────────

export class RemotePlayerRenderer {
    private manager: PlayerModelManager;
    private models: Map<string, RemotePlayerModel> = new Map();
    private loadingStarted = false;

    constructor(scene: Scene) {
        this.manager = new PlayerModelManager(scene);
    }

    // ── Public API ───────────────────────────────────────────────

    /**
     * Sync all remote entities from server state.
     * Call once per snapshot / frame.
     */
    update(state: GameState, localEntityId: string): void {
        // Start loading on first update (idempotent)
        if (!this.manager.isLoaded && !this.loadingStarted) {
            this.loadingStarted = true;
            this.manager.loadModel();
        }

        // Collect entity IDs that are still alive
        const aliveIds = new Set<string>();

        for (const [entityId, entity] of state.entities) {
            // Skip the local player
            if (entityId === localEntityId) continue;

            aliveIds.add(entityId);

            const transform = entity.getComponent('transform') as any;
            const velocity = entity.getComponent('velocity') as any;
            const movementState = entity.getComponent('movementState') as any;

            if (!transform?.position) continue;

            let model = this.models.get(entityId);

            // Create model for new entity
            if (!model && this.manager.isLoaded) {
                const created = this.createModel(entityId, transform.position);
                if (created) {
                    this.models.set(entityId, created);
                    model = created;
                }
            }

            if (!model) continue;

            // Update position/rotation
            this.updatePosition(model, transform);
            this.updateAnimation(model, velocity, movementState);
        }

        // Remove models for entities no longer in state
        for (const [entityId, model] of this.models) {
            if (!aliveIds.has(entityId)) {
                this.manager.disposeInstance(model.instance);
                this.models.delete(entityId);
            }
        }
    }

    /** Clean up all models */
    dispose(): void {
        for (const model of this.models.values()) {
            this.manager.disposeInstance(model.instance);
        }
        this.models.clear();
        this.manager.dispose();
    }

    // ── Instance Creation ────────────────────────────────────────

    private createModel(entityId: string, initialPos: { x: number; y: number; z: number }): RemotePlayerModel | null {
        const instance = this.manager.createInstance(entityId, MODEL_SCALE);
        if (!instance) return null;

        const smoothedPos = new Vector3(
            initialPos.x,
            initialPos.y + PLAYER_MINS_Z,
            initialPos.z,
        );

        instance.anchor.position.copyFrom(smoothedPos);

        // Start idle
        this.manager.playAnimation(instance, 'idle');

        return {
            instance,
            smoothedPos,
            smoothedYaw: 0,
        };
    }

    // ── Position & Animation Update ──────────────────────────────

    private updatePosition(model: RemotePlayerModel, transform: any): void {
        const targetX = transform.position.x;
        const targetY = transform.position.y + PLAYER_MINS_Z;
        const targetZ = transform.position.z;

        // Smooth interpolation toward server position
        model.smoothedPos.x += (targetX - model.smoothedPos.x) * POS_SMOOTH;
        model.smoothedPos.y += (targetY - model.smoothedPos.y) * POS_SMOOTH;
        model.smoothedPos.z += (targetZ - model.smoothedPos.z) * POS_SMOOTH;

        model.instance.anchor.position.copyFrom(model.smoothedPos);

        // Zero root-motion bone positions
        this.manager.resetRootMotion(model.instance);

        // Rotation from entity yaw
        if (transform.rotation) {
            const targetYaw = transform.rotation.y || 0;
            let yawDelta = targetYaw - model.smoothedYaw;
            while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
            while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
            model.smoothedYaw += yawDelta * YAW_SMOOTH;

            if (model.instance.anchor.rotationQuaternion) model.instance.anchor.rotationQuaternion = null;
            model.instance.anchor.rotation.set(0, model.smoothedYaw, 0);
        }
    }

    private updateAnimation(model: RemotePlayerModel, velocity: any, _movementState: any): void {
        // Derive animation from velocity
        let anim = 'idle';

        if (velocity) {
            const vx = velocity.linear?.x ?? velocity.x ?? 0;
            const vz = velocity.linear?.z ?? velocity.z ?? 0;
            const vy = velocity.linear?.y ?? velocity.y ?? 0;
            const speed = Math.sqrt(vx * vx + vz * vz);
            const grounded = velocity.grounded ?? true;

            if (!grounded && vy > 50) {
                anim = 'jump';
            } else if (speed > 300) {
                anim = 'run';
            } else if (speed > 50) {
                anim = 'walk';
            }
        }

        this.manager.playAnimation(model.instance, anim);

        // Scale anim speed based on velocity
        if (model.instance.masterGroup && velocity) {
            const vx = velocity.linear?.x ?? velocity.x ?? 0;
            const vz = velocity.linear?.z ?? velocity.z ?? 0;
            const speed = Math.sqrt(vx * vx + vz * vz);

            if (model.instance.currentAnim === 'run') {
                model.instance.masterGroup.speedRatio = Math.max(0.5, Math.min(3, speed / 400));
            } else if (model.instance.currentAnim === 'walk') {
                model.instance.masterGroup.speedRatio = Math.max(0.5, Math.min(3, speed / 50));
            }
        }
    }
}
