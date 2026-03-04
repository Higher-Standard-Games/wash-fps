/**
 * GibSystem — Digital breakup gib particles on death
 *
 * Spawns 25 procedural triangle meshes in pink/teal/grey when a player dies.
 * Gibs inherit victim velocity + upward impulse, bounce off BSP surfaces via
 * BabylonJS raycasting, tumble with random rotation, and fade out after 5s.
 *
 * Warsow-style: player "breaks digitally" into triangular fragments.
 */

import { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Ray } from '@babylonjs/core/Culling/ray';

// ============================================================================
// Constants
// ============================================================================

const GIB_COUNT = 20;               // flying gibs (normal + hero)
const GIB_LIFETIME = 8.0;           // seconds
const GIB_FADE_START = 6.5;         // start fading at 6.5s, fully gone at 8s
const GIB_SIZE = 6.0;               // triangle size in world units
const GRAVITY = -360;               // units/s² (slower, floatier gibs)
const UPWARD_IMPULSE_MIN = 200;
const UPWARD_IMPULSE_MAX = 400;
const RANDOM_SPREAD = 180;          // random spherical velocity spread
const TUMBLE_SPEED_MIN = 3;         // radians/s
const TUMBLE_SPEED_MAX = 12;
const MAX_ACTIVE_GIBS = 200;        // hard cap to prevent overload
const TRACED_GIB_COUNT = 5;         // hero gibs that get real raycasts for wall/ceiling bounce
const TRACE_GRACE_PERIOD = 0.15;    // seconds before hero gibs start raycasting (clear spawn geometry)
const DROP_GIB_COUNT = 8;           // body-part drop gibs (fall from body positions)
const DROP_GIB_SIZE = 8.0;          // slightly larger for body fragments
const DROP_GRAVITY = -500;          // faster fall for body parts

// Body-part offsets from death center (approximate humanoid proportions in BSP units)
// These create a "model breaking apart" effect without needing skeleton access
const BODY_PART_OFFSETS = [
    { x: 0, y: 60, z: 0 },    // head
    { x: -15, y: 45, z: 0 },    // left shoulder
    { x: 15, y: 45, z: 0 },    // right shoulder
    { x: -20, y: 30, z: 0 },    // left elbow
    { x: 20, y: 30, z: 0 },    // right elbow
    { x: 0, y: 20, z: 0 },    // torso
    { x: -8, y: 5, z: 0 },    // left hip
    { x: 8, y: 5, z: 0 },    // right hip
];

// ============================================================================
// Gib Colors — Digital breakup palette
// ============================================================================

const GIB_COLORS = [
    { diffuse: new Color3(1.0, 0.2, 0.6), emissive: new Color3(0.5, 0.05, 0.2) },   // Pink
    { diffuse: new Color3(0.0, 0.87, 0.75), emissive: new Color3(0.0, 0.3, 0.25) },  // Teal
    { diffuse: new Color3(0.53, 0.56, 0.63), emissive: new Color3(0.05, 0.05, 0.08) }, // Grey
];

// ============================================================================
// Gib Instance
// ============================================================================

interface Gib {
    mesh: Mesh;
    posX: number; posY: number; posZ: number;
    velX: number; velY: number; velZ: number;
    rotX: number; rotY: number; rotZ: number;        // current rotation
    tumbleX: number; tumbleY: number; tumbleZ: number; // tumble speed (rad/s)
    age: number;
    active: boolean;
    bounced: boolean;   // true after first bounce (only bounce once)
    floorY: number;     // approximate floor level (death Y)
    traced: boolean;    // hero gibs get real raycasts for wall/ceiling bounce
    isDrop: boolean;    // body-part drop gib (falls from body position)
}

// ============================================================================
// GibSystem
// ============================================================================

export class GibSystem {
    private static instance: GibSystem | null = null;

    private scene: Scene | null = null;
    private gibs: Gib[] = [];
    private materials: StandardMaterial[] = [];
    private templateMesh: Mesh | null = null;

    static getInstance(): GibSystem {
        if (!GibSystem.instance) {
            GibSystem.instance = new GibSystem();
        }
        return GibSystem.instance;
    }

