/**
 * CartoonHitEffect — Warsow-style cartoon hit sprites (POW!, etc.)
 *
 * On hard hits (damage >= 60), spawns a billboard sprite at the victim's position.
 * The sprite:
 *   - Always faces the camera (billboard mode)
 *   - Randomly picks from cartoonhit1.png / cartoonhit2.png
 *   - Grows slightly and fades out over 800ms while floating upward
 *   - Sized ~2-3x player model height for visibility
 *
 * Self-updating: registers its own onBeforeRender observer so it doesn't
 * depend on external update() calls from FPSGameManager.
 */

import {
    Scene,
    Texture,
    MeshBuilder,
    StandardMaterial,
    Mesh,
    Color3,
    Observer,
} from '@babylonjs/core';

// ============================================================================
// Constants
// ============================================================================

/** Minimum damage to trigger a cartoon hit effect */
const MIN_DAMAGE = 75;

/** Effect lifetime in seconds */
const EFFECT_DURATION = 0.8;

/** Starting scale (relative to final size) */
const START_SCALE = 0.8;

/** Final scale — player model is ~64 units tall, ~2.25x = 144 units */
const END_SCALE = 144;

/** Upward float distance over lifetime (units) */
const FLOAT_UP = 40;

/** Random rotation range (radians) */
const ROTATION_RANGE = Math.PI * 0.25; // +/-45 degrees

/** Max simultaneous effects */
const MAX_EFFECTS = 6;

/** Vertical offset — show sprite at upper body height */
const Y_OFFSET = 30;

/** Available hit sprite paths */
const HIT_SPRITES = [
    '/data/effects/cartoonhit1.png',
    '/data/effects/cartoonhit2.png',
];

// ============================================================================
// Active Effect Instance
// ============================================================================

interface CartoonHitInstance {
    mesh: Mesh;
    material: StandardMaterial;
    elapsed: number;
    active: boolean;
    baseY: number;
}

// ============================================================================
// CartoonHitEffect System
// ============================================================================

export class CartoonHitEffect {
    private static instance: CartoonHitEffect | null = null;
    private scene: Scene | null = null;
    private effects: CartoonHitInstance[] = [];
    private textures: Texture[] = [];
    private texturesLoaded: boolean = false;
    private renderObserver: Observer<Scene> | null = null;
    private lastTime: number = 0;

    private constructor() { }

    static getInstance(): CartoonHitEffect {
        if (!CartoonHitEffect.instance) {
            CartoonHitEffect.instance = new CartoonHitEffect();
        }
        return CartoonHitEffect.instance;
    }

    /**
     * Initialize with the gameplay scene. Preloads textures.
     * Registers a self-driving render observer.
     */
    init(scene: Scene): void {
        if (this.scene && this.scene !== scene) {
            this.dispose();
        }
        if (this.scene === scene) return;

        this.scene = scene;
        this.lastTime = performance.now();

        // Preload sprite textures
        this.textures = HIT_SPRITES.map(path => {
            const tex = new Texture(path, scene, false, true, Texture.BILINEAR_SAMPLINGMODE);
            tex.hasAlpha = true;
            return tex;
        });
        this.texturesLoaded = true;

        // Self-driving update — register on scene render loop
        this.renderObserver = scene.onBeforeRenderObservable.add(() => {
            const now = performance.now();
            const dt = (now - this.lastTime) / 1000;
            this.lastTime = now;
            if (dt > 0 && dt < 1) {
                this._update(dt);
            }
        });

        console.log(`[CartoonHitEffect] Initialized with ${HIT_SPRITES.length} sprites (self-updating)`);
    }

