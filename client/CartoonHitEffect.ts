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
 * Ticked by FrameEffects every frame, and only there: it used to tick itself
 * from a render observer as well, which played every sprite at double speed.
 */

import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Scene } from "@babylonjs/core/scene";
import { PK3Index } from "../../../engine/loader/pk3/PK3Index";
import { PK3Loader } from "../../../engine/loader/pk3/PK3Loader";
import { devLog } from "./DevLog";

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
const HIT_SPRITES = ["effects/cartoonhit1.png", "effects/cartoonhit2.png"];

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
  private textureUrls: string[] = [];
  private loading: Promise<void> | null = null;
  private loadVersion = 0;

  private constructor() {}

  static getInstance(): CartoonHitEffect {
    if (!CartoonHitEffect.instance) {
      CartoonHitEffect.instance = new CartoonHitEffect();
    }
    return CartoonHitEffect.instance;
  }

  /**
   * Initialize with the gameplay scene. Preloads textures.
   */
  init(scene: Scene): Promise<void> {
    if (this.scene && this.scene !== scene) {
      this.dispose();
    }
    if (this.scene === scene) return this.loading ?? Promise.resolve();

    this.scene = scene;
    const version = ++this.loadVersion;
    this.loading = this.loadTextures(scene, version).catch((error) => {
      if (this.loadVersion !== version) return;
      this.dispose();
      throw error;
    });
    return this.loading;
  }

  private async loadTextures(scene: Scene, version: number): Promise<void> {
    const index = PK3Index.getInstance();
    const loader = PK3Loader.getInstance();
    await index.ensureIndex();
    const packages = new Set(
      HIT_SPRITES.map((path) => {
        const owner = index.findFile(path);
        if (!owner) throw new Error(`Missing cartoon hit sprite: ${path}`);
        return owner;
      }),
    );
    await Promise.all([...packages].map((owner) => loader.loadPK3(owner)));
    const images = await Promise.all(HIT_SPRITES.map((path) => loader.getFile(path)));
    if (this.loadVersion !== version || scene.isDisposed) return;
    if (images.some((image) => !image)) throw new Error("Missing packaged cartoon hit image data");
    for (const image of images) {
      const url = URL.createObjectURL(new Blob([image!], { type: "image/png" }));
      this.textureUrls.push(url);
      const texture = new Texture(url, scene, false, true, Texture.BILINEAR_SAMPLINGMODE);
      texture.hasAlpha = true;
      this.textures.push(texture);
    }
    this.texturesLoaded = true;
    console.log(`[CartoonHitEffect] Initialized with ${HIT_SPRITES.length} sprites`);
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
    // Glow samples emission separately from diffuse: retain the artwork's color and alpha.
    effect.material.emissiveTexture = texture;

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

  /** Animate all active effects; FrameEffects calls this every frame. */
  update(dt: number): void {
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
    const mesh = MeshBuilder.CreatePlane(`cartoonhit_${this.effects.length}`, { size: 1 }, this.scene!);
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
    ++this.loadVersion;
    this.loading = null;
    for (const effect of this.effects) {
      effect.mesh.dispose();
      effect.material.dispose();
    }
    this.effects = [];

    for (const tex of this.textures) {
      tex.dispose();
    }
    this.textures = [];
    for (const url of this.textureUrls) URL.revokeObjectURL(url);
    this.textureUrls = [];

    this.scene = null;
    this.texturesLoaded = false;
    devLog("[CartoonHitEffect] Disposed");
  }
}
