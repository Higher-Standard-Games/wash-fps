/**
 * RemotePlayerRenderer — Renders 3D models + hitbox wireframes for remote entities
 *
 * Each remote player gets:
 * - A `PlayerModelInstance` (vanguard.glb clone) with animation state machine
 * - An optional wireframe hitbox overlay (toggled via `cl_remotehitbox` cvar)
 *
 * Architecture:
 * - pushSnapshot() feeds entity data into SnapshotBuffer (~30Hz from server)
 * - render() samples interpolated positions every frame, positions models,
 *   derives animation state from velocity/grounded/yaw, and plays animations
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { GameState } from '../../../engine/network/core/GameState';
import { SnapshotBuffer, type EntitySnapshot, type InterpolatedEntity } from '../../../engine/network/client/SnapshotBuffer';
import { PlayerModelManager, type PlayerModelInstance } from '../../../engine/animation/PlayerModelManager';
import { Cvar } from '../../../engine/core/Cvar';

// ─── Types ───────────────────────────────────────────────────────

/** Per-entity hitbox wrapper */
interface RemotePlayerHitbox {
    mesh: Mesh;
    smoothedPos: Vector3;
    smoothedYaw: number;
    /** Current hitbox height (56 standing, 36 crouching) */
    currentHeight: number;
    /** 3D model instance (null until model loads) */
    model: PlayerModelInstance | null;
    /** Weapon mesh attached to hand bone (null until weaponId sent over wire) */
    weaponMesh: Mesh | null;
    /** Current weapon ID (for detecting weapon switches) */
    currentWeaponId: number;
}

// ─── Constants (Q3-style player bounds) ──────────────────────────

/** Horizontal collision radius */
const PLAYER_RADIUS = 16;

/** Box extends 24 units below origin (to feet) */
const PLAYER_MINS_Z = -24;

/** Box extends 32 units above origin (to head) */
const PLAYER_MAXS_Z = 32;

/** Total standing height: 56 */
const PLAYER_HEIGHT = PLAYER_MAXS_Z - PLAYER_MINS_Z;

/** Crouched mins Z — box extends 4 units below origin */
const CROUCH_MINS_Z = -4;

/** Total crouched height: 36 */
const CROUCH_HEIGHT = PLAYER_MAXS_Z - CROUCH_MINS_Z;

// ─── Renderer ────────────────────────────────────────────────────

// ─── Model scale (Mixamo → Q3/BSP units) ────────────────────────
const MODEL_SCALE = 36;

// ─── Animation derivation constants ─────────────────────────────
const IDLE_SPEED_THRESHOLD = 50;
const RUN_SPEED_THRESHOLD = 300;
const WALK_NATURAL_SPEED = 50;
const RUN_NATURAL_SPEED = 400;

export class RemotePlayerRenderer {
    private scene: Scene;
    private hitboxes: Map<string, RemotePlayerHitbox> = new Map();
    private snapshotBuffer: SnapshotBuffer = new SnapshotBuffer();
    /** Entities marked dead — value is death timestamp (performance.now) */
    private deadEntities: Map<string, number> = new Map();


    /** Shared model manager — loads vanguard.glb once, creates cloned instances */
    private modelManager: PlayerModelManager | null = null;
    private modelLoading = false;

    constructor(scene: Scene) {
        this.scene = scene;
    }

    // ── Model Loading ────────────────────────────────────────────

    private async ensureModelLoaded(): Promise<void> {
        if (this.modelManager?.isLoaded || this.modelLoading) return;
        this.modelLoading = true;

        this.modelManager = new PlayerModelManager(this.scene);
        try {
            await this.modelManager.loadModel();
            console.log('[RemotePlayerRenderer] Player model loaded');

            // Create model instances for any hitboxes that were created before model loaded
            for (const [entityId, hitbox] of this.hitboxes) {
                if (!hitbox.model) {
                    hitbox.model = this.createModelInstance(entityId);
                }
            }
        } catch (err) {
            console.error('[RemotePlayerRenderer] Failed to load player model:', err);
        } finally {
            this.modelLoading = false;
        }
    }

