import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { VertexBuffer } from "@babylonjs/core/Meshes/buffer";
import { markSnapshotMaterialDynamic } from "../../../../engine/rendering/SnapshotFrames";
import { blueGlowWeight, textureFromPixels, texturePixels } from "./BlueGlow";

/** A tier's colour: the hue (degrees) every texel turns to, and how much of its lightness it keeps. */
export interface HealthTint {
  hue: number | null;
  lightness: number;
}

/** The health bubble's colour by tier; the +5 keeps the model's own blue. */
const HEALTH_TINTS: Readonly<Record<string, HealthTint>> = {
  health_large: { hue: 18, lightness: 0.85 },
  health_medium: { hue: 40, lightness: 1 },
  health_small: { hue: null, lightness: 1 },
};

/** How brightly the bubble glows: the cross and its strongly blue trim fully, the rest at this share. */
const GLOW_INTENSITY = 1.6;
const GLOW_BASE = 0.25;

/** Recolour one texel: its hue becomes the tint's, its saturation stays and its lightness is scaled. */
export function tintTexel(r: number, g: number, b: number, tint: HealthTint): [number, number, number] {
  if (tint.hue === null && tint.lightness === 1) return [r, g, b];
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = ((max + min) / 2) * tint.lightness;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(max + min - 1));
  let h = tint.hue;
  if (h === null) {
    if (d === 0) h = 0;
    else if (max === R) h = 60 * (((G - B) / d + 6) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
  }
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

/**
 * The tinted texture and its glow, as RGBA bytes. Texels the fullbright mask
 * covers (0-255 per texel) lose their lit colour to the glow, so they show
 * their full colour whatever light falls on them.
 */
export function tintPixels(
  pixels: Uint8Array,
  tint: HealthTint,
  fullbright?: Uint8Array,
): { color: Uint8Array; glow: Uint8Array } {
  const color = new Uint8Array(pixels.length);
  const glow = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b] = tintTexel(pixels[i], pixels[i + 1], pixels[i + 2], tint);
    const full = fullbright ? fullbright[i >> 2] / 255 : 0;
    color[i] = r * (1 - full);
    color[i + 1] = g * (1 - full);
    color[i + 2] = b * (1 - full);
    color[i + 3] = pixels[i + 3];
    // The glow follows the original blue, so the blue trim shines whatever colour it turns
    const blue = GLOW_BASE + (1 - GLOW_BASE) * blueGlowWeight(pixels[i], pixels[i + 1], pixels[i + 2]);
    const share = Math.max(blue, full);
    glow[i] = r * share;
    glow[i + 1] = g * share;
    glow[i + 2] = b * share;
    glow[i + 3] = 255;
  }
  return { color, glow };
}

/**
 * The triangles of a model's innermost part: of its separate pieces (joined
 * where they share a corner), the smallest one whose bounds hold the model's
 * centre. For the health bubble that is the cross.
 */
export function innermostPart(positions: ArrayLike<number>, indices: ArrayLike<number>): number[] {
  const count = positions.length / 3;
  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  const join = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  // Seams split a corner into several vertices; the same position joins them again
  const byPlace = new Map<string, number>();
  const centerMin = [Infinity, Infinity, Infinity];
  const centerMax = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < count; v++) {
    const place = `${Math.round(positions[v * 3] * 1e4)},${Math.round(positions[v * 3 + 1] * 1e4)},${Math.round(positions[v * 3 + 2] * 1e4)}`;
    const same = byPlace.get(place);
    if (same === undefined) byPlace.set(place, v);
    else join(v, same);
    for (let a = 0; a < 3; a++) {
      centerMin[a] = Math.min(centerMin[a], positions[v * 3 + a]);
      centerMax[a] = Math.max(centerMax[a], positions[v * 3 + a]);
    }
  }
  for (let t = 0; t < indices.length; t += 3) {
    join(indices[t], indices[t + 1]);
    join(indices[t], indices[t + 2]);
  }
  const center = centerMin.map((m, a) => (m + centerMax[a]) / 2);
  const parts = new Map<number, { triangles: number[]; min: number[]; max: number[] }>();
  for (let t = 0; t < indices.length; t += 3) {
    const root = find(indices[t]);
    let part = parts.get(root);
    if (!part) {
      part = { triangles: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      parts.set(root, part);
    }
    part.triangles.push(t);
    for (let k = 0; k < 3; k++) {
      const v = indices[t + k];
      for (let a = 0; a < 3; a++) {
        part.min[a] = Math.min(part.min[a], positions[v * 3 + a]);
        part.max[a] = Math.max(part.max[a], positions[v * 3 + a]);
      }
    }
  }
  let inner: { triangles: number[]; size: number } | null = null;
  for (const part of parts.values()) {
    if (![0, 1, 2].every((a) => part.min[a] <= center[a] && center[a] <= part.max[a])) continue;
    const size = Math.hypot(part.max[0] - part.min[0], part.max[1] - part.min[1], part.max[2] - part.min[2]);
    if (!inner || size < inner.size) inner = { triangles: part.triangles, size };
  }
  return inner?.triangles ?? [];
}

