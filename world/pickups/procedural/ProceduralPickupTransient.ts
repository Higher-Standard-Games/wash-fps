/**
 * Short collection burst anchored at the authoritative pickup position.
 * Two perpendicular shock rings make the cue visible from ground level and
 * above; deterministic tapered rays carry color outward after the model hides.
 */
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

export interface TransientOptions {
  duration: number;
  endDiameter: number;
  style: "collapse" | "shatter";
  scale: number;
}

export class ProceduralPickupTransient {
  private readonly rings: Mesh[] = [];
  private readonly flash: Mesh;
  private readonly rays: Array<{ mesh: Mesh; direction: Vector3 }> = [];
  private readonly ringMat: StandardMaterial;
  private readonly flashMat: StandardMaterial;
  private readonly rayMat: StandardMaterial;
  private readonly startDiameter: number;
  private readonly endDiameter: number;
  private readonly duration: number;
  private readonly style: "collapse" | "shatter";
  private age = 0;
  private done = false;

  constructor(scene: Scene, parent: TransformNode, color: Color3, opts: TransientOptions) {
    this.duration = opts.duration;
    this.endDiameter = opts.endDiameter;
    this.startDiameter = opts.endDiameter * 0.22;
    this.style = opts.style;

    const material = (name: string, tint: Color3): StandardMaterial => {
      const mat = new StandardMaterial(name, scene);
      mat.disableLighting = true;
      mat.diffuseColor = Color3.Black();
      mat.specularColor = Color3.Black();
      mat.emissiveColor = tint;
      mat.alpha = 1;
      mat.transparencyMode = 2;
      mat.backFaceCulling = false;
      mat.disableDepthWrite = true;
      return mat;
    };
    this.ringMat = material("pp_transient_ring", Color3.Lerp(color, Color3.White(), 0.38));
    this.flashMat = material("pp_transient_flash", Color3.Lerp(color, Color3.White(), 0.65));
    this.rayMat = material("pp_transient_ray", Color3.Lerp(color, Color3.White(), 0.35));

    for (let i = 0; i < 2; i++) {
      const ring = MeshBuilder.CreateTorus(
        "pp_transient_ring",
        {
          diameter: this.startDiameter,
          thickness: 0.95 * opts.scale,
          tessellation: 40,
        },
        scene,
      );
      if (i === 1) ring.rotation.x = Math.PI / 2;
      ring.material = this.ringMat;
      ring.isPickable = false;
      ring.parent = parent;
      this.rings.push(ring);
    }

    this.flash = MeshBuilder.CreateIcoSphere(
      "pp_transient_flash",
      {
        radius: 3.4 * opts.scale,
        subdivisions: 2,
        flat: true,
      },
      scene,
    );
    this.flash.material = this.flashMat;
    this.flash.isPickable = false;
    this.flash.parent = parent;

    const count = this.style === "shatter" ? 10 : 8;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const rise = this.style === "shatter" ? (i % 2 ? 0.6 : 0.18) : i % 2 ? 0.42 : 0.08;
      const direction = new Vector3(Math.cos(angle), rise, Math.sin(angle)).normalize();
      const ray = MeshBuilder.CreateCylinder(
        "pp_transient_ray",
        {
          height: 8 * opts.scale,
          diameterTop: 0,
          diameterBottom: 0.95 * opts.scale,
          tessellation: 3,
        },
        scene,
      );
      const axis = Vector3.Cross(Vector3.Up(), direction).normalize();
      ray.rotationQuaternion = Quaternion.RotationAxis(axis, Math.acos(Vector3.Dot(Vector3.Up(), direction)));
      ray.material = this.rayMat;
      ray.isPickable = false;
      ray.parent = parent;
      this.rays.push({ mesh: ray, direction });
    }
  }

  /** Advance the effect. Returns false once finished and disposed. */
  update(dt: number): boolean {
    if (this.done) return false;
    this.age += dt;
    const p = Math.min(1, this.age / this.duration);
    const fade = 1 - p;
    const diameter = this.startDiameter + (this.endDiameter - this.startDiameter) * p;

    for (let i = 0; i < this.rings.length; i++) {
      this.rings[i].scaling.setAll((diameter / this.startDiameter) * (i ? 0.82 : 1));
    }
    this.ringMat.alpha = fade * fade;
    this.flash.scaling.setAll(this.style === "collapse" ? Math.max(0.01, 1 - p) : 1 + p * 0.25);
    this.flashMat.alpha = fade * fade;

    for (const { mesh, direction } of this.rays) {
      mesh.position.copyFrom(direction.scale(this.endDiameter * 0.45 * p));
      mesh.scaling.y = 0.75 + p * 0.5;
    }
    this.rayMat.alpha = fade * fade;

    if (p >= 1) {
      this.dispose();
      return false;
    }
    return true;
  }

  dispose(): void {
    if (this.done) return;
    this.done = true;
    for (const ring of this.rings) ring.dispose();
    this.flash.dispose();
    for (const { mesh } of this.rays) mesh.dispose();
    this.ringMat.dispose();
    this.flashMat.dispose();
    this.rayMat.dispose();
  }
}
