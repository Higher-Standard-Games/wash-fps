/**
 * BombFloorDecal — the turning glow on the floor under a bomb that is not on
 * anyone's back.
 *
 * A disc of light the size of the arm/defuse radius, so it shows the ground a
 * player has to stand on to work on the bomb. Strongest at the centre, it
 * fades out to nothing at the radius, with soft spiral arms that turn. It is a
 * translucent wash of colour, never opaque, so the floor's own texture shows
 * through all the way out; on a bright floor, light added to it would only
 * turn white.
 */

import { Constants } from "@babylonjs/core/Engines/constants";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { markSnapshotMaterialDynamic } from "../../../../engine/rendering/SnapshotFrames";

/** Texels across the generated glow. */
const TEXTURE_SIZE = 256;
/** Spiral arms in the glow, and how far each one winds from the centre to the edge, in turns. */
const ARMS = 3;
const ARM_WIND = 0.6;
/** How much the arms stand out from the even glow under them, 0-1. */
const ARM_CONTRAST = 0.7;
/** The strongest the wash gets, at the centre, 0-1. */
const PEAK_OPACITY = 0.7;
/** Lift off the floor, against z-fighting; the depth bias does the rest. */
const LIFT = 1.5;
const TESSELLATION = 64;

const smooth = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/**
 * The glow's strength at a point of the disc, 0-1: `r` from 0 at the centre
 * to 1 at the edge, `angle` in radians. A strong core, a body that holds out
 * to half the radius and then fades to nothing at the edge, and spiral arms
 * over it. The arms leave the core alone, where the bomb sits.
 */
export function floorGlowAt(r: number, angle: number): number {
  if (r >= 1) return 0;
  const fade = smooth((1 - r) / 0.55);
  const core = Math.exp(-((r / 0.14) ** 2));
  const arm = 0.5 + 0.5 * Math.cos(ARMS * angle - r * ARM_WIND * Math.PI * 2 * ARMS);
  const arms = 1 - ARM_CONTRAST * smooth(r / 0.2) * (1 - arm * arm);
  return Math.min(1, fade * arms * 0.6 + core * 0.4);
}

/** The glow as RGBA bytes: white, with the strength in alpha. The material gives the colour. */
export function floorGlowPixels(size = TEXTURE_SIZE): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const i = (y * size + x) * 4;
      out[i] = 255;
      out[i + 1] = 255;
      out[i + 2] = 255;
      out[i + 3] = Math.round(floorGlowAt(Math.hypot(dx, dy), Math.atan2(dy, dx)) * 255);
    }
  }
  return out;
}

export class BombFloorDecal {
  private readonly mesh: Mesh;
  private readonly material: StandardMaterial;
  private readonly texture: RawTexture;
  private angle = 0;

  constructor(scene: Scene, radius: number) {
    this.texture = RawTexture.CreateRGBATexture(
      floorGlowPixels(),
      TEXTURE_SIZE,
      TEXTURE_SIZE,
      scene,
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    this.texture.name = "bomb_floor_glow";
    this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;

    const material = new StandardMaterial("bomb_floor_mat", scene);
    material.disableLighting = true;
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.emissiveColor = new Color3(1, 1, 1);
    material.opacityTexture = this.texture;
    material.alphaMode = Constants.ALPHA_COMBINE;
    material.disableDepthWrite = true;
    material.zOffset = -2;
    material.backFaceCulling = false;
    markSnapshotMaterialDynamic(material);
    this.material = material;

    this.mesh = CreateDisc("bomb_floor", { radius, tessellation: TESSELLATION }, scene);
    // The disc is built facing -Z; lay it on the floor
    this.mesh.rotation.x = Math.PI / 2;
    this.mesh.material = material;
    this.mesh.isPickable = false;
    this.mesh.checkCollisions = false;
    this.mesh.setEnabled(false);
  }

  /**
   * Show the glow at a floor point in a colour, at `strength` 0-1 of its
   * peak, turning at `spin` radians a second. `dt` is seconds.
   */
  show(x: number, y: number, z: number, color: Color3, strength: number, spin: number, dt: number): void {
    this.angle = (this.angle + spin * dt) % (Math.PI * 2);
    this.mesh.setEnabled(true);
    this.mesh.position.set(x, y + LIFT, z);
    this.mesh.rotation.y = this.angle;
    this.material.emissiveColor.copyFrom(color);
    this.material.alpha = PEAK_OPACITY * strength;
  }

  hide(): void {
    this.mesh.setEnabled(false);
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