    private constructor() { }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    init(scene: Scene): void {
        // Allow re-initialization if scene changes (e.g., stale UI scene → game scene)
        if (this.scene === scene) return;
        if (this.scene) {
            // Dispose old resources from previous scene
            console.log(`[GibSystem] Re-initializing with new scene (old scene was stale)`);
            for (const gib of this.gibs) {
                gib.mesh.dispose();
            }
            this.gibs = [];
            for (const mat of this.materials) {
                mat.dispose();
            }
            this.materials = [];
            if (this.templateMesh) {
                this.templateMesh.dispose();
                this.templateMesh = null;
            }
        }
        this.scene = scene;

        // Create materials for each color
        for (let i = 0; i < GIB_COLORS.length; i++) {
            const mat = new StandardMaterial(`gib_mat_${i}`, scene);
            mat.diffuseColor = GIB_COLORS[i].diffuse;
            mat.emissiveColor = GIB_COLORS[i].emissive;
            mat.specularColor = Color3.Black();
            mat.backFaceCulling = false;
            mat.disableLighting = false;
            this.materials.push(mat);
        }

        // Create template triangle mesh
        this.templateMesh = this.createTriangleMesh(scene);
        this.templateMesh.setEnabled(false);
        this.templateMesh.isPickable = false;
        console.log(`[GibSystem] Initialized in scene: ${scene.uid}`);
    }

    dispose(): void {
        for (const gib of this.gibs) {
            gib.mesh.dispose();
        }
        this.gibs = [];
        for (const mat of this.materials) {
            mat.dispose();
        }
        this.materials = [];
        if (this.templateMesh) {
            this.templateMesh.dispose();
            this.templateMesh = null;
        }
        this.scene = null;
        GibSystem.instance = null;
    }

    // ========================================================================
    // Spawn Gibs
    // ========================================================================

    /**
     * Spawn gibs at death position with victim velocity.
     */
    spawn(x: number, y: number, z: number, velX: number, velY: number, velZ: number): void {
        if (!this.scene || !this.templateMesh) return;

        // Enforce hard cap
        const activeCount = this.gibs.filter(g => g.active).length;
        if (activeCount >= MAX_ACTIVE_GIBS) return;

        // === FLYING GIBS (hero + normal) ===
        for (let i = 0; i < GIB_COUNT; i++) {
            const gib = this.getOrCreateGib();

            // Position: at death center with slight random spread
            gib.posX = x + (Math.random() - 0.5) * 10;
            gib.posY = y + 20 + Math.random() * 10;
            gib.posZ = z + (Math.random() - 0.5) * 10;

            // Velocity: inherit victim velocity + upward impulse + random spread
            const upward = UPWARD_IMPULSE_MIN + Math.random() * (UPWARD_IMPULSE_MAX - UPWARD_IMPULSE_MIN);
            const spreadX = (Math.random() - 0.5) * 2 * RANDOM_SPREAD;
            const spreadY = Math.random() * RANDOM_SPREAD * 0.5;
            const spreadZ = (Math.random() - 0.5) * 2 * RANDOM_SPREAD;

            gib.velX = velX + spreadX;
            gib.velY = velY + upward + spreadY;
            gib.velZ = velZ + spreadZ;

            this.initGibCommon(gib, y, i < TRACED_GIB_COUNT, false);
            // Sync mesh position immediately so gib is visible on spawn frame
            gib.mesh.position.set(gib.posX, gib.posY, gib.posZ);
        }

        // === BODY-PART DROP GIBS ===
        for (let i = 0; i < DROP_GIB_COUNT; i++) {
            const gib = this.getOrCreateGib();
            const offset = BODY_PART_OFFSETS[i % BODY_PART_OFFSETS.length];

            // Position: at body-part offset from death center
            gib.posX = x + offset.x + (Math.random() - 0.5) * 4;
            gib.posY = y + offset.y;
            gib.posZ = z + offset.z + (Math.random() - 0.5) * 4;

            // Velocity: mostly outward + slight drop (no big upward impulse)
            gib.velX = offset.x * 3 + (Math.random() - 0.5) * 40;
            gib.velY = 20 + Math.random() * 30;  // tiny pop
            gib.velZ = offset.z * 3 + (Math.random() - 0.5) * 40;

            // Larger scale for body fragments
            const scale = 0.9 + Math.random() * 0.4;
            gib.mesh.scaling.setAll(scale * (DROP_GIB_SIZE / GIB_SIZE));

            this.initGibCommon(gib, y, false, true);
            // Sync mesh position immediately
            gib.mesh.position.set(gib.posX, gib.posY, gib.posZ);
        }
    }

