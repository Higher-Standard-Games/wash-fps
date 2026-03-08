/**
 * DroppedWeaponRenderer — Client-side visual rendering of dropped weapons
 *
 * On `weapon_drop` events:
 *   1. Loads the weapon's world model (MD3) via ModelLoader
 *   2. Creates a Havok dynamic body for physics tumble
 *   3. Sets initial linear + angular velocity for toss arc
 *
 * On each frame:
 *   - Havok handles the physics (gravity, bounce, settle)
 *   - After settling, lerps to server-authoritative position from entity snapshots
 *
 * On pickup/despawn:
 *   - Removes physics body + mesh
 */

import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { PhysicsShapeType } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin';
import { ModelLoader } from '../../../engine/loader/model/ModelLoader';
import { PhysicsSystem } from '../../../engine/physics/PhysicsSystem';
import { EntityRegistry } from '../../../shared/entities/EntityRegistry';

// ─── Types ──────────────────────────────────────────────────────

interface DroppedWeaponVisual {
    /** Network entity id (e.g. 'item_50001') */
    entityId: string;
    /** Weapon id (e.g. 'rlauncher') */
    weaponId: string;
    /** Root transform node (parent of all meshes) */
    root: TransformNode;
    /** Primary mesh (for physics body) */
    mesh: Mesh | null;
    /** Spawn time in ms */
    spawnTime: number;
    /** Whether Havok body was created */
    hasPhysics: boolean;
    /** Whether the item has settled (physics done) */
    settled: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

/** Scale for dropped weapon models */
const DROP_MODEL_SCALE = 1.5;

/** Time in ms after which we force-settle and snap to server pos */
const SETTLE_TIMEOUT = 3000;

/** Lerp factor for converging to server position after settle */
const SERVER_LERP = 0.15;

// ─── Renderer ───────────────────────────────────────────────────

export class DroppedWeaponRenderer {
    private scene: Scene;
    private weapons: Map<string, DroppedWeaponVisual> = new Map();

    constructor(scene: Scene) {
        this.scene = scene;
    }

    // ── Public API ──────────────────────────────────────────────

    /**
     * Spawn a dropped weapon visual at the given position with toss velocity.
     * Called when a `weapon_drop` event is received from the server.
     */
    spawn(entityId: string, weaponId: string, position: Vector3, velocity: Vector3): void {
        // Don't double-spawn
        if (this.weapons.has(entityId)) return;

        // Create root node at drop position
        const root = new TransformNode(`dropped_${entityId}`, this.scene);
        root.position = position.clone();

        const visual: DroppedWeaponVisual = {
            entityId,
            weaponId,
            root,
            mesh: null,
            spawnTime: Date.now(),
            hasPhysics: false,
            settled: false,
        };
        this.weapons.set(entityId, visual);

        // Load model async
        this._loadModel(visual, velocity);
    }

    /**
     * Remove a dropped weapon (on pickup or despawn).
     */
    remove(entityId: string): void {
        const visual = this.weapons.get(entityId);
        if (!visual) return;

        // Remove physics body
        if (visual.mesh && visual.hasPhysics) {
            PhysicsSystem.getInstance().removeBody(visual.mesh.name);
        }

        // Dispose the unparented physics proxy (not a child of visual.root)
        if (visual.mesh && !visual.mesh.parent) {
            visual.mesh.dispose();
        }

        // Dispose visual tree — do NOT dispose materials (shared by cloneCachedModel)
        visual.root.dispose(false, false);
        this.weapons.delete(entityId);
    }

