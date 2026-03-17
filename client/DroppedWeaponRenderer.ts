/**
 * DroppedWeaponRenderer — Hybrid: entity-driven lifecycle + client Havok physics.
 *
 * Architecture:
 *   Lifecycle : Server-authoritative via entity snapshots (spawn/despawn)
 *   Physics   : Client-side Havok (arc, tumble, settle, BSP collision)
 *   Materials : Cloned from AssetPreloader cache or fresh ModelLoader load
 *
 * Flow:
 *   1. weapon_drop event → stash initial velocity (velX/Y/Z) in pendingVelocities
 *   2. syncServerEntities() sees new item_ entity → spawn model + Havok body
 *   3. Havok handles visual physics (gravity, tumble, collision with BSP trimesh)
 *   4. Once settled, Havok body frozen — position locked
 *   5. Entity gone from snapshot → dispose Havok body + visual
 */

import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { PhysicsShapeType } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin';
import { EntityRegistry } from '../../../shared/entities/EntityRegistry';

/** Data passed from GameEvents per item_ entity in snapshot */
export interface DroppedWeaponInfo {
    x: number;
    y: number;
    z: number;
    weaponId?: string;
    settled?: boolean;
}

/** Visual representation of a single dropped weapon with Havok physics */
class DroppedWeaponVisual {
    readonly entityId: string;
    readonly weaponId: string;
    mesh: Mesh | null = null;
    glowLight: PointLight | null = null;
    private scene: Scene;
    private disposed: boolean = false;
    private settled: boolean = false;
    private settleCheckTimer: ReturnType<typeof setInterval> | null = null;
    hasPhysics: boolean = false;
    /** Server's authoritative position — used to align visual after Havok settles */
    private serverPosition: Vector3 = Vector3.Zero();

    constructor(
        entityId: string,
        weaponId: string,
        scene: Scene,
        position: Vector3,
        velocity?: Vector3,
    ) {
        this.entityId = entityId;
        this.weaponId = weaponId;
        this.scene = scene;
        this.loadModel(position, velocity);
    }