/** How far past a triangle's edge, in texels, the mask reaches, so filtering never shows its lit border. */
const MASK_BLEED = 2;

/** Cover the given triangles' texture area with 255, one byte per texel, row v × height. */
export function triangleMask(
  uvs: ArrayLike<number>,
  indices: ArrayLike<number>,
  triangles: readonly number[],
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const t of triangles) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((v) => [
      uvs[v * 2] * width,
      uvs[v * 2 + 1] * height,
    ]);
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (area === 0) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
        const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) mask[y * width + x] = 255;
      }
    }
  }
  // Spread the cover a few texels, first across and then down
  for (let pass = 0; pass < 2; pass++) {
    const from = mask.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (from[y * width + x]) continue;
        for (let d = -MASK_BLEED; d <= MASK_BLEED; d++) {
          const nx = pass === 0 ? x + d : x;
          const ny = pass === 0 ? y : y + d;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && from[ny * width + nx]) {
            mask[y * width + x] = 255;
            break;
          }
        }
      }
    }
  }
  return mask;
}

/** The fullbright mask of a mesh's innermost part, in its texture's texels, or undefined without the data. */
function crossMask(mesh: AbstractMesh, width: number, height: number): Uint8Array | undefined {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
  const indices = mesh.getIndices();
  if (!positions || !uvs || !indices) return undefined;
  const triangles = innermostPart(positions, indices);
  return triangles.length ? triangleMask(uvs, indices, triangles, width, height) : undefined;
}

/** One tinted copy of each source material per tier, shared by every bubble of that tier. */
const tinted = new WeakMap<PBRMaterial, Map<string, Promise<PBRMaterial | null>>>();

async function tintMaterial(
  source: PBRMaterial,
  mesh: AbstractMesh,
  tier: string,
  tint: HealthTint,
): Promise<PBRMaterial | null> {
  const base = source.albedoTexture;
  if (!base) return null;
  const read = await texturePixels(base);
  if (!read) return null;
  const { color, glow } = tintPixels(read.bytes, tint, crossMask(mesh, read.width, read.height));
  const material = source.clone(`${source.name}_${tier}`) as PBRMaterial;
  const albedo = textureFromPixels(color, read.width, read.height, read.scene);
  const emissive = textureFromPixels(glow, read.width, read.height, read.scene);
  for (const texture of [albedo, emissive]) texture.coordinatesIndex = base.coordinatesIndex;
  albedo.name = `${base.name}_${tier}`;
  emissive.name = `${base.name}_${tier}_glow`;
  material.albedoTexture = albedo;
  material.emissiveTexture = emissive;
  material.emissiveColor = Color3.White();
  material.emissiveIntensity = GLOW_INTENSITY;
  return material;
}

/**
 * Colour a health bubble by its tier and make it glow: each tier draws a copy
 * of the model's material whose texture is recoloured to the tier's hue, with
 * an emissive copy that lights the blue trim. The cross, the model's innermost
 * part, is fullbright: its texels carry no lit colour, only glow. The copies
 * are built once from the texture's pixels, so they work with any renderer.
 */
export async function tintHealthBubble(root: AbstractMesh, tier: string): Promise<void> {
  const tint = HEALTH_TINTS[tier];
  if (!tint) return;
  for (const mesh of [root, ...root.getChildMeshes(false)]) {
    const source = mesh.material as PBRMaterial | null;
    if (!source?.albedoTexture) continue;
    let byTier = tinted.get(source);
    if (!byTier) {
      byTier = new Map();
      tinted.set(source, byTier);
    }
    let material = byTier.get(tier);
    if (!material) {
      material = tintMaterial(source, mesh, tier, tint).catch((error: unknown) => {
        console.warn("[HealthTint] No tint:", error);
        return null;
      });
      byTier.set(tier, material);
    }
    const ready = await material;
    if (ready && !mesh.isDisposed()) mesh.material = ready;
  }
}