    private createModelInstance(entityId: string): PlayerModelInstance | null {
        if (!this.modelManager?.isLoaded) return null;
        const instance = this.modelManager.createInstance(entityId, MODEL_SCALE);
        if (instance) {
            // Start with idle animation
            this.modelManager.playAnimation(instance, 'idle');
        }
        return instance;
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

        // Extract entity data into snapshot format
        const entities = new Map<string, EntitySnapshot>();

        for (const [entityId, entity] of state.entities) {
            if (entityId === localEntityId) continue;
            if (!entityId.startsWith('player_')) continue;

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
                crouching: velocity?.isCrouching ?? false,
            });
        }

        this.snapshotBuffer.push(state.tick, entities, serverLocalTime);

        // Clear dead status ONLY when entity reappears in a fresh snapshot
        // (meaning the server has confirmed respawn with valid position data)
        for (const [entityId] of this.deadEntities) {
            if (entities.has(entityId)) {
                this.deadEntities.delete(entityId);
            }
        }
    }

    /**
     * Render all remote entities using interpolated positions.
     * Called every frame from the render loop.
     */
    render(): void {
        // Get all entities from latest snapshot for lifecycle management
        const aliveIds = this.snapshotBuffer.getLatestEntityIds();

        // Sample interpolated state for each alive entity
        for (const entityId of aliveIds) {
            // Skip dead entities — their mesh is hidden until entity leaves snapshot
            if (this.deadEntities.has(entityId)) continue;

            const interp = this.snapshotBuffer.sample(entityId);
            if (!interp) continue;

            let hitbox = this.hitboxes.get(entityId);

            // Create hitbox for new entity
            if (!hitbox) {
                const created = this.createHitbox(entityId, interp);
                if (created) {
                    this.hitboxes.set(entityId, created);
                    hitbox = created;
                    // Trigger async model load on first remote player
                    this.ensureModelLoaded();
                }
            }

            if (!hitbox) continue;

            // Ensure hitbox is visible (may have been hidden during death)
            const showHitbox = Cvar.get('cl_remotehitbox');
            hitbox.mesh.setEnabled(showHitbox !== undefined ? Number(showHitbox) > 0 : true);

            // Check if height changed (crouch/uncrouch) — rebuild hitbox mesh if so
            const targetHeight = interp.crouching ? CROUCH_HEIGHT : PLAYER_HEIGHT;
            if (hitbox.currentHeight !== targetHeight) {
                hitbox.mesh.dispose();
                const newMesh = this.createHitboxMesh(entityId, targetHeight);
                hitbox.mesh = newMesh;
                hitbox.currentHeight = targetHeight;
            }

            // Update position/rotation from interpolated data
            this.updatePosition(hitbox, interp);

            // Update model position + animation
            this.updateModel(hitbox, interp);
        }

        // Remove hitboxes for entities no longer alive
        for (const [entityId, hitbox] of this.hitboxes) {
            if (!aliveIds.has(entityId)) {
                hitbox.mesh.dispose();
                if (hitbox.model && this.modelManager) {
                    this.modelManager.disposeInstance(hitbox.model);
                }
                this.hitboxes.delete(entityId);
                this.deadEntities.delete(entityId);
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

    /** Clean up all hitboxes and models */
    dispose(): void {
        for (const hitbox of this.hitboxes.values()) {
            hitbox.mesh.dispose();
            if (hitbox.model && this.modelManager) {
                this.modelManager.disposeInstance(hitbox.model);
            }
        }
        this.hitboxes.clear();
        this.deadEntities.clear();
        if (this.modelManager) {
            this.modelManager.dispose();
            this.modelManager = null;
        }
    }

    /**
     * Mark an entity as dead — dispose its mesh immediately.
     * Called from FPSGameManager on death events.
     * A fresh hitbox will be created when the entity respawns and reappears in snapshots.
     */
    markDead(entityId: string): void {
        this.deadEntities.set(entityId, performance.now());
        const hitbox = this.hitboxes.get(entityId);
        if (hitbox) {
            hitbox.mesh.dispose();
            if (hitbox.model && this.modelManager) {
                this.modelManager.disposeInstance(hitbox.model);
            }
            this.hitboxes.delete(entityId);
        }
    }

    /**
     * Mark an entity as alive — hitbox will reappear on next render.
     * Called when a respawn/combat_state event clears dead status.
     */
    markAlive(entityId: string): void {
        this.deadEntities.delete(entityId);
    }

    /** Get diagnostics */
    getDiagnostics(): { bufferSize: number; interpDelay: number } {
        return {
            bufferSize: this.snapshotBuffer.getBufferSize(),
            interpDelay: this.snapshotBuffer.getInterpDelay(),
        };
    }

    // ── Hitbox Creation ─────────────────────────────────────────

    private createHitboxMesh(entityId: string, height: number): Mesh {
        const hw = PLAYER_RADIUS;  // 16 (half-width)
        const hh = height / 2;     // half-height
        const hd = PLAYER_RADIUS;  // 16 (half-depth)

        // 8 corners of the box (centered at origin, positioned later)
        const c = [
            new Vector3(-hw, -hh, -hd), // 0: bottom-back-left
            new Vector3(hw, -hh, -hd), // 1: bottom-back-right
            new Vector3(hw, -hh, hd), // 2: bottom-front-right
            new Vector3(-hw, -hh, hd), // 3: bottom-front-left
            new Vector3(-hw, hh, -hd), // 4: top-back-left
            new Vector3(hw, hh, -hd), // 5: top-back-right
            new Vector3(hw, hh, hd), // 6: top-front-right
            new Vector3(-hw, hh, hd), // 7: top-front-left
        ];

        // 12 edges as a continuous line strip
        const points = [
            // Bottom face
            c[0], c[1], c[2], c[3], c[0],
            // Up to top face
            c[4], c[5], c[6], c[7], c[4],
            // Remaining 3 vertical edges
            c[5], c[1], c[2], c[6], c[7], c[3],
        ];

        const mesh = MeshBuilder.CreateLines(`hitbox_${entityId}`, {
            points,
            updatable: false,
        }, this.scene);

        mesh.color = new Color3(0, 1, 0); // Bright green
        mesh.isPickable = false;

        return mesh as unknown as Mesh;
    }

    private createHitbox(entityId: string, initialState: InterpolatedEntity): RemotePlayerHitbox | null {
        const height = initialState.crouching ? CROUCH_HEIGHT : PLAYER_HEIGHT;
        const mesh = this.createHitboxMesh(entityId, height);

        const smoothedPos = new Vector3(
            initialState.x,
            initialState.y,
            initialState.z,
        );

        // Position mesh at correct Y (box center relative to origin)
        this.positionMesh(mesh, smoothedPos, height);

        // Create model instance if manager is loaded
        const model = this.createModelInstance(entityId);

        return {
            mesh,
            smoothedPos,
            smoothedYaw: initialState.yaw,
            currentHeight: height,
            model,
            weaponMesh: null,
            currentWeaponId: -1,
        };
    }

    // ── Position Update ─────────────────────────────────────────

    /**
     * Position the hitbox mesh correctly relative to Q3 origin.
     *
     * Q3 origin is at "waist" level. Box extends:
     * - Standing: -24 to +32 from origin → center at +4 from origin
     * - Crouching: -4 to +32 from origin → center at +14 from origin
     */
    private positionMesh(mesh: Mesh, origin: Vector3, height: number): void {
        const minsZ = height === CROUCH_HEIGHT ? CROUCH_MINS_Z : PLAYER_MINS_Z;
        const centerY = origin.y + (PLAYER_MAXS_Z + minsZ) / 2;
        mesh.position.set(origin.x, centerY, origin.z);
    }

    private updatePosition(hitbox: RemotePlayerHitbox, interp: InterpolatedEntity): void {
        // Direct interpolated position — SnapshotBuffer handles smooth time-based interpolation
        hitbox.smoothedPos.set(interp.x, interp.y, interp.z);

        // Position mesh relative to Q3 origin
        this.positionMesh(hitbox.mesh, hitbox.smoothedPos, hitbox.currentHeight);

        // Rotation from interpolated yaw
        hitbox.smoothedYaw = interp.yaw;
        if (hitbox.mesh.rotationQuaternion) hitbox.mesh.rotationQuaternion = null;
        hitbox.mesh.rotation.set(0, hitbox.smoothedYaw, 0);
    }

    // ── Model Update ─────────────────────────────────────────────

    private updateModel(hitbox: RemotePlayerHitbox, interp: InterpolatedEntity): void {
        const inst = hitbox.model;
        if (!inst || !this.modelManager) return;

        // Position the model anchor at player feet (Q3 origin - 24 = feet level)
        const feetY = interp.y + PLAYER_MINS_Z;
        inst.anchor.position.set(interp.x, feetY, interp.z);

        // Rotation
        if (inst.anchor.rotationQuaternion) inst.anchor.rotationQuaternion = null;
        inst.anchor.rotation.set(0, interp.yaw, 0);
        inst.anchor.setEnabled(true);

        // Reset root motion each frame (position + rotation drift from anims)
        this.modelManager.resetRootMotion(inst);
        inst.mesh.scaling.set(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);
        if (inst.mesh.rotationQuaternion) inst.mesh.rotationQuaternion = null;
        inst.mesh.rotation.set(0, 0, 0);

        // Ensure mesh is visible
        inst.mesh.isVisible = true;
        inst.mesh.getChildMeshes().forEach(m => m.isVisible = true);

        // Derive animation from network data
        const animName = this.deriveAnimation(interp);
        this.modelManager.playAnimation(inst, animName);

        // Scale animation speed to match movement speed
        if (inst.masterGroup) {
            const speed = Math.sqrt(interp.vx * interp.vx + interp.vz * interp.vz);
            if (animName === 'run' || animName === 'walk') {
                const naturalSpeed = animName === 'run' ? RUN_NATURAL_SPEED : WALK_NATURAL_SPEED;

                // Detect backward movement
                const fwdX = Math.sin(interp.yaw);
                const fwdZ = Math.cos(interp.yaw);
                const forwardDot = fwdX * interp.vx + fwdZ * interp.vz;
                const isBackward = forwardDot < 0;

                let speedRatio = speed / naturalSpeed;
                if (isBackward) speedRatio = -speedRatio;
                inst.masterGroup.speedRatio = Math.max(-3.0, Math.min(3.0, speedRatio));
            } else {
                inst.masterGroup.speedRatio = 1.0;
            }
        }
    }

    /**
     * Derive animation name from interpolated network data.
     * Uses velocity, grounded state, and yaw — all available from SnapshotBuffer.
     */
    private deriveAnimation(interp: InterpolatedEntity): string {
        // Airborne
        if (!interp.grounded && interp.vy > 50) return 'jump';

        const speed = Math.sqrt(interp.vx * interp.vx + interp.vz * interp.vz);

        // Idle
        if (speed < IDLE_SPEED_THRESHOLD) return 'idle';

        // Strafe detection
        const fwdX = Math.sin(interp.yaw);
        const fwdZ = Math.cos(interp.yaw);
        const rightX = fwdZ;
        const rightZ = -fwdX;

        const forwardDot = fwdX * interp.vx + fwdZ * interp.vz;
        const rightDot = rightX * interp.vx + rightZ * interp.vz;

        if (Math.abs(rightDot) > Math.abs(forwardDot) * 1.5) {
            return rightDot > 0 ? 'strafe_r' : 'strafe_l';
        }

        // Run vs walk
        return speed > RUN_SPEED_THRESHOLD ? 'run' : 'walk';
    }
}

// ─── Cvar Registration ───────────────────────────────────────────

Cvar.register('cl_remotehitbox', 1, {
    type: 'int',
    min: 0,
    max: 1,
    description: 'Show wireframe hitbox outlines on remote players',
});