    private async loadModel(position: Vector3, velocity?: Vector3): Promise<void> {
        if (this.disposed) return;

        try {
            // Look up model path from EntityRegistry
            const registry = EntityRegistry.getInstance();
            const def = registry.get(this.weaponId) as any;
            const modelPath = def?.modelPath || `models/weapons/${this.weaponId}/${this.weaponId}.md3`;
            const defScale = def?.scale ?? 1.5;
            const glowColor = def?.glowColor as { r: number; g: number; b: number } | undefined;

            // Try AssetPreloader cache first for instant spawn
            let result: any = null;
            try {
                const { AssetPreloader } = await import('../../../engine/loader/AssetPreloader');
                const preloader = AssetPreloader.getInstance();
                if (preloader.hasModel(modelPath)) {
                    result = preloader.cloneCachedModel(modelPath, this.scene);
                }
            } catch {
                // Preloader not available
            }

            // Fall back to fresh load
            if (!result) {
                const { ModelLoader } = await import('../../../engine/loader/model/ModelLoader');
                const loader = ModelLoader.getInstance();
                if (!loader.isInitialized()) loader.init(this.scene);
                result = await loader.loadModel(modelPath, {
                    position: Vector3.Zero(),
                    scale: defScale,
                    hasCollision: false,
                    applyLighting: false,
                });
            }

            // If disposed during async load, clean up and bail
            if (this.disposed) {
                if (result?.root) result.root.dispose();
                return;
            }

            if (result?.root) {
                // Find leader mesh (first mesh with geometry) — same pattern as Pickup.loadModel
                let leaderMesh: Mesh | null = null;
                const otherMeshes: Mesh[] = [];

                for (const m of result.meshes) {
                    if (m instanceof Mesh && m.getTotalVertices() > 0) {
                        // Cap lights to prevent shader uniform block overflow
                        if (m.material && 'maxSimultaneousLights' in m.material) {
                            (m.material as any).maxSimultaneousLights = 4;
                        }
                        if (!leaderMesh) {
                            leaderMesh = m;
                        } else {
                            otherMeshes.push(m);
                        }
                    }
                }

                if (leaderMesh) {
                    // CRITICAL: Havok needs root-level mesh (no parent).
                    // This is identical to how Pickup.loadModel works.
                    leaderMesh.parent = null;
                    // Unique name so PhysicsSystem body map doesn't collide
                    leaderMesh.name = `droppedWeapon_${this.entityId}`;
                    leaderMesh.position.copyFrom(position);
                    leaderMesh.rotationQuaternion = null;
                    leaderMesh.rotation.setAll(0);
                    leaderMesh.isVisible = true;
                    leaderMesh.scaling.setAll(defScale);

                    // Parent other meshes under leader (follow Havok movement)
                    for (const m of otherMeshes) {
                        m.parent = leaderMesh;
                        m.position.setAll(0);
                        m.rotationQuaternion = null;
                        m.rotation.setAll(0);
                        m.isVisible = true;
                    }

                    this.mesh = leaderMesh;

                    // === HAVOK PHYSICS ===
                    // Create dynamic body identical to Pickup.loadModel()
                    const { PhysicsSystem } = await import('../../../engine/physics/PhysicsSystem');
                    const physics = PhysicsSystem.getInstance();
                    if (physics.isInitialized() && !this.disposed) {
                        physics.createDynamicBody(leaderMesh, PhysicsShapeType.CONVEX_HULL, 10, 0.3);
                        this.hasPhysics = true;

                        if (leaderMesh.physicsBody) {
                            if (velocity) {
                                // Toss arc from weapon_drop event velocity
                                leaderMesh.physicsBody.setLinearVelocity(velocity);
                            }
                            // Random tumble rotation (same as Pickup)
                            const randomRot = new Vector3(
                                (Math.random() - 0.5) * 12,
                                (Math.random() - 0.5) * 12,
                                (Math.random() - 0.5) * 12,
                            );
                            leaderMesh.physicsBody.setAngularVelocity(randomRot);

                            // Settle detection: freeze when velocity < 2
                            this.scheduleSettleCheck();
                        }
                    }
                }

                // Detach loader root without disposing children
                if (result.root) {
                    result.root.parent = null;
                    result.root.setEnabled(false);
                }

                // Create glow light
                if (glowColor && leaderMesh) {
                    const light = new PointLight(
                        `droppedGlow_${this.entityId}`,
                        leaderMesh.position.clone(),
                        this.scene,
                    );
                    light.diffuse = new Color3(glowColor.r, glowColor.g, glowColor.b);
                    light.specular = new Color3(glowColor.r * 0.5, glowColor.g * 0.5, glowColor.b * 0.5);
                    light.intensity = 2.0;
                    light.range = 30;
                    this.glowLight = light;
                }
            }
        } catch (e) {
            console.error(`[DroppedWeaponVisual] Failed to load model for ${this.weaponId}:`, e);
        }
    }

    /** Settle detection — check velocity every 500ms, freeze when near-zero */
    private scheduleSettleCheck(): void {
        this.settleCheckTimer = setInterval(() => {
            if (this.disposed || !this.mesh?.physicsBody) {
                if (this.settleCheckTimer) clearInterval(this.settleCheckTimer);
                return;
            }
            const linVel = this.mesh.physicsBody.getLinearVelocity();
            const speed = linVel.length();
            if (speed < 2) {
                // Freeze the body — physics done
                this.mesh.physicsBody.setLinearVelocity(Vector3.Zero());
                this.mesh.physicsBody.setAngularVelocity(Vector3.Zero());
                this.settled = true;
                if (this.settleCheckTimer) clearInterval(this.settleCheckTimer);
            }
        }, 500);
    }

    /** Update server position from snapshot data */
    setServerPosition(x: number, y: number, z: number): void {
        this.serverPosition.set(x, y, z);
    }