/** The cyan-to-blue hues the megahealth's core is painted in, in degrees, and the fade past them. */
const CORE_HUE_CENTRE = 205;
const CORE_HUE_REACH = 45;
const CORE_HUE_FADE = 20;

const smooth = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * How much of a texel belongs to a cyan-to-blue core, 0-1: its hue near the
 * core's and its colour saturated enough to read as one. Greys, whites and
 * other colours score nothing.
 */
export function coreHueWeight(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (max === 0 || d === 0) return 0;
  const h = max === r ? 60 * (((g - b) / d + 6) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  const off = Math.abs(h - CORE_HUE_CENTRE);
  return (1 - smooth(CORE_HUE_REACH, CORE_HUE_REACH + CORE_HUE_FADE, off)) * smooth(0.2, 0.4, d / max);
}

/**
 * Turn a texture's cyan-to-blue texels to `hue`, as RGBA bytes, with its glow:
 * the recoloured texels as strongly as the megahealth's blue glows, black
 * elsewhere. Every other texel keeps its colour.
 */
export function recolorBluePixels(pixels: Uint8Array, hue: number): { color: Uint8Array; glow: Uint8Array } {
  const color = new Uint8Array(pixels.length);
  const glow = new Uint8Array(pixels.length);
  const tint: HealthTint = { hue, lightness: 1 };
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const w = coreHueWeight(r, g, b);
    const [tr, tg, tb] = w > 0 ? tintTexel(r, g, b, tint) : [r, g, b];
    color[i] = r + (tr - r) * w;
    color[i + 1] = g + (tg - g) * w;
    color[i + 2] = b + (tb - b) * w;
    color[i + 3] = pixels[i + 3];
    const shine = w * Math.max(blueGlowWeight(r, g, b), 0.5);
    glow[i] = tr * shine;
    glow[i + 1] = tg * shine;
    glow[i + 2] = tb * shine;
    glow[i + 3] = 255;
  }
  return { color, glow };
}

/** One recoloured copy of each source material per hue, shared by every item of that colour. */
const recolored = new WeakMap<PBRMaterial, Map<number, Promise<PBRMaterial | null>>>();

async function recolorMaterial(source: PBRMaterial, hue: number): Promise<PBRMaterial | null> {
  const base = source.albedoTexture;
  if (!base) return null;
  const read = await texturePixels(base);
  if (!read) return null;
  const { color, glow } = recolorBluePixels(read.bytes, hue);
  const material = source.clone(`${source.name}_hue${hue}`) as PBRMaterial;
  const albedo = textureFromPixels(color, read.width, read.height, read.scene);
  const emissive = textureFromPixels(glow, read.width, read.height, read.scene);
  for (const texture of [albedo, emissive]) texture.coordinatesIndex = base.coordinatesIndex;
  albedo.name = `${base.name}_hue${hue}`;
  emissive.name = `${base.name}_hue${hue}_glow`;
  material.albedoTexture = albedo;
  material.emissiveTexture = emissive;
  material.emissiveColor = Color3.White();
  // Its glow breathes (glowBlueParts), which a recorded frame must not freeze
  markSnapshotMaterialDynamic(material);
  return material;
}

/**
 * Draw a model with its strongly blue parts in another colour, glowing in it:
 * the ultra health is the megahealth with a purple core. Call glowBlueParts
 * after it to make the glow breathe with the megahealth's.
 */
export async function recolorBlueParts(root: AbstractMesh, hue: number): Promise<void> {
  for (const mesh of [root, ...root.getChildMeshes(false)]) {
    const source = mesh.material as PBRMaterial | null;
    if (!source?.albedoTexture) continue;
    let byHue = recolored.get(source);
    if (!byHue) {
      byHue = new Map();
      recolored.set(source, byHue);
    }
    let material = byHue.get(hue);
    if (!material) {
      material = recolorMaterial(source, hue).catch((error: unknown) => {
        console.warn("[HealthTint] No recolour:", error);
        return null;
      });
      byHue.set(hue, material);
    }
    const ready = await material;
    if (ready && !mesh.isDisposed()) mesh.material = ready;
  }
}
