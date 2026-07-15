/**
 * DamageNumbers — Quake Live / Warfork style floating damage numbers
 *
 * 3D billboard text that floats upward from the victim's head position.
 * Only shows for damage dealt by the local player.
 *
 * - White text for normal damage, yellow for high (>50)
 * - Floats up at 80 units/sec for 1.5 seconds
 * - Fades out over last 0.5s
 * - Random X offset to prevent overlap on rapid hits
 */

import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Scene } from "@babylonjs/core/scene";

// ============================================================================
// Constants
// ============================================================================

const LIFETIME = 1.5; // seconds
const FADE_START = 1.0; // start fading at 1s
const FLOAT_SPEED = 80; // units/sec upward
const HEAD_OFFSET = 36; // offset above entity position (head height)
const PLANE_SIZE = 20; // billboard plane size in world units
const FONT_SIZE = 60; // px on dynamic texture
const TEXTURE_SIZE = 128; // dynamic texture resolution
const RANDOM_OFFSET_X = 15; // random horizontal spread
const MAX_ACTIVE = 32; // hard cap

const COLOR_NORMAL = "#FFFFFF";
const COLOR_HIGH = "#FFDD00"; // Yellow for >50 damage
const HIGH_DAMAGE_THRESHOLD = 50;

// ============================================================================
// DamageNumber Instance
// ============================================================================

interface DamageNumber {
  mesh: Mesh;
  material: StandardMaterial;
  texture: DynamicTexture;
  startX: number;
  startY: number;
  startZ: number;
  age: number;
  active: boolean;
}

// ============================================================================
// DamageNumbers System
// ============================================================================

export class DamageNumbers {
  private static instance: DamageNumbers | null = null;

  private scene: Scene | null = null;
  private numbers: DamageNumber[] = [];

  static getInstance(): DamageNumbers {
    if (!DamageNumbers.instance) {
      DamageNumbers.instance = new DamageNumbers();
    }
    return DamageNumbers.instance;
  }

  /** Create an independently-owned instance for demo playback. */
  static create(scene: Scene): DamageNumbers {
    const system = new DamageNumbers();
    system.init(scene);
    return system;
  }

  private constructor() {}

  // ========================================================================
  // Lifecycle
  // ========================================================================

  init(scene: Scene): void {
    if (this.scene) return;
    this.scene = scene;
  }

  dispose(): void {
    for (const num of this.numbers) {
      num.texture.dispose();
      num.material.dispose();
      num.mesh.dispose();
    }
    this.numbers = [];
    this.scene = null;
    if (DamageNumbers.instance === this) DamageNumbers.instance = null;
  }

  /** Remove active presentation without releasing scene-owned pool resources. */
  clear(): void {
    for (const num of this.numbers) {
      num.active = false;
      num.mesh.setEnabled(false);
    }
  }

  // ========================================================================
  // Spawn
  // ========================================================================

  /**
   * Spawn a floating damage number at the given world position.
   */
  spawn(x: number, y: number, z: number, damage: number): void {
    if (!this.scene) return;

    // Enforce cap
    const activeCount = this.numbers.filter((n) => n.active).length;
    if (activeCount >= MAX_ACTIVE) return;

    const num = this.getOrCreate();

    // Position: at victim head + random X offset
    num.startX = x + (Math.random() - 0.5) * RANDOM_OFFSET_X;
    num.startY = y + HEAD_OFFSET;
    num.startZ = z + (Math.random() - 0.5) * RANDOM_OFFSET_X;

    // Draw the damage text
    const isHigh = damage >= HIGH_DAMAGE_THRESHOLD;
    const color = isHigh ? COLOR_HIGH : COLOR_NORMAL;
    const text = String(damage);

    const ctx = num.texture.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    ctx.font = `bold ${FONT_SIZE}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Black outline for readability
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 4;
    ctx.strokeText(text, TEXTURE_SIZE / 2, TEXTURE_SIZE / 2);

    // Fill
    ctx.fillStyle = color;
    ctx.fillText(text, TEXTURE_SIZE / 2, TEXTURE_SIZE / 2);

    num.texture.update();

    // Reset state
    num.age = 0;
    num.active = true;
    num.mesh.setEnabled(true);
    num.mesh.position.set(num.startX, num.startY, num.startZ);
    num.mesh.visibility = 1.0;
  }

  // ========================================================================
  // Per-frame Update
  // ========================================================================

  update(dt: number): void {
    if (!this.scene) return;

    for (const num of this.numbers) {
      if (!num.active) continue;

      num.age += dt;

      if (num.age >= LIFETIME) {
        num.active = false;
        num.mesh.setEnabled(false);
        continue;
      }

      // Float upward
      const y = num.startY + FLOAT_SPEED * num.age;
      num.mesh.position.set(num.startX, y, num.startZ);

      // Fade out in last phase
      if (num.age > FADE_START) {
        const fadeProgress = (num.age - FADE_START) / (LIFETIME - FADE_START);
        num.mesh.visibility = 1.0 - fadeProgress;
      }
    }
  }

  // ========================================================================
  // Pool
  // ========================================================================

  private getOrCreate(): DamageNumber {
    // Reuse inactive
    for (const num of this.numbers) {
      if (!num.active) return num;
    }

    // Create new
    const texture = new DynamicTexture(
      `dmg_tex_${this.numbers.length}`,
      { width: TEXTURE_SIZE, height: TEXTURE_SIZE },
      this.scene!,
      false,
    );
    texture.hasAlpha = true;

    const material = new StandardMaterial(`dmg_mat_${this.numbers.length}`, this.scene!);
    material.diffuseTexture = texture;
    material.opacityTexture = texture;
    material.emissiveColor = Color3.White();
    material.disableLighting = true;
    material.backFaceCulling = false;

    // Use additive-like appearance
    material.useAlphaFromDiffuseTexture = true;
    (material.diffuseTexture as Texture).getAlphaFromRGB = false;

    const mesh = MeshBuilder.CreatePlane(`dmg_plane_${this.numbers.length}`, { size: PLANE_SIZE }, this.scene!);
    mesh.material = material;
    mesh.isPickable = false;
    mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    mesh.setEnabled(false);

    const num: DamageNumber = {
      mesh,
      material,
      texture,
      startX: 0,
      startY: 0,
      startZ: 0,
      age: 0,
      active: false,
    };

    this.numbers.push(num);
    return num;
  }
}