    /** Shared gib initialization */
    private initGibCommon(gib: Gib, floorY: number, traced: boolean, isDrop: boolean): void {
        gib.rotX = Math.random() * Math.PI * 2;
        gib.rotY = Math.random() * Math.PI * 2;
        gib.rotZ = Math.random() * Math.PI * 2;

        const tMin = isDrop ? 1 : TUMBLE_SPEED_MIN;
        const tMax = isDrop ? 6 : TUMBLE_SPEED_MAX;
        gib.tumbleX = (tMin + Math.random() * (tMax - tMin)) * (Math.random() > 0.5 ? 1 : -1);
        gib.tumbleY = (tMin + Math.random() * (tMax - tMin)) * (Math.random() > 0.5 ? 1 : -1);
        gib.tumbleZ = (tMin + Math.random() * (tMax - tMin)) * (Math.random() > 0.5 ? 1 : -1);

        if (!isDrop) {
            const colorIdx = Math.floor(Math.random() * GIB_COLORS.length);
            gib.mesh.material = this.materials[colorIdx];
            const scale = 0.7 + Math.random() * 0.6;
            gib.mesh.scaling.setAll(scale);
        } else {
            // Body drops use grey/darker tones
            gib.mesh.material = this.materials[2]; // grey
        }

        gib.age = 0;
        gib.active = true;
        gib.bounced = isDrop; // drop gibs skip bounce (just fall through)
        gib.floorY = floorY;
        gib.traced = traced;
        gib.isDrop = isDrop;
        gib.mesh.setEnabled(true);
    }

    // ========================================================================
    // Per-frame Update
    // ========================================================================

    /**
     * Update all active gibs. Call once per frame.
     */
    update(dt: number): void {
        if (!this.scene) return;

        for (const gib of this.gibs) {
            if (!gib.active) continue;

            gib.age += dt;

            // Lifetime expired
            if (gib.age >= GIB_LIFETIME) {
                gib.active = false;
                gib.mesh.setEnabled(false);
                continue;
            }

            // Gravity (body drops fall faster)
            const grav = gib.isDrop ? DROP_GRAVITY : GRAVITY;
            gib.velY += grav * dt;

            // Move
            gib.posX += gib.velX * dt;
            gib.posY += gib.velY * dt;
            gib.posZ += gib.velZ * dt;

            // Bounce: once only (drop gibs skip — they fall through)
            if (!gib.bounced) {
                let didBounce = false;

                if (gib.traced && this.scene && gib.age > TRACE_GRACE_PERIOD) {
                    // Hero gibs: raycast in velocity direction for wall/ceiling/floor bounce
                    const speed = Math.sqrt(gib.velX * gib.velX + gib.velY * gib.velY + gib.velZ * gib.velZ);
                    if (speed > 10) {
                        const moveLen = speed * dt;
                        const dir = new Vector3(gib.velX / speed, gib.velY / speed, gib.velZ / speed);
                        const origin = new Vector3(gib.posX, gib.posY, gib.posZ);
                        const ray = new Ray(origin, dir, moveLen + GIB_SIZE);
                        const hit = this.scene.pickWithRay(ray, m => m.isPickable && !m.name.startsWith('gib_'));
                        if (hit?.hit && hit.pickedPoint && hit.getNormal(true)) {
                            // Reflect velocity off surface normal
                            const n = hit.getNormal(true)!;
                            const dot = gib.velX * n.x + gib.velY * n.y + gib.velZ * n.z;
                            gib.velX = (gib.velX - 2 * dot * n.x) * 0.3;
                            gib.velY = (gib.velY - 2 * dot * n.y) * 0.3;
                            gib.velZ = (gib.velZ - 2 * dot * n.z) * 0.3;
                            // Snap to surface
                            gib.posX = hit.pickedPoint.x + n.x * GIB_SIZE * 0.3;
                            gib.posY = hit.pickedPoint.y + n.y * GIB_SIZE * 0.3;
                            gib.posZ = hit.pickedPoint.z + n.z * GIB_SIZE * 0.3;
                            didBounce = true;
                        }
                    }
                }

                // Non-traced gibs: simple Y-floor check
                if (!didBounce && gib.velY < 0 && gib.posY <= gib.floorY + GIB_SIZE * 0.3) {
                    gib.posY = gib.floorY + GIB_SIZE * 0.3;
                    gib.velY = -gib.velY * 0.3;
                    gib.velX *= 0.5;
                    gib.velZ *= 0.5;
                    didBounce = true;
                }

                if (didBounce) {
                    gib.tumbleX *= 0.4;
                    gib.tumbleY *= 0.4;
                    gib.tumbleZ *= 0.4;
                    gib.bounced = true;
                }
            }

            // Air drag (slight slow-down for floaty feel)
            gib.velX *= (1 - 0.3 * dt);
            gib.velZ *= (1 - 0.3 * dt);

            // Tumble rotation
            gib.rotX += gib.tumbleX * dt;
            gib.rotY += gib.tumbleY * dt;
            gib.rotZ += gib.tumbleZ * dt;

            // Apply to mesh
            gib.mesh.position.set(gib.posX, gib.posY, gib.posZ);
            gib.mesh.rotation.set(gib.rotX, gib.rotY, gib.rotZ);

            // Fade out during last second
            if (gib.age > GIB_FADE_START) {
                const fadeProgress = (gib.age - GIB_FADE_START) / (GIB_LIFETIME - GIB_FADE_START);
                gib.mesh.visibility = 1.0 - fadeProgress;
            } else {
                gib.mesh.visibility = 1.0;
            }
        }
    }

