import { Constants } from "@babylonjs/core/Engines/constants";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";

/** Sparkles per item, each rising and fading in turn, so about COUNT / LIFE are born a second. */
const COUNT = 16;
/** Seconds a sparkle lives. */
const LIFE_MIN = 2;
const LIFE_MAX = 3.2;
/**
 * In the model's own units (the packaged items are ~1.9 across, drawn ~18x):
 * born just inside its shell, rising this fast, this large at their brightest.
 */
const SHELL_RADIUS = 0.8;
const RISE_MIN = 0.35;
const RISE_MAX = 0.6;
const SIZE_MIN = 0.04;
const SIZE_MAX = 0.08;

/** One soft white dot material per scene, added onto what is behind it. */
const materials = new WeakMap<Scene, StandardMaterial>();

function sparkleMaterial(scene: Scene): StandardMaterial {
  let material = materials.get(scene);
  if (material) return material;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.4, "rgba(255,255,255,0.6)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 32, 32);
  const dot = new Texture(canvas.toDataURL(), scene, false, false);
  dot.hasAlpha = true;
  material = new StandardMaterial("item_sparkle", scene);
  material.disableLighting = true;
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveColor = Color3.White();
  material.opacityTexture = dot;
  material.alphaMode = Constants.ALPHA_ADD;
  material.disableDepthWrite = true;
  material.backFaceCulling = false;
  materials.set(scene, material);
  return material;
}

interface Sparkle {
  mesh: Mesh;
  age: number;
  life: number;
  rise: number;
  size: number;
}

/**
 * Small white sparkles that rise slowly from an item and fade out. Each is a
 * tiny camera-facing quad parented to the item, so they turn and bob with it;
 * they are meshes rather than a particle system so WebGPU snapshot replay
 * moves them like any other mesh. They stop with the item when it is
 * collected or out of view, and are disposed with it.
 */
export class ItemSparkles {
  private readonly sparkles: Sparkle[] = [];
  private readonly observer: Observer<Scene>;
  private last = performance.now();

  constructor(private readonly item: AbstractMesh) {
    const scene = item.getScene();
    const material = sparkleMaterial(scene);
    for (let i = 0; i < COUNT; i++) {
      const mesh = MeshBuilder.CreatePlane(`${item.name}_sparkle_${i}`, { size: 1 }, scene);
      mesh.material = material;
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
      mesh.isPickable = false;
      mesh.parent = item;
      const sparkle = { mesh, age: 0, life: 1, rise: 0, size: 0 };
      this.respawn(sparkle);
      // Spread the first births over a lifetime, so they do not all rise together
      sparkle.age = Math.random() * sparkle.life;
      this.sparkles.push(sparkle);
    }
    this.observer = scene.onBeforeRenderObservable.add(() => this.update());
    item.onDisposeObservable.addOnce(() => this.dispose());
  }

  /** A new sparkle at a random point just inside the item's shell. */
  private respawn(sparkle: Sparkle): void {
    const u = Math.random() * 2 - 1;
    const angle = Math.random() * Math.PI * 2;
    const ring = Math.sqrt(1 - u * u) * SHELL_RADIUS;
    sparkle.mesh.position.set(Math.cos(angle) * ring, u * SHELL_RADIUS, Math.sin(angle) * ring);
    sparkle.age = 0;
    sparkle.life = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
    sparkle.rise = RISE_MIN + Math.random() * (RISE_MAX - RISE_MIN);
    sparkle.size = SIZE_MIN + Math.random() * (SIZE_MAX - SIZE_MIN);
  }

  private update(): void {
    const now = performance.now();
    // Clamped, so a stall or an item coming back into view does not jump them
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!this.item.isEnabled()) return;
    for (const sparkle of this.sparkles) {
      sparkle.age += dt;
      if (sparkle.age >= sparkle.life) this.respawn(sparkle);
      sparkle.mesh.position.y += sparkle.rise * dt;
      // Grow in quickly, then shrink away over the rest of the climb
      const t = sparkle.age / sparkle.life;
      const fade = t < 0.15 ? t / 0.15 : (1 - t) / 0.85;
      sparkle.mesh.scaling.setAll(sparkle.size * fade);
    }
  }

  dispose(): void {
    this.item.getScene().onBeforeRenderObservable.remove(this.observer);
    for (const sparkle of this.sparkles) sparkle.mesh.dispose();
    this.sparkles.length = 0;
  }
}
