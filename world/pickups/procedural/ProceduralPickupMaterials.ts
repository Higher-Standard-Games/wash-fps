/**
 * Material ownership for procedural pickups (docs/research/PROCEDURAL_ITEMS.md
 * §"Materials and Effects").
 *
 * Two material roles:
 *  - STRUCTURAL: dark, moderately rough, lit by the scene — the chunky relic
 *    geometry that gives silhouette. A faint emissive of the recipe color keeps
 *    it from reading as pure black in unlit corners. Shared & immutable →
 *    owned by the scene-scoped asset cache.
 *  - ENERGY: vivid, self-lit (unlit) emissive — the core / rings / glyphs that
 *    glow and pulse. Each pickup gets a PRIVATE clone so its pulse/alpha can
 *    animate independently → owned by the individual visual.
 */

import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import type { RGB } from "./types";

function toColor3(c: RGB): Color3 {
  return new Color3(c.r, c.g, c.b);
}

/** Emissive scale for cores/plates. ~1.0 keeps colors from clipping to white
 *  under bloom (1.4 blew the health orb out to a white ball in playtest). */
export const ENERGY_BOOST = 1.0;

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/**
 * Dark structural material (shared, immutable). Lit by the scene so the relic
 * geometry has form; a low emissive tint of the item color prevents a black
 * silhouette in dark map areas.
 */
export function createStructuralMaterial(scene: Scene, name: string, color: RGB): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = new Color3(0.05, 0.055, 0.07);
  mat.specularColor = new Color3(0.15, 0.15, 0.18);
  mat.specularPower = 32;
  mat.emissiveColor = toColor3(color).scale(0.12);
  mat.ambientColor = Color3.White();
  return mat;
}

/**
 * Base (template) energy material: fully self-lit emissive, no lighting. Clone
 * per pickup with `cloneEnergyMaterial` to get a private, animatable copy.
 * `alpha < 1` enables premultiplied-ish alpha blending for softer glow layers.
 */
export function createEnergyMaterialTemplate(
  scene: Scene,
  name: string,
  color: RGB,
  alpha = 1,
  boost = 1,
): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = toColor3(color).scale(boost);
  mat.alpha = alpha;
  if (alpha < 1) {
    mat.transparencyMode = 2; // ALPHABLEND
    mat.backFaceCulling = false;
    mat.separateCullingPass = true;
  }
  // Stash the authored emissive so per-frame pulse can scale from a stable base
  // without drifting.
  (mat as unknown as { _baseEmissive: Color3 })._baseEmissive = mat.emissiveColor.clone();
  (mat as unknown as { _baseAlpha: number })._baseAlpha = alpha;
  return mat;
}

/** Private, animatable clone of an energy material template (owned by a visual). */
export function cloneEnergyMaterial(template: StandardMaterial, name: string): StandardMaterial {
  const mat = template.clone(name);
  (mat as unknown as { _baseEmissive: Color3 })._baseEmissive = template.emissiveColor.clone();
  (mat as unknown as { _baseAlpha: number })._baseAlpha = template.alpha;
  return mat;
}

/** The authored (unpulsed) emissive color stashed on an energy material. */
export function baseEmissive(mat: StandardMaterial): Color3 {
  return (mat as unknown as { _baseEmissive?: Color3 })._baseEmissive ?? mat.emissiveColor;
}

/** The authored (unpulsed) alpha stashed on an energy material. */
export function baseAlpha(mat: StandardMaterial): number {
  return (mat as unknown as { _baseAlpha?: number })._baseAlpha ?? mat.alpha;
}

/**
 * A seamless 1D gradient texture blending `a`↔`b`↔`a`, so scrolling its U offset
 * loops smoothly. Generated in memory (no external asset), works under NullEngine.
 */
function createGradientTexture(scene: Scene, name: string, a: RGB, b: RGB, size = 64): RawTexture {
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = (Math.sin((i / size) * Math.PI * 2) + 1) / 2; // 0→1→0 seamless
    data[i * 4] = clampByte(a.r + (b.r - a.r) * t);
    data[i * 4 + 1] = clampByte(a.g + (b.g - a.g) * t);
    data[i * 4 + 2] = clampByte(a.b + (b.b - a.b) * t);
    data[i * 4 + 3] = 255;
  }
  const tex = RawTexture.CreateRGBATexture(data, size, 1, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
  tex.name = `${name}_grad`;
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return tex;
}

/**
 * Per-pickup scrolling-gradient core material (health): a bright self-lit orb
 * whose emissive flows `color`→`accent` as its U offset is scrolled each frame.
 * Slightly translucent so the cross emblem reads through it. Owns its texture —
 * dispose with `mat.dispose(false, true)`.
 */
export function createGradientCoreMaterial(
  scene: Scene,
  name: string,
  color: RGB,
  accent: RGB,
  alpha = 0.78,
  boost = 0.9,
): StandardMaterial {
  const tex = createGradientTexture(scene, name, color, accent);
  const mat = new StandardMaterial(name, scene);
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = new Color3(boost, boost, boost); // white × boost, modulated by texture
  mat.emissiveTexture = tex;
  mat.alpha = alpha;
  if (alpha < 1) {
    mat.transparencyMode = 2; // ALPHABLEND
    mat.backFaceCulling = false;
    mat.separateCullingPass = true;
  }
  (mat as unknown as { _baseEmissive: Color3 })._baseEmissive = mat.emissiveColor.clone();
  (mat as unknown as { _baseAlpha: number })._baseAlpha = alpha;
  (mat as unknown as { _gradTex: RawTexture })._gradTex = tex;
  return mat;
}

/** The scrolling gradient texture on a gradient-core material (for U scrolling). */
export function gradientTexture(mat: StandardMaterial): RawTexture | null {
  return (mat as unknown as { _gradTex?: RawTexture })._gradTex ?? null;
}