    // ========================================================================
    // Mesh Pool
    // ========================================================================

    private getOrCreateGib(): Gib {
        // Reuse an inactive gib
        for (const gib of this.gibs) {
            if (!gib.active) return gib;
        }

        // Create new gib mesh — fresh geometry each time (avoid clone issues)
        const mesh = this.createTriangleMesh(this.scene!);
        mesh.name = `gib_${this.gibs.length}`;
        mesh.setEnabled(false);
        mesh.isPickable = false;

        const gib: Gib = {
            mesh,
            posX: 0, posY: 0, posZ: 0,
            velX: 0, velY: 0, velZ: 0,
            rotX: 0, rotY: 0, rotZ: 0,
            tumbleX: 0, tumbleY: 0, tumbleZ: 0,
            age: 0,
            active: false,
            bounced: false,
            floorY: 0,
            traced: false,
            isDrop: false,
        };

        this.gibs.push(gib);
        return gib;
    }

    private createTriangleMesh(scene: Scene): Mesh {
        const mesh = new Mesh('gib_template', scene);

        const vertexData = new VertexData();

        // Tetrahedron (4-faced triangular pyramid) for a solid 3D shard look
        const s = GIB_SIZE;
        // 4 vertices forming an irregular tetrahedron (slight asymmetry for organic feel)
        const v0x = 0, v0y = s * 0.7, v0z = 0;            // top
        const v1x = -s * 0.5, v1y = -s * 0.2, v1z = s * 0.3;     // bottom-left-front
        const v2x = s * 0.5, v2y = -s * 0.2, v2z = s * 0.3;     // bottom-right-front
        const v3x = 0, v3y = -s * 0.3, v3z = -s * 0.4;     // bottom-back

        // 4 faces × 3 verts = 12 verts (unshared for flat shading)
        vertexData.positions = [
            // Face 0: front (v0, v1, v2)
            v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z,
            // Face 1: left (v0, v3, v1)
            v0x, v0y, v0z, v3x, v3y, v3z, v1x, v1y, v1z,
            // Face 2: right (v0, v2, v3)
            v0x, v0y, v0z, v2x, v2y, v2z, v3x, v3y, v3z,
            // Face 3: bottom (v1, v3, v2)
            v1x, v1y, v1z, v3x, v3y, v3z, v2x, v2y, v2z,
        ];

        vertexData.indices = [
            0, 1, 2,     // front
            3, 4, 5,     // left
            6, 7, 8,     // right
            9, 10, 11,   // bottom
        ];

        // Compute flat normals per face
        const normals: number[] = [];
        for (let f = 0; f < 4; f++) {
            const i = f * 9;
            const p = vertexData.positions;
            // edge vectors
            const e1x = p[i + 3] - p[i], e1y = p[i + 4] - p[i + 1], e1z = p[i + 5] - p[i + 2];
            const e2x = p[i + 6] - p[i], e2y = p[i + 7] - p[i + 1], e2z = p[i + 8] - p[i + 2];
            // cross product
            let nx = e1y * e2z - e1z * e2y;
            let ny = e1z * e2x - e1x * e2z;
            let nz = e1x * e2y - e1y * e2x;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            nx /= len; ny /= len; nz /= len;
            normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
        }
        vertexData.normals = normals;

        vertexData.applyToMesh(mesh);

        return mesh;
    }
}
