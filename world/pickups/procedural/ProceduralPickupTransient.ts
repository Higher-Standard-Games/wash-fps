/**
 * A short, client-only burst of pieces shaped and colored for the collected
 * item. A pickup keeps one and plays it again on each collection: the pieces
 * are disabled between bursts rather than created and disposed per burst, so
 * collecting changes no more than what is shown.
 */
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { ProceduralPickupFamily } from "./types";

export interface TransientOptions {
  duration: number;
  endDiameter: number;
  style: "collapse" | "shatter";
  scale: number;
  family: ProceduralPickupFamily;
}

interface Fragment {
  mesh: Mesh;
  /** Start position relative to the burst's center. */
  offset: Vector3;
  start: Vector3;
  travel: Vector3;
  tumble: Vector3;
  baseRotationZ: number;
}

const SHAPES: Record<ProceduralPickupFamily, ReadonlyArray<readonly [number, number]>> = {
  health: [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-0.45, 0.45],
    [0.45, -0.45],
  ],
  armor: [
    [-0.8, 0.65],
    [0.8, 0.65],
    [0, 0.2],
    [-0.5, -0.65],
    [0.5, -0.65],
    [0, -0.9],
  ],
  ammo: [
    [-0.7, 0.5],
    [0.7, 0.5],
    [-0.7, -0.5],
    [0.7, -0.5],
    [0, 0.9],
    [0, -0.9],
  ],
  powerup: Array.from({ length: 6 }, (_, i) => [Math.cos((i * Math.PI) / 3), Math.sin((i * Math.PI) / 3)]),
};

export class ProceduralPickupTransient {
  private readonly fragments: Fragment[] = [];
  private readonly flash: Mesh;
  private readonly materials: StandardMaterial[];
  private readonly duration: number;
  private age = 0;
  /** Between bursts: pieces disabled, nothing to advance. */
  private idle = false;
  private disposed = false;

  constructor(scene: Scene, parent: TransformNode, color: Color3, opts: TransientOptions) {
    this.duration = opts.duration;
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
    const bright = material("pp_transient_bright", Color3.Lerp(color, Color3.White(), 0.4));
    const dark = material("pp_transient_dark", color.scale(0.42));
    const flashMat = material("pp_transient_flash", Color3.Lerp(color, Color3.White(), 0.7));
    this.materials = [bright, dark, flashMat];

    const layout = SHAPES[opts.family];
    const spread = opts.endDiameter * (opts.style === "shatter" ? 0.33 : 0.25);
    for (let i = 0; i < layout.length; i++) {
      const [x, y] = layout[i];
      let mesh: Mesh;
      const baseRotationZ = opts.family === "powerup" ? (i * Math.PI) / 3 : 0;
      if (opts.family === "powerup") {
        mesh = MeshBuilder.CreateCylinder(
          "pp_transient_fragment",
          { height: 2.8 * opts.scale, diameterTop: 0, diameterBottom: 2.7 * opts.scale, tessellation: 3 },
          scene,
        );
        mesh.rotation.z = baseRotationZ;
      } else {
        const armor = opts.family === "armor";
        const ammo = opts.family === "ammo";
        mesh = MeshBuilder.CreateBox(
          "pp_transient_fragment",
          {
            width: (armor ? (i < 2 ? 4.2 : 3.2) : ammo ? 3.7 : i < 4 ? 2.1 : 1.5) * opts.scale,
            height: (armor ? 3.5 : ammo ? 2.8 : i < 4 ? 3.5 : 1.5) * opts.scale,
            depth: (ammo ? 1.6 : 1.1) * opts.scale,
          },
          scene,
        );
      }
      mesh.material = i % 3 === 0 ? dark : bright;
      mesh.isPickable = false;
      mesh.parent = parent;
      const offset = new Vector3(x * 2.5 * opts.scale, y * 2.5 * opts.scale, 0);
      const angle = (i / layout.length) * Math.PI * 2;
      const travel = new Vector3(Math.cos(angle) * spread, (0.4 + (i % 3) * 0.18) * spread, Math.sin(angle) * spread);
      const tumble = new Vector3((i % 2 ? 1 : -1) * 1.4, ((i % 3) - 1) * 1.8, (i % 2 ? -1 : 1) * 1.5);
      this.fragments.push({ mesh, offset, start: new Vector3(), travel, tumble, baseRotationZ });
    }

    this.flash = MeshBuilder.CreateIcoSphere(
      "pp_transient_flash",
      { radius: 2.3 * opts.scale, subdivisions: 1, flat: true },
      scene,
    );
    this.flash.material = flashMat;
    this.flash.isPickable = false;
    this.flash.parent = parent;
    // Built parked: the first collection plays it
    this.park();
  }

  /** Start a burst from `center` (local to the parent: the animated item above its anchor). */
  play(center: { x: number; y: number }): void {
    if (this.disposed) return;
    this.age = 0;
    this.idle = false;
    for (const fragment of this.fragments) {
      fragment.start.set(center.x + fragment.offset.x, center.y + fragment.offset.y, 0);
      fragment.mesh.position.copyFrom(fragment.start);
      fragment.mesh.rotation.set(0, 0, fragment.baseRotationZ);
      fragment.mesh.scaling.setAll(1);
      fragment.mesh.setEnabled(true);
    }
    this.flash.position.set(center.x, center.y, 0);
    this.flash.scaling.setAll(1);
    this.flash.setEnabled(true);
    for (const material of this.materials) material.alpha = 1;
  }

  /** Advance the effect. Returns false once the burst has finished. */
  update(dt: number): boolean {
    if (this.idle || this.disposed) return false;
    this.age += dt;
    const p = Math.min(1, this.age / this.duration);
    const ease = 1 - (1 - p) * (1 - p);
    for (const { mesh, start, travel, tumble, baseRotationZ } of this.fragments) {
      mesh.position.copyFrom(start).addInPlaceFromFloats(travel.x * ease, travel.y * ease, travel.z * ease);
      mesh.rotation.x = tumble.x * ease;
      mesh.rotation.y = tumble.y * ease;
      mesh.rotation.z = baseRotationZ + tumble.z * ease;
      mesh.scaling.setAll(Math.max(0.01, 1 - p * 0.65));
    }
    this.materials[0].alpha = (1 - p) * (1 - p);
    this.materials[1].alpha = this.materials[0].alpha;
    this.flash.scaling.setAll(Math.max(0.01, 1 - p * 2.5));
    this.materials[2].alpha = Math.max(0, 1 - p * 4);

    if (p >= 1) {
      this.park();
      return false;
    }
    return true;
  }

  /** Between bursts: pieces disabled, nothing to advance. */
  private park(): void {
    this.idle = true;
    for (const { mesh } of this.fragments) mesh.setEnabled(false);
    this.flash.setEnabled(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { mesh } of this.fragments) mesh.dispose();
    this.flash.dispose();
    for (const material of this.materials) material.dispose();
  }
}
