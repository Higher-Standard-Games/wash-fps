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

import { FresnelParameters } from "@babylonjs/core/Materials/fresnelParameters";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import { supportsSeparateCullingPass } from "../../../../../engine/rendering/RenderingEngineFactory";
import type { RGB } from "./types";

function toColor3(c: RGB): Color3 {
  return new Color3(c.r, c.g, c.b);
}

/** Emissive scale for cores/plates. ~1.0 keeps colors from clipping to white
 *  under bloom (1.4 blew the health orb out to a white ball in playtest). */
export const ENERGY_BOOST = 1.0;

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
 * Armor plate material (shared, immutable): a solid, saturated, LIT surface.
 *
 * Armor is a physical object in the Warsow language, not an energy field — the
 * previous fully-emissive treatment blew out to a white blob under bloom, losing
 * both the colour and the sculpted facets. Lighting is on so the facets catch
 * highlights; a modest emissive floor keeps the tier colour readable in dark
 * corners without letting bloom eat it.
 */
export function createArmorPlateMaterial(scene: Scene, name: string, color: RGB): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  const base = toColor3(color);
  mat.diffuseColor = base.scale(0.72);
  // Keep the emissive floor low: at 0.34 (plus scene ambient and bloom) the
  // plates still washed out to white and lost both tier colour and facets.
  mat.emissiveColor = base.scale(0.08);
  mat.specularColor = new Color3(0.22, 0.22, 0.25);
  mat.specularPower = 24;
  (mat as unknown as { _baseEmissive: Color3 })._baseEmissive = mat.emissiveColor.clone();
  (mat as unknown as { _baseAlpha: number })._baseAlpha = mat.alpha;
  return mat;
}

/**
 * Fill for the cross's up/down faces (shared, immutable): the tier's own colour,
 * deepened slightly so it sits UNDER the brighter accent-coloured body.
 *
 * These faces were matte black, which disappeared against the shell. Dropping in
 * the tier colour at 0.72 was still too dark: the player looks DOWN at a floor
 * item, so the up-facing caps are most of what you see, and a 0.72 surface next
 * to a bloom-blown shell still reads as a black hole. Full strength — 50 HP
 * orange, 25 HP yellow — against the lighter accent-coloured body, which is
 * contrast enough to keep the arms legible without any outline.
 */
export function createEmblemFillMaterial(scene: Scene, name: string, color: RGB): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = toColor3(color).scale(ENERGY_BOOST);
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
    // Two-pass culling sorts back faces under front faces; NCM cannot record it.
    mat.separateCullingPass = supportsSeparateCullingPass(scene.getEngine());
  }
  // Stash the authored emissive so per-frame pulse can scale from a stable base
  // without drifting.
  (mat as unknown as { _baseEmissive: Color3 })._baseEmissive = mat.emissiveColor.clone();
  (mat as unknown as { _baseAlpha: number })._baseAlpha = alpha;
  return mat;
}

/**
 * Ammo icon decal (shared, immutable): the Warsow simpleitem icon stamped on the
 * crate's sides, unlit so it stays legible whatever the lighting.
 *
 * The texture load is async and the prototype cache is not, so the material
 * starts fully TRANSPARENT and fades in only once the icon actually resolves —
 * that way a missing icon shows nothing rather than a fullbright white square,
 * which is what the old MD3 path guarded against too. Loading is fire-and-forget
 * on purpose: the crate is already renderable without it.
 */
export function createAmmoIconMaterial(scene: Scene, name: string, iconPath: string): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = Color3.White();
  mat.backFaceCulling = false;
  mat.transparencyMode = 2; // ALPHABLEND
  mat.alpha = 0; // invisible until the icon arrives (or forever, if it never does)

  void (async () => {
    try {
      const { PK3TextureLoader } = await import("../../../../../engine/loader/pk3/PK3TextureLoader");
      const loader = PK3TextureLoader.getInstance();
      // Warsow ships these in the non-pure data0 pk3, so fall back to the loose
      // copy under public/data/ exactly like FPSPickup's MD3 path does.
      const tex = (await loader.resolveAndLoadTexture(iconPath)) ?? (await loader.loadTexture(`${iconPath}.tga`));
      // The scene cache may have torn the material down while we were loading.
      if (!tex || !mat.getScene()) return;
      tex.hasAlpha = true;
      mat.diffuseTexture = tex;
      mat.emissiveTexture = tex;
      mat.useAlphaFromDiffuseTexture = true;
      mat.alpha = 1;
    } catch {
      /* leave the decal invisible — the crate still reads by colour */
    }
  })();

  return mat;
}

