/**
 * DroppedWeaponRenderer — Entity-driven visual renderer for dropped weapons.
 *
 * Server-authoritative: ALL position/lifecycle comes from server snapshots.
 * Client is a pure renderer — no local physics, no event-driven spawning.
 *
 * On each frame's syncServerEntities() call:
 *   - New item_ entity with weaponMeta → spawn visual (load model)
 *   - Entity still present → set mesh position from server data
 *   - Entity gone → dispose visual
 */

import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { EntityRegistry } from '../../../shared/entities/EntityRegistry';

/** Data passed from GameEvents per item_ entity in snapshot */
export interface DroppedWeaponInfo {
    x: number;
    y: number;
    z: number;
    weaponId?: string;
    settled?: boolean;
}

/** Visual representation of a single dropped weapon */
class DroppedWeaponVisual {
    readonly entityId: string;
    readonly weaponId: string;
    mesh: Mesh | null = null;
    glowLight: PointLight | null = null;
    private scene: Scene;
    private disposed: boolean = false;

    constructor(entityId: string, weaponId: string, scene: Scene, position: Vector3) {
        this.entityId = entityId;
        this.weaponId = weaponId;
        this.scene = scene;
        this.loadModel(position);
    }

    private async loadModel(position: Vector3): Promise<void> {
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
                // Find leader mesh (first mesh with geometry)
                let leaderMesh: Mesh | null = null;
                const otherMeshes: Mesh[] = [];

                for (const m of result.meshes) {
                    if (m instanceof Mesh && m.getTotalVertices() > 0) {
                        // Cap lights to prevent shader overflow
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
                    // Position at server location — no physics, just direct placement
                    leaderMesh.parent = null;
                    leaderMesh.position.copyFrom(position);
                    leaderMesh.rotationQuaternion = null;
                    leaderMesh.rotation.setAll(0);
                    leaderMesh.isVisible = true;
                    leaderMesh.scaling.setAll(defScale);

                    // Parent other meshes under leader
                    for (const m of otherMeshes) {
                        m.parent = leaderMesh;
                        m.position.setAll(0);
                        m.rotationQuaternion = null;
                        m.rotation.setAll(0);
                        m.isVisible = true;
                    }

                    this.mesh = leaderMesh;
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
                        this.scene
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
        } finally {
            // no-op
        }
    }

    /** Update position from server snapshot — direct set, no interpolation */
    setPosition(x: number, y: number, z: number): void {
        if (this.mesh) {
            this.mesh.position.set(x, y, z);
        }
        if (this.glowLight) {
            this.glowLight.position.set(x, y + 5, z);
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.glowLight) {
            this.glowLight.dispose();
            this.glowLight = null;
        }
        if (this.mesh) {
            this.mesh.dispose(false, true);
            this.mesh = null;
        }
    }
}

export class DroppedWeaponRenderer {
    private scene: Scene;
    private weapons: Map<string, DroppedWeaponVisual> = new Map();

    constructor(scene: Scene) {
        this.scene = scene;
    }

    /**
     * Sync with server entity state — the ONLY entry point for managing visuals.
     * Called each frame with all item_ entities from the server snapshot.
     *
     * - New entity → spawn visual
     * - Existing entity → update position
     * - Missing entity → dispose visual
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
                // Update position from server
                existing.setPosition(info.x, info.y, info.z);
            } else if (info.weaponId) {
                // New entity — spawn visual
                const visual = new DroppedWeaponVisual(
                    entityId,
                    info.weaponId,
                    this.scene,
                    new Vector3(info.x, info.y, info.z),
                );
                this.weapons.set(entityId, visual);
            }
            // If no weaponId (shouldn't happen with new system), skip
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
    }
}