    /**
     * Sync with server entity positions.
     * Called each frame with the set of known item_ entity IDs and positions.
     */
    syncServerEntities(entities: Map<string, { x: number; y: number; z: number }>): void {
        // Remove weapons that server no longer sends (picked up or despawned)
        // Collect first to avoid mutating map during iteration
        const toRemove: string[] = [];
        for (const [entityId] of this.weapons) {
            if (!entities.has(entityId)) {
                toRemove.push(entityId);
            }
        }
        for (const entityId of toRemove) {
            this.remove(entityId);
        }

        // Converge settled weapons to server position
        for (const [entityId, visual] of this.weapons) {
            // During physics phase: sync visual.root from proxy mesh position AND rotation.
            // The proxy is the physics body (unparented, world-space); visual.root
            // follows it and child meshes follow via parenting.
            if (!visual.settled && visual.mesh && visual.hasPhysics) {
                visual.root.position.copyFrom(visual.mesh.position);
                // Sync rotation so visual meshes tumble with the physics body
                if (visual.mesh.rotationQuaternion) {
                    visual.root.rotationQuaternion = visual.mesh.rotationQuaternion.clone();
                }

                // Check for timeout settle
                if (Date.now() - visual.spawnTime > SETTLE_TIMEOUT) {
                    visual.settled = true;
                    this._freezePhysics(visual);
                }
                continue;
            }

            const serverPos = entities.get(entityId);
            if (!serverPos) continue;

            // Lerp root toward server pos
            const target = new Vector3(serverPos.x, serverPos.y, serverPos.z);
            visual.root.position = Vector3.Lerp(visual.root.position, target, SERVER_LERP);
        }
    }

    /**
     * Get count of active dropped weapons (for debug).
     */
    get count(): number {
        return this.weapons.size;
    }

    /**
     * Dispose all weapons.
     */
    dispose(): void {
        const ids = [...this.weapons.keys()];
        for (const entityId of ids) {
            this.remove(entityId);
        }
    }

    // ── Private ─────────────────────────────────────────────────

    private async _loadModel(visual: DroppedWeaponVisual, velocity: Vector3): Promise<void> {
        try {
            // Look up model path from EntityRegistry
            const registry = EntityRegistry.getInstance();
            const def = registry.get(visual.weaponId) as any;
            const modelPath = def?.modelPath
                || `models/weapons/${visual.weaponId}/${visual.weaponId}.md3`;
            const defScale = def?.scale ?? DROP_MODEL_SCALE;

            let primaryMesh: Mesh | null = null;

            // === GLB MODEL PATH ===
            if (modelPath.endsWith('.glb') || modelPath.endsWith('.gltf')) {
                const { SceneLoader } = await import('@babylonjs/core/Loading/sceneLoader');
                await import('@babylonjs/loaders/glTF');

                const lastSlash = modelPath.lastIndexOf('/');
                const dir = modelPath.substring(0, lastSlash + 1);
                const file = modelPath.substring(lastSlash + 1);

                const glbResult = await SceneLoader.ImportMeshAsync('', dir, file, this.scene);

                // Bail if removed while loading
                if (!this.weapons.has(visual.entityId)) {
                    glbResult.meshes[0]?.dispose(false, false);
                    return;
                }

                // Flatten GLB hierarchy: re-parent all renderable meshes
                // directly under visual.root. Child meshes follow visual.root
                // via parenting when we sync from the physics proxy.
                const glbRoot = glbResult.meshes[0];

                for (const m of glbResult.meshes) {
                    if (m === glbRoot) continue; // skip __root__ container
                    if (m instanceof Mesh) {
                        m.parent = visual.root;
                        m.rotationQuaternion = null; // allow euler rotation
                        m.scaling.scaleInPlace(defScale);
                    }
                }

                // Dispose the now-empty __root__ node
                if (glbRoot) {
                    glbRoot.parent = null;
                    glbRoot.dispose(false, false);
                }

                // Create invisible proxy box for Havok physics.
                // Havok moves meshes in world-space ignoring parent hierarchy.
                // The proxy is NOT parented to visual.root. We sync
                // visual.root position+rotation ← proxy every frame.
                const { MeshBuilder } = await import('@babylonjs/core/Meshes/meshBuilder');
                const proxy = MeshBuilder.CreateBox(
                    `dropped_${visual.entityId}_physics`,
                    { width: 16 * defScale, height: 8 * defScale, depth: 32 * defScale },
                    this.scene,
                );
                proxy.position = visual.root.position.clone();
                proxy.isVisible = false;
                proxy.isPickable = false;
                primaryMesh = proxy;
            } else {
                // === MD3/PK3 MODEL PATH ===
                let result: any = null;

                // Try AssetPreloader cache first
                try {
                    const { AssetPreloader } = await import('../../../engine/loader/AssetPreloader');
                    const preloader = AssetPreloader.getInstance();
                    if (preloader.hasModel(modelPath)) {
                        result = preloader.cloneCachedModel(modelPath, this.scene);
                    }
                } catch {
                    // Preloader not available
                }

                // Fall back to fresh loading
                if (!result) {
                    const loader = ModelLoader.getInstance();
                    if (!loader.isInitialized()) loader.init(this.scene);
                    result = await loader.loadModel(modelPath, {
                        position: Vector3.Zero(),
                        scale: DROP_MODEL_SCALE,
                        hasCollision: false,
                    });
                }

                // Bail if removed while loading
                if (!this.weapons.has(visual.entityId)) {
                    result?.root?.dispose(false, false);
                    return;
                }

                if (!result?.meshes?.length) {
                    console.warn(`[DroppedWeaponRenderer] No meshes loaded for ${visual.weaponId}`);
                    return;
                }

                // Parent meshes to root node (MD3 style — already single mesh)
                for (const m of result.meshes) {
                    m.parent = visual.root;
                    m.position.setAll(0);
                    m.rotationQuaternion = null;
                    m.rotation.setAll(0);
                    m.isVisible = true;
                    m.scaling.setAll(DROP_MODEL_SCALE);
                    if (!primaryMesh && m instanceof Mesh) {
                        primaryMesh = m;
                    }
                }

                // Dispose loader root
                if (result.root && result.root !== (result.meshes[0] as any)) {
                    result.root.dispose();
                }
            }

            visual.mesh = primaryMesh;

            // Create Havok physics body on the visual mesh (merged for GLB)
            if (primaryMesh) {
                this._createPhysicsBody(visual, primaryMesh, velocity);
            }

            console.log(`[DroppedWeaponRenderer] Spawned ${visual.weaponId} (scale=${defScale}) at ${visual.root.position}`);
        } catch (e) {
            console.error(`[DroppedWeaponRenderer] Failed to load model for ${visual.weaponId}:`, e);
        }
    }