/** Ring gradient band count — how many bright pulses chase around the ring. */
const RING_GRADIENT_BANDS = 3;
/** Ring transparency at its brightest point. */
const RING_PEAK_ALPHA = 0.72;

/**
 * Per-pickup ring material: a banded colour→accent gradient that SCROLLS around
 * the ring, semi-transparent so it layers over the shell instead of hiding it.
 *
 * The gradient is a 1-D dynamic texture (wrapped along U, which runs the long way
 * around a torus) used for both emissive and opacity, so the ring fades out
 * between pulses rather than reading as a hard band. The visual advances
 * `uOffset` each frame to make it travel. Private per pickup — the texture is
 * disposed with the material.
 */
export function createRingGradientMaterial(scene: Scene, name: string, color: RGB, accent: RGB): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = Color3.White();

  // RawTexture, not DynamicTexture: the latter needs a 2D canvas, which the
  // headless NullEngine used by tests and tooling does not provide.
  const width = 128;
  const data = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    // Each band is a comet: hot accent head fading back to the base colour and
    // then to black. Black reads as transparent via getAlphaFromRGB below, so
    // the ring dissolves between pulses instead of showing a hard seam.
    const phase = ((i / width) * RING_GRADIENT_BANDS) % 1;
    const tail = Math.max(0, 1 - phase / 0.62);
    const k = tail * tail;
    const head = Math.max(0, 1 - phase / 0.16);
    const r = color.r + (accent.r - color.r) * head;
    const g = color.g + (accent.g - color.g) * head;
    const b = color.b + (accent.b - color.b) * head;
    const o = i * 4;
    data[o] = clamp255(r * k);
    data[o + 1] = clamp255(g * k);
    data[o + 2] = clamp255(b * k);
    data[o + 3] = 255;
  }
  const tex = RawTexture.CreateRGBATexture(data, width, 1, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
  tex.name = `${name}_grad`;
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;

  mat.emissiveTexture = tex;
  // Same texture drives opacity: dark stretches of the gradient go see-through.
  mat.opacityTexture = tex;
  mat.opacityTexture.getAlphaFromRGB = true;
  mat.alpha = RING_PEAK_ALPHA;
  mat.transparencyMode = 2; // ALPHABLEND
  mat.backFaceCulling = false;
  // Two-pass culling sorts back faces under front faces; NCM cannot record it.
  mat.separateCullingPass = supportsSeparateCullingPass(scene.getEngine());
  (mat as unknown as { _baseEmissive: Color3 })._baseEmissive = mat.emissiveColor.clone();
  (mat as unknown as { _baseAlpha: number })._baseAlpha = mat.alpha;
  return mat;
}

function clamp255(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
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
 * Per-pickup fresnel energy-shell material (health): the orb is nearly clear
 * where it faces the camera and glows hot at its silhouette edge, so it reads
 * as a contained energy field with real depth instead of a flat ball — and the
 * emblem inside stays visible through the center. The caller animates
 * `emissiveColor` (color↔accent flow × pulse); fresnel shapes WHERE that
 * emissive shows. Private per pickup — dispose with the visual.
 */
export function createFresnelShellMaterial(scene: Scene, name: string, color: RGB): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = toColor3(color).scale(ENERGY_BOOST);

  // Emissive: hottest at grazing angles (left), cooler face-on (right).
  const emissiveFresnel = new FresnelParameters();
  emissiveFresnel.leftColor = Color3.White();
  emissiveFresnel.rightColor = new Color3(0.55, 0.55, 0.55);
  emissiveFresnel.bias = 0.18;
  emissiveFresnel.power = 2.6;
  mat.emissiveFresnelParameters = emissiveFresnel;

  // StandardMaterial adds opacity Fresnel to material alpha. Let Fresnel own
  // the entire opacity so the face-on shell stays clear over the emblem.
  const opacityFresnel = new FresnelParameters();
  opacityFresnel.leftColor = new Color3(0.9, 0.9, 0.9);
  opacityFresnel.rightColor = new Color3(0.12, 0.12, 0.12);
  opacityFresnel.bias = 0;
  opacityFresnel.power = 2.0;
  mat.opacityFresnelParameters = opacityFresnel;

  mat.alpha = 0;
  mat.transparencyMode = 2; // ALPHABLEND
  mat.backFaceCulling = true; // front hemisphere only — back faces would double the rim
  // The shell surrounds the emblem, so writing depth lets the near hemisphere
  // reject the cross behind it — which is what turned the inside of the orb
  // black regardless of how the fresnels were tuned.
  mat.disableDepthWrite = true;
  (mat as unknown as { _baseEmissive: Color3 })._baseEmissive = mat.emissiveColor.clone();
  (mat as unknown as { _baseAlpha: number })._baseAlpha = mat.alpha;
  return mat;
}
