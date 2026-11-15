/**
 * EmpBombModel — the Search & Destroy bomb's model and its purple glow.
 *
 * Loads `models/bomb_emp.glb` from the model pack, makes its purple parts
 * glow (an emissive mask built from the base texture's own purple texels) and
 * adds the moving lightning core ({@link EmpCorePlugin}). The caller drives
 * both glows each frame through {@link EmpBombModel.setGlow}.
 */

import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { markSnapshotMaterialDynamic } from "../../../../engine/rendering/SnapshotFrames";
import { textureFromPixels, texturePixels } from "../../world/pickups/BlueGlow";
import { EmpCorePlugin } from "./EmpCorePlugin";

export const EMP_BOMB_MODEL = "/data/models/bomb_emp.glb";

/** Purple leading green by this much (0-255), in both red and blue, starts to glow; fully by the upper value. */
const PURPLE_LEAD_START = 25;
const PURPLE_LEAD_FULL = 90;

/**
 * How strongly a texel glows, 0-1: purple is red and blue both well over
 * green. Grey, white and black panels lead by nothing and stay dark.
 */
export function purpleGlowWeight(r: number, g: number, b: number): number {
  const lead = Math.min(r, b) - g;
  const t = Math.min(1, Math.max(0, (lead - PURPLE_LEAD_START) / (PURPLE_LEAD_FULL - PURPLE_LEAD_START)));
  return t * t * (3 - 2 * t);
}

/** Keep each texel's colour where it glows and black elsewhere, as RGBA bytes. */
export function purpleGlowMask(pixels: Uint8Array): Uint8Array {
  const out = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const w = purpleGlowWeight(pixels[i], pixels[i + 1], pixels[i + 2]);
    out[i] = pixels[i] * w;
    out[i + 1] = pixels[i + 1] * w;
    out[i + 2] = pixels[i + 2] * w;
    out[i + 3] = 255;
  }
  return out;
}

export class EmpBombModel {
  private constructor(
    /** The model's root, at the model's own scale. */
    readonly root: TransformNode,
    private readonly materials: PBRMaterial[],
    private readonly cores: EmpCorePlugin[],
    private readonly masks: RawTexture[],
  ) {}

  /**
   * Load the bomb at `scale`. Null when the model cannot be loaded or the
   * scene went away meanwhile; the caller draws no bomb then.
   */
  static async load(scene: Scene, scale: number): Promise<EmpBombModel | null> {
    const { ModelLoader } = await import("../../../../engine/loader/model/ModelLoader");
    if (scene.isDisposed) return null;
    const loader = ModelLoader.getInstance();
    if (!loader.isInitialized()) loader.init(scene);
    const result = await loader.loadModel(EMP_BOMB_MODEL, {
      position: Vector3.Zero(),
      scale,
      hasCollision: false,
      receiveShadows: false,
      applyLighting: false,
    });
    if (!result) return null;
    if (scene.isDisposed) {
      result.root.dispose(false, true);
      return null;
    }

    const materials: PBRMaterial[] = [];
    const cores: EmpCorePlugin[] = [];
    const masks: RawTexture[] = [];
    for (const mesh of result.meshes) {
      mesh.isPickable = false;
      const material = mesh.material;
      if (!(material instanceof PBRMaterial) || materials.includes(material)) continue;
      materials.push(material);
      cores.push(new EmpCorePlugin(material));
      markSnapshotMaterialDynamic(material);
      const mask = await EmpBombModel.buildMask(material);
      if (mask) masks.push(mask);
    }
    if (scene.isDisposed || result.root.isDisposed()) {
      for (const mask of masks) mask.dispose();
      result.root.dispose(false, true);
      return null;
    }
    return new EmpBombModel(result.root, materials, cores, masks);
  }

  /** The purple texels of the material's base texture, as its emissive texture. */
  private static async buildMask(material: PBRMaterial): Promise<RawTexture | null> {
    const base = material.albedoTexture;
    if (!base) return null;
    try {
      const read = await texturePixels(base);
      if (!read) return null;
      const mask = textureFromPixels(purpleGlowMask(read.bytes), read.width, read.height, read.scene);
      mask.name = `${base.name}_purple_glow`;
      mask.coordinatesIndex = base.coordinatesIndex;
      material.emissiveTexture = mask;
      material.emissiveColor = Color3.White();
      material.emissiveIntensity = 0;
      return mask;
    } catch (error) {
      console.warn("[EmpBombModel] No glow mask:", error);
      return null;
    }
  }

  /**
   * Set this frame's glow: `shell` for the purple parts all over the bomb,
   * `core` for the lightning disc, both multiples of the lit surface (above 1,
   * bloom picks them up). `time` drives the core's ripple.
   */
  setGlow(shell: number, core: number, time: number): void {
    for (const material of this.materials) material.emissiveIntensity = shell;
    for (const plugin of this.cores) {
      plugin.strength = core;
      plugin.time = time;
    }
  }

  dispose(): void {
    this.root.dispose(false, true);
    for (const mask of this.masks) mask.dispose();
  }
}