    private _createPhysicsBody(visual: DroppedWeaponVisual, mesh: Mesh, velocity: Vector3): void {
        const physics = PhysicsSystem.getInstance();
        if (!physics.isInitialized()) {
            console.warn(`[DroppedWeaponRenderer] Physics not initialized — using gravity-less drop`);
            visual.settled = true;
            return;
        }

        const handle = physics.createDynamicBody(
            mesh,
            PhysicsShapeType.CONVEX_HULL,
            5,     // mass (lighter than regular pickups for a floatier toss)
            0.25,  // restitution (slight bounce)
        );

        if (!handle || !mesh.physicsBody) {
            visual.settled = true;
            return;
        }

        visual.hasPhysics = true;

        // Set initial linear velocity (toss arc from server)
        mesh.physicsBody.setLinearVelocity(velocity);

        // Set random angular velocity for tumble
        const randomRot = new Vector3(
            (Math.random() - 0.5) * 12,
            (Math.random() - 0.5) * 12,
            (Math.random() - 0.5) * 12,
        );
        mesh.physicsBody.setAngularVelocity(randomRot);

        // Schedule settle detection: check every 500ms if velocity is near zero
        const checkSettle = () => {
            if (!this.weapons.has(visual.entityId)) return;
            if (visual.settled) return;

            if (mesh.physicsBody) {
                const vel = mesh.physicsBody.getLinearVelocity();
                const speed = vel.length();
                if (speed < 2) {
                    visual.settled = true;
                    this._freezePhysics(visual);
                    return;
                }
            }

            // Keep checking
            setTimeout(checkSettle, 500);
        };
        setTimeout(checkSettle, 800);
    }

    private _freezePhysics(visual: DroppedWeaponVisual): void {
        if (!visual.mesh || !visual.hasPhysics) return;

        // Snap visual.root to final physics position + rotation
        visual.root.position.copyFrom(visual.mesh.position);
        if (visual.mesh.rotationQuaternion) {
            visual.root.rotationQuaternion = visual.mesh.rotationQuaternion.clone();
        }

        // Freeze the physics body (stop simulation, save final position)
        if (visual.mesh.physicsBody) {
            visual.mesh.physicsBody.setLinearVelocity(Vector3.Zero());
            visual.mesh.physicsBody.setAngularVelocity(Vector3.Zero());
        }
    }
}
