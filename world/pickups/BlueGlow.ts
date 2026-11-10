import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import { markSnapshotMaterialDynamic } from "../../../../engine/rendering/SnapshotFrames";

/** How much brighter than the lit surface the blue parts glow; above 1, bloom picks them up. */
const BLUE_GLOW_INTENSITY = 3;
/** Blue leading red and green by this much (0-255) starts to glow, and by the upper value glows fully. */
const BLUE_LEAD_START = 30;
const BLUE_LEAD_FULL = 90;

/** The glow breathes this many times a second, between these shares of its full strength. */
const PULSE_RATE = 0.5;
const PULSE_LOW = 0.7;
const PULSE_HIGH = 1.15;

/** One mask per base texture: every copy of the model shares it. */
const masks = new WeakMap<BaseTexture, Promise<RawTexture | null>>();

/**
 * How strongly a texel glows, 0-1, from how far its blue leads its red and
 * green. Grey, white and black panels lead by nothing and stay dark.
 */
export function blueGlowWeight(r: number, g: number, b: number): number {
  const lead = b - Math.max(r, g);
  const t = Math.min(1, Math.max(0, (lead - BLUE_LEAD_START) / (BLUE_LEAD_FULL - BLUE_LEAD_START)));
  return t * t * (3 - 2 * t);
}

/** Keep each texel's colour where it glows and black elsewhere, as RGBA bytes. */
export function blueGlowMask(pixels: Uint8Array): Uint8Array {
  const out = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const w = blueGlowWeight(pixels[i], pixels[i + 1], pixels[i + 2]);
    out[i] = pixels[i] * w;
    out[i + 1] = pixels[i + 1] * w;
    out[i + 2] = pixels[i + 2] * w;
    out[i + 3] = 255;
  }
  return out;
}

async function buildMask(base: BaseTexture): Promise<RawTexture | null> {
  const scene = base.getScene();
  if (!scene) return null;
  await new Promise<void>((resolve) => {
    if (base.isReady()) resolve();
    else (base as Texture).onLoadObservable?.addOnce(() => resolve()) ?? resolve();
  });
  const size = base.getSize();
  const pixels = await base.readPixels();
  if (!pixels || !size.width || !size.height) return null;
  const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  if (bytes.length < size.width * size.height * 4) return null;
  // The pixels come back as the texture holds them, so the mask is uploaded
  // the same way round and reads with the base texture's coordinates
  const mask = RawTexture.CreateRGBATexture(
    blueGlowMask(bytes),
    size.width,
    size.height,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  mask.name = `${base.name}_blue_glow`;
  return mask;
}

/** The glowing materials of each scene, which one observer makes breathe together. */
const pulses = new WeakMap<Scene, Set<PBRMaterial>>();

function scenePulse(scene: Scene): Set<PBRMaterial> {
  let cores = pulses.get(scene);
  if (cores) return cores;
  const breathing = new Set<PBRMaterial>();
  cores = breathing;
  pulses.set(scene, breathing);
  const observer = scene.onBeforeRenderObservable.add(() => {
    const t = performance.now() / 1000;
    const strength = PULSE_LOW + (PULSE_HIGH - PULSE_LOW) * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 * PULSE_RATE));
    for (const core of breathing) core.emissiveIntensity = BLUE_GLOW_INTENSITY * strength;
  });
  scene.onDisposeObservable.addOnce(() => scene.onBeforeRenderObservable.remove(observer));
  return cores;
}

/** Let a core material breathe with the others until it is disposed. */
function breathe(cores: Set<PBRMaterial>, material: PBRMaterial): void {
  if (cores.has(material)) return;
  cores.add(material);
  material.onDisposeObservable.addOnce(() => cores.delete(material));
}

/**
 * Make the strongly blue parts of a model's base texture glow: an emissive
 * texture holding only those texels, brighter than the lit surface, breathing
 * slowly. The mask is built once per texture from its pixels, so it works with
 * any renderer.
 */
export async function glowBlueParts(root: AbstractMesh): Promise<void> {
  const cores = scenePulse(root.getScene());
  for (const mesh of [root, ...root.getChildMeshes(false)]) {
    const material = mesh.material as PBRMaterial | null;
    const base = material?.albedoTexture;
    if (!material || !base) continue;
    if (material.emissiveTexture) {
      breathe(cores, material);
      continue;
    }
    let mask = masks.get(base);
    if (!mask) {
      mask = buildMask(base).catch((error: unknown) => {
        console.warn("[BlueGlow] No glow mask:", error);
        return null;
      });
      masks.set(base, mask);
    }
    const texture = await mask;
    if (!texture || mesh.isDisposed()) continue;
    texture.coordinatesIndex = base.coordinatesIndex;
    material.emissiveTexture = texture;
    material.emissiveColor = Color3.White();
    material.emissiveIntensity = BLUE_GLOW_INTENSITY;
    markSnapshotMaterialDynamic(material);
    breathe(cores, material);
  }
}
