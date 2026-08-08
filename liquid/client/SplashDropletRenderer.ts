/**
 * Epic-tier splash crowns, drawn as thin-instanced droplets.
 *
 * This replaced an attempt to use Babylon's `FluidRenderer`, which turned out
 * to be structurally incompatible with how this game renders. Three separate
 * conflicts, any one of them fatal:
 *
 * 1. **It splices a composite into the camera's post-process chain**, with
 *    `camera: null` and a later `attachPostProcess(pp, i)`. That array is owned
 *    by `DefaultRenderingPipeline`, which then disagrees with what the camera
 *    actually runs. Rebuilding the pipeline on top of it did not help.
 * 2. **Gameplay is multi-camera** — `activeCameras = [eye, weapon]` — and the
 *    fluid pass binds and unbinds framebuffers during `_afterCameraDraw`.
 *    In a layered render that discards the eye camera's output entirely: the
 *    world vanished while the viewmodel and HUD kept drawing.
 * 3. **Its composite is built as `UNSIGNED_BYTE`** into our HDR chain — the
 *    same 8-bit quantisation `CelOutlinePostProcess` documents and works
 *    around, except FluidRenderer hardcodes it and exposes no setter.
 *
 * So the crown is drawn directly instead. Droplets are low-poly SPHERES rather
 * than billboards, which is the trick that keeps this simple: a sphere looks
 * the same from every angle, so there is no per-instance billboarding to do in
 * a vertex shader and no orientation to keep in the instance buffer. At this
 * size a droplet is a few pixels and the geometry is nearly free — the whole
 * pool is under five thousand triangles.
 *
 * Nothing here allocates a render target, touches a post-process, or has an
 * opinion about the camera. It is a mesh.
 */

import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateIcoSphere } from "@babylonjs/core/Meshes/Builders/icoSphereBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import type { Scene } from "@babylonjs/core/scene";
import { MAX_DROPLETS } from "./SplashDroplets";

/** Droplet radius in world units. */
const DROPLET_RADIUS = 3.5;

/**
 * The viewmodel camera's layer.
 *
 * A mesh left on the default mask is visible to BOTH cameras, so spray would
 * be drawn a second time at the weapon's field of view — a handful of boulders
 * across the screen. Clearing the bit is what confines it to the world.
 */
const WEAPON_LAYER_MASK = 0x10000000;

export class SplashDropletRenderer {
  private mesh: Mesh | null = null;
  /** One 4x4 transform per droplet, rewritten in place each frame. */
  private readonly matrices = new Float32Array(MAX_DROPLETS * 16);

  constructor(private readonly scene: Scene) {}

  /**
   * Build the droplet mesh.
   *
   * Returns false only if construction throws. There is no device capability
   * to negotiate here — that was the other design's problem.
   */
  start(): boolean {
    if (this.mesh) return true;

    try {
      // Subdivision 1: twenty faces. A droplet is a few pixels across and
      // rounder costs triangles nobody can see.
      const mesh = CreateIcoSphere("liquid-splash-droplets", { radius: DROPLET_RADIUS, subdivisions: 1 }, this.scene);

      const material = new StandardMaterial("liquid-splash-droplet-mat", this.scene);
      // Emissive rather than lit: spray is bright against both a dark pool and
      // a bright sky, and it must not go black in an unlit corner of a map.
      material.disableLighting = true;
      material.emissiveColor = new Color3(0.78, 0.9, 0.98);
      material.diffuseColor = Color3.Black();
      material.specularColor = Color3.Black();
      material.alpha = 0.85;
      // No depth write, like every other transparent effect here — droplets
      // must not appear in the depth map the water surface measures itself
      // against, or a crown would punch holes in the pool it came from.
      material.disableDepthWrite = true;
      mesh.material = material;

      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.doNotSyncBoundingInfo = true;
      mesh.layerMask &= ~WEAPON_LAYER_MASK;

      mesh.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
      mesh.thinInstanceCount = 0;
      mesh.setEnabled(false);

      this.mesh = mesh;
      return true;
    } catch (error) {
      console.warn("[Water] Could not build splash droplets", error);
      this.dispose();
      return false;
    }
  }

  /**
   * Show `count` droplets from the simulation's interleaved xyz buffer.
   *
   * Writes translation directly into the matrix buffer rather than composing
   * one through `Matrix.Translation`, which would allocate per droplet per
   * frame. Column-major, translation in elements 12..14.
   */
  update(positions: Float32Array, count: number): void {
    const mesh = this.mesh;
    if (!mesh) return;

    const shown = Math.min(count, MAX_DROPLETS);
    if (shown === 0) {
      if (mesh.isEnabled()) {
        mesh.thinInstanceCount = 0;
        mesh.setEnabled(false);
      }
      return;
    }

    const m = this.matrices;
    for (let i = 0; i < shown; i++) {
      const o = i * 16;
      // Identity rotation and scale: a sphere needs neither, which is the
      // entire reason droplets are spheres.
      m[o] = 1;
      m[o + 1] = 0;
      m[o + 2] = 0;
      m[o + 3] = 0;
      m[o + 4] = 0;
      m[o + 5] = 1;
      m[o + 6] = 0;
      m[o + 7] = 0;
      m[o + 8] = 0;
      m[o + 9] = 0;
      m[o + 10] = 1;
      m[o + 11] = 0;
      m[o + 12] = positions[i * 3];
      m[o + 13] = positions[i * 3 + 1];
      m[o + 14] = positions[i * 3 + 2];
      m[o + 15] = 1;
    }

    mesh.thinInstanceCount = shown;
    mesh.thinInstanceBufferUpdated("matrix");
    if (!mesh.isEnabled()) mesh.setEnabled(true);
  }

  get isAvailable(): boolean {
    return this.mesh !== null;
  }

  /** Live instance count. Tests and diagnostics only. */
  get drawnCount(): number {
    return this.mesh?.thinInstanceCount ?? 0;
  }

  dispose(): void {
    if (this.mesh) {
      this.mesh.material?.dispose();
      this.mesh.dispose();
      this.mesh = null;
    }
  }
}