    /** Update each frame: lerp to server position after settle + glow follow */
    update(): void {
        if (!this.mesh) return;

        // After Havok settles, lerp mesh to server's authoritative position
        // so visual matches the actual pickup zone
        if (this.settled && this.serverPosition.lengthSquared() > 0) {
            const lerpFactor = 0.15; // Smooth convergence over ~10 frames
            this.mesh.position.x += (this.serverPosition.x - this.mesh.position.x) * lerpFactor;
            this.mesh.position.y += (this.serverPosition.y - this.mesh.position.y) * lerpFactor;
            this.mesh.position.z += (this.serverPosition.z - this.mesh.position.z) * lerpFactor;
        }

        // Update glow light to follow mesh
        if (this.glowLight) {
            this.glowLight.position.copyFrom(this.mesh.position);
            this.glowLight.position.y += 5;
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.settleCheckTimer) {
            clearInterval(this.settleCheckTimer);
            this.settleCheckTimer = null;
        }
        if (this.glowLight) {
            this.glowLight.dispose();
            this.glowLight = null;
        }
        if (this.mesh) {
            const meshName = this.mesh.name;
            // Remove Havok body first
            if (this.mesh.physicsBody) {
                this.mesh.physicsBody.dispose();
            }
            // Clean up PhysicsSystem body map reference
            import('../../../engine/physics/PhysicsSystem').then(({ PhysicsSystem }) => {
                PhysicsSystem.getInstance().removeBody(meshName);
            }).catch(() => { });
            // Dispose child meshes (other weapon parts parented to leader)
            const children = this.mesh.getChildMeshes();
            for (const child of children) {
                child.parent = null;
                // CRITICAL: dispose(false, false) — do NOT dispose shared materials!
                // Materials are shared with AssetPreloader cache and other clones.
                child.dispose(false, false);
            }
            // Dispose leader mesh — also don't dispose materials
            this.mesh.dispose(false, false);
            this.mesh = null;
        }
    }
}

export class DroppedWeaponRenderer {
    private scene: Scene;
    private weapons: Map<string, DroppedWeaponVisual> = new Map();

    /** Stashed initial velocities from weapon_drop events (entityId → velocity) */
    private pendingVelocities: Map<string, Vector3> = new Map();

    constructor(scene: Scene) {
        this.scene = scene;
    }

    /**
     * Stash initial velocity from weapon_drop event.
     * Called from GameEvents when weapon_drop fires — the velocity is used
     * by Havok when the corresponding item_ entity appears in snapshot.
     */
    stashVelocity(entityId: string, velocity: Vector3): void {
        this.pendingVelocities.set(entityId, velocity);
        // Auto-clean after 5 seconds (if entity never appears)
        setTimeout(() => this.pendingVelocities.delete(entityId), 5000);
    }

    /**
     * Sync with server entity state — the ONLY entry point for lifecycle management.
     * Called each frame with all item_ entities from the server snapshot.
     *
     * - New entity → spawn visual with Havok body
     * - Existing entity → let Havok handle position (update glow only)
     * - Missing entity → dispose Havok body + visual
     */
    syncServerEntities(entities: Map<string, DroppedWeaponInfo>): void {
        // 1. Remove visuals for entities that server no longer sends
        const toRemove: string[] = [];
        for (const entityId of this.weapons.keys()) {
            if (!entities.has(entityId)) {
                toRemove.push(entityId);
            }
        }
        for (const entityId of toRemove) {
            const visual = this.weapons.get(entityId);
            if (visual) {
                visual.dispose();
                this.weapons.delete(entityId);
            }
        }

        // 2. Update existing or spawn new visuals
        for (const [entityId, info] of entities) {
            const existing = this.weapons.get(entityId);
            if (existing) {
                // Update server position + glow/lerp
                existing.setServerPosition(info.x, info.y, info.z);
                existing.update();
            } else if (info.weaponId) {
                // New entity — spawn visual with Havok physics
                const vel = this.pendingVelocities.get(entityId);
                this.pendingVelocities.delete(entityId);

                const visual = new DroppedWeaponVisual(
                    entityId,
                    info.weaponId,
                    this.scene,
                    new Vector3(info.x, info.y, info.z),
                    vel, // Initial toss velocity from weapon_drop event
                );
                this.weapons.set(entityId, visual);
            }
        }
    }

    /** Get count of active dropped weapons (for debug). */
    get count(): number {
        return this.weapons.size;
    }

    /** Dispose all weapons. */
    dispose(): void {
        for (const visual of this.weapons.values()) {
            visual.dispose();
        }
        this.weapons.clear();
        this.pendingVelocities.clear();
    }
}
