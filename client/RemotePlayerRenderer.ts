/**
 * RemotePlayerRenderer — Renders hitbox boxes for all non-local entities
 *
 * Instead of loading 3D models, draws accurate Q3-style hitboxes (boxes)
 * sized to match the server's collision geometry exactly.
 * Crouch state is transmitted via BinaryProtocol flag 0x10.
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
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { GameState } from '../../../engine/network/core/GameState';
import { SnapshotBuffer, type EntitySnapshot, type InterpolatedEntity } from '../../../engine/network/client/SnapshotBuffer';

// ─── Types ───────────────────────────────────────────────────────

/** Per-entity hitbox wrapper */
interface RemotePlayerHitbox {
    mesh: Mesh;
    smoothedPos: Vector3;
    smoothedYaw: number;
    /** Current hitbox height (56 standing, 36 crouching) */
    currentHeight: number;
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

export class RemotePlayerRenderer {
    private scene: Scene;
    private hitboxes: Map<string, RemotePlayerHitbox> = new Map();
    private snapshotBuffer: SnapshotBuffer = new SnapshotBuffer();
    /** Entities marked dead — value is death timestamp (performance.now) */
    private deadEntities: Map<string, number> = new Map();
    /** Diagnostic frame counter */
    private _diagCount = 0;

    constructor(scene: Scene) {
        this.scene = scene;
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

        // Diagnostic: log entity IDs periodically
        this._diagCount++;
        if (this._diagCount % 300 === 1) {
            const allIds = [...state.entities.keys()];
            const playerIds = allIds.filter(id => id.startsWith('player_'));
            const nonLocalPlayers = playerIds.filter(id => id !== localEntityId);
            console.log(`[RemotePlayerRenderer] pushSnapshot #${this._diagCount}: total=${allIds.length}, players=${playerIds.length}, remotes=${nonLocalPlayers.length}, hitboxes=${this.hitboxes.size}`);
        }

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

        // Diagnostic: log render state periodically
        if (this._diagCount % 300 === 1) {
            console.log(`[RemotePlayerRenderer] render: aliveIds=${aliveIds.size}, hitboxes=${this.hitboxes.size}, bufferSize=${this.snapshotBuffer.getBufferSize()}`);
        }

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
                    console.log(`[RemotePlayerRenderer] Hitbox created for ${entityId} at (${created.mesh.position.x.toFixed(1)}, ${created.mesh.position.y.toFixed(1)}, ${created.mesh.position.z.toFixed(1)})`);
                }
            }

            if (!hitbox) continue;

            // Ensure hitbox is visible (may have been hidden during death)
            hitbox.mesh.setEnabled(true);

            // Check if height changed (crouch/uncrouch) — rebuild mesh if so
            const targetHeight = interp.crouching ? CROUCH_HEIGHT : PLAYER_HEIGHT;
            if (hitbox.currentHeight !== targetHeight) {
                hitbox.mesh.dispose();
                const newMesh = this.createHitboxMesh(entityId, targetHeight);
                hitbox.mesh = newMesh;
                hitbox.currentHeight = targetHeight;
            }

            // Update position/rotation from interpolated data
            this.updatePosition(hitbox, interp);
        }

        // Remove hitboxes for entities no longer alive
        for (const [entityId, hitbox] of this.hitboxes) {
            if (!aliveIds.has(entityId)) {
                hitbox.mesh.dispose();
                this.hitboxes.delete(entityId);
                this.deadEntities.delete(entityId); // cleanup
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

    /** Clean up all hitboxes */
    dispose(): void {
        for (const hitbox of this.hitboxes.values()) {
            hitbox.mesh.dispose();
        }
        this.hitboxes.clear();
        this.deadEntities.clear();
    }

    /**
     * Mark an entity as dead — dispose its mesh immediately.
     * Called from FPSGameManager on death events.
     * A fresh hitbox will be created when the entity respawns and reappears in snapshots.
     */
    markDead(entityId: string): void {
        this.deadEntities.set(entityId, performance.now());
        // Fully dispose the hitbox
        const hitbox = this.hitboxes.get(entityId);
        if (hitbox) {
            hitbox.mesh.dispose();
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

        return {
            mesh,
            smoothedPos,
            smoothedYaw: initialState.yaw,
            currentHeight: height,
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
}