    /**
     * Spawn a cartoon hit effect at the given world position.
     * Only spawns if damage >= MIN_DAMAGE.
     */
    spawn(x: number, y: number, z: number, damage: number): void {
        if (damage < MIN_DAMAGE) return;
        if (!this.scene || !this.texturesLoaded) return;

        // Pick random sprite
        const texIndex = Math.floor(Math.random() * this.textures.length);
        const texture = this.textures[texIndex];

        // Get or create effect instance
        const effect = this.getOrCreateEffect();

        // Apply texture — use diffuseTexture with alpha, same pattern as ProjectileManager sprites
        effect.material.diffuseTexture = texture;

        // Store base Y for float-up animation
        effect.baseY = y + Y_OFFSET;

        // Position at victim with vertical offset
        effect.mesh.position.set(x, y + Y_OFFSET, z);

        // Random Z rotation for variety
        effect.mesh.rotation.z = (Math.random() - 0.5) * ROTATION_RANGE;

        // Start at initial scale
        const s = START_SCALE * END_SCALE;
        effect.mesh.scaling.set(s, s, s);

        // Reset state
        effect.elapsed = 0;
        effect.active = true;
        effect.mesh.visibility = 0.9;
        effect.mesh.setEnabled(true);
    }

    /**
     * External update entry point (called from FPSGameManager).
     * Also called internally by the render observer — whichever fires first animates.
     */
    update(dt: number): void {
        this._update(dt);
    }

    /**
     * Internal update — animate all active effects.
     */
    private _update(dt: number): void {
        for (const effect of this.effects) {
            if (!effect.active) continue;

            effect.elapsed += dt;
            const t = Math.min(effect.elapsed / EFFECT_DURATION, 1.0);

            // Scale: grow from 80% to 110% (overshoot for pop feel)
            const scaleFactor = (START_SCALE + (1.1 - START_SCALE) * t) * END_SCALE;
            effect.mesh.scaling.set(scaleFactor, scaleFactor, scaleFactor);

            // Float upward from base position
            effect.mesh.position.y = effect.baseY + FLOAT_UP * t;

            // Fade out: 0.9 -> 0.0 (linear)
            effect.mesh.visibility = 0.9 * (1.0 - t);

            // Expire
            if (t >= 1.0) {
                effect.active = false;
                effect.mesh.setEnabled(false);
            }
        }
    }

    /**
     * Get an inactive effect or create a new one (up to MAX_EFFECTS).
     */
    private getOrCreateEffect(): CartoonHitInstance {
        // Reuse inactive
        for (const effect of this.effects) {
            if (!effect.active) return effect;
        }

        // Enforce cap — recycle oldest
        if (this.effects.length >= MAX_EFFECTS) {
            const oldest = this.effects[0];
            oldest.active = false;
            oldest.mesh.setEnabled(false);
            return oldest;
        }

        // Create material — same pattern as ProjectileManager sprite billboards
        const mat = new StandardMaterial(`cartoonhit_mat_${this.effects.length}`, this.scene!);
        mat.useAlphaFromDiffuseTexture = true;
        mat.emissiveColor = new Color3(1.0, 1.0, 1.0); // Full self-illumination
        mat.disableLighting = true;
        mat.backFaceCulling = false;
        mat.specularColor = Color3.Black();

        // Create a simple plane mesh
        const mesh = MeshBuilder.CreatePlane(
            `cartoonhit_${this.effects.length}`,
            { size: 1 },
            this.scene!
        );
        mesh.material = mat;
        mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
        mesh.setEnabled(false);
        mesh.isPickable = false;
        mesh.renderingGroupId = 1;

        const instance: CartoonHitInstance = {
            mesh,
            material: mat,
            elapsed: 0,
            active: false,
            baseY: 0,
        };

        this.effects.push(instance);
        return instance;
    }

    /**
     * Dispose all resources.
     */
    dispose(): void {
        // Remove render observer
        if (this.renderObserver && this.scene) {
            this.scene.onBeforeRenderObservable.remove(this.renderObserver);
            this.renderObserver = null;
        }

        for (const effect of this.effects) {
            effect.mesh.dispose();
            effect.material.dispose();
        }
        this.effects = [];

        for (const tex of this.textures) {
            tex.dispose();
        }
        this.textures = [];

        this.scene = null;
        this.texturesLoaded = false;
        console.log('[CartoonHitEffect] Disposed');
    }
}
