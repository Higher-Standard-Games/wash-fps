/**
 * Detached collection transient for procedural pickups
 * (docs/research/PROCEDURAL_ITEMS.md §"Collected"). A short-lived expanding ring
 * plus a fading flash, spawned at the moment of collection and parented to the
 * pickup's FIXED anchor (not the persistent cosmetic root) so it survives the
 * persistent geometry being hidden. It owns its meshes and materials and
 * self-disposes when its clock runs out.
 *
 * Time is driven by the visual's `update(dt)` rather than a private scene
 * observer, so a single update path covers the whole family and the effect is
 * deterministic under headless tests.
 */

import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

export interface TransientOptions {
  duration: number;
  /** Expanded ring diameter at the end of the effect. */
  endDiameter: number;
  /** "collapse" fades a shrinking flash; "shatter" throws a couple shards out. */
  style: "collapse" | "shatter";
  scale: number;
}

export class ProceduralPickupTransient {
  private readonly ring: Mesh;
  private readonly flash: Mesh;
  private readonly shards: Mesh[] = [];
  private readonly ringMat: StandardMaterial;
  private readonly flashMat: StandardMaterial;
  private readonly startDiameter: number;
  private readonly endDiameter: number;
  private readonly duration: number;
  private readonly style: "collapse" | "shatter";
  private age = 0;
  private done = false;

  constructor(scene: Scene, parent: TransformNode, color: Color3, opts: TransientOptions) {
    this.duration = opts.duration;
    this.endDiameter = opts.endDiameter;
    this.startDiameter = opts.endDiameter * 0.25;
    this.style = opts.style;

    this.ringMat = new StandardMaterial("pp_transient_ring", scene);
    this.ringMat.disableLighting = true;
    this.ringMat.diffuseColor = Color3.Black();
    this.ringMat.emissiveColor = color.clone();
    this.ringMat.alpha = 1;
    this.ringMat.transparencyMode = 2;
    this.ringMat.backFaceCulling = false;

    this.flashMat = new StandardMaterial("pp_transient_flash", scene);
    this.flashMat.disableLighting = true;
    this.flashMat.diffuseColor = Color3.Black();
    // A hot near-white center that settles to the item color as it fades.
    this.flashMat.emissiveColor = Color3.Lerp(color, Color3.White(), 0.6);
    this.flashMat.alpha = 1;
    this.flashMat.transparencyMode = 2;
    this.flashMat.backFaceCulling = false;

    this.ring = MeshBuilder.CreateTorus(
      "pp_transient_ring",
      { diameter: this.startDiameter, thickness: 1.4 * opts.scale, tessellation: 36 },
      scene,
    );
    this.ring.material = this.ringMat;
    this.ring.isPickable = false;
    this.ring.parent = parent;

    this.flash = MeshBuilder.CreateIcoSphere(
      "pp_transient_flash",
      { radius: 6 * opts.scale, subdivisions: 2, flat: true },
      scene,
    );
    this.flash.material = this.flashMat;
    this.flash.isPickable = false;
    this.flash.parent = parent;

    if (this.style === "shatter") {
      for (let i = 0; i < 3; i++) {
        const shard = MeshBuilder.CreatePolyhedron("pp_transient_shard", { type: 0, size: 2.4 * opts.scale }, scene);
        shard.material = this.ringMat;
        shard.isPickable = false;
        shard.parent = parent;
        this.shards.push(shard);
      }
    }
  }

  /** Advance the effect. Returns false once finished (and disposed). */
  update(dt: number): boolean {
    if (this.done) return false;
    this.age += dt;
    const p = Math.min(1, this.age / this.duration);
    const fade = 1 - p;

    // Ring expands outward and fades.
    const diam = this.startDiameter + (this.endDiameter - this.startDiameter) * p;
    const ringScale = diam / this.startDiameter;
    this.ring.scaling.setAll(ringScale);
    this.ringMat.alpha = fade;

    // Flash: collapse shrinks toward a point; shatter holds then fades.
    if (this.style === "collapse") {
      this.flash.scaling.setAll(Math.max(0.01, 1 - p));
    } else {
      this.flash.scaling.setAll(1 + p * 0.4);
    }
    this.flashMat.alpha = fade * fade;

    // Shards fly outward.
    for (let i = 0; i < this.shards.length; i++) {
      const angle = (i / this.shards.length) * Math.PI * 2;
      const dist = p * this.endDiameter * 0.5;
      const shard = this.shards[i];
      shard.position.set(Math.cos(angle) * dist, Math.sin(p * Math.PI) * 6, Math.sin(angle) * dist);
      shard.scaling.setAll(fade);
    }

    if (p >= 1) {
      this.dispose();
      return false;
    }
    return true;
  }

  dispose(): void {
    if (this.done) return;
    this.done = true;
    this.ring.dispose();
    this.flash.dispose();
    for (const s of this.shards) s.dispose();
    this.ringMat.dispose();
    this.flashMat.dispose();
  }
}
