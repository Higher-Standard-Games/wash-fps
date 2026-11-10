import { Constants } from "@babylonjs/core/Engines/constants";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import type { Scene } from "@babylonjs/core/scene";

/** Seconds a sparkle lives. */
const LIFE_MIN = 2;
const LIFE_MAX = 3.2;
/** In world units: rising this fast, this large at their brightest. */
const RISE_MIN = 6.3;
const RISE_MAX = 10.8;
const SIZE_MIN = 0.72;
const SIZE_MAX = 1.44;
/** Born just inside the item: this share of its bounding radius. */
const SHELL_SHARE = 0.85;

/** Only items this close to the camera sparkle, and only the nearest few of them. */
const SPARKLE_RANGE = 900;
const MAX_SPARKLING_ITEMS = 8;
/** The most sparkles one item has; more are not made. */
const MAX_SPARKLES_PER_ITEM = 16;
/** Seconds between choosing which items sparkle. */
const CHOOSE_EVERY = 0.25;

/** A soft white dot, added onto what is behind it. */
function createDot(scene: Scene): Mesh {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.4, "rgba(255,255,255,0.6)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 32, 32);
  const texture = new Texture(canvas.toDataURL(), scene, false, false);
  texture.hasAlpha = true;
  const material = new StandardMaterial("item_sparkle", scene);
  material.disableLighting = true;
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveColor = Color3.White();
  material.opacityTexture = texture;
  material.alphaMode = Constants.ALPHA_ADD;
  material.disableDepthWrite = true;
  material.backFaceCulling = false;
  const dot = MeshBuilder.CreatePlane("item_sparkle", { size: 1 }, scene);
  dot.material = material;
  dot.isPickable = false;
  // The sparkles are everywhere the items are, so the dot is never culled as a whole
  dot.alwaysSelectAsActiveMesh = true;
  return dot;
}

interface Sparkle {
  /** Where it is in the item's own space, so it turns and bobs with the item. */
  local: Vector3;
  age: number;
  life: number;
  rise: number;
  size: number;
}

/** The sparkling items of each scene. */
const fields = new WeakMap<Scene, SparkleField>();

/**
 * Every sparkle in a scene, drawn as thin instances of one dot in a single
 * draw call. Each frame writes the live sparkles' camera-facing matrices; only
 * the nearest few drawn items within range of the camera sparkle.
 */
class SparkleField {
  readonly emitters = new Set<ItemSparkles>();
  private readonly dot: Mesh;
  private readonly matrices = new Float32Array(MAX_SPARKLING_ITEMS * MAX_SPARKLES_PER_ITEM * 16);
  private readonly world = new Vector3();
  private readonly camera = new Vector3();
  private last = performance.now();
  private sinceChoice = CHOOSE_EVERY;

  constructor(private readonly scene: Scene) {
    this.dot = createDot(scene);
    this.dot.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
    this.dot.thinInstanceCount = 0;
    const observer = scene.onBeforeRenderObservable.add(() => this.update());
    scene.onDisposeObservable.addOnce(() => scene.onBeforeRenderObservable.remove(observer));
  }

  private update(): void {
    const now = performance.now();
    // Clamped, so a stall or an item coming back into range does not jump them
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.sinceChoice += dt;
    if (this.sinceChoice >= CHOOSE_EVERY) {
      this.sinceChoice = 0;
      this.choose();
    }
    const camera = this.scene.activeCameras?.[0] ?? this.scene.activeCamera;
    if (!camera) return;
    // Every dot faces the camera: its axes are the camera's
    const view = camera.getWorldMatrix().m;
    let count = 0;
    for (const emitter of this.emitters) {
      if (!emitter.active || !emitter.drawn()) continue;
      emitter.advance(dt);
      const item = emitter.item.getWorldMatrix();
      for (const sparkle of emitter.sparkles) {
        Vector3.TransformCoordinatesToRef(sparkle.local, item, this.world);
        // Grow in quickly, then shrink away over the rest of the climb
        const t = sparkle.age / sparkle.life;
        const size = sparkle.size * (t < 0.15 ? t / 0.15 : (1 - t) / 0.85);
        const o = count * 16;
        const m = this.matrices;
        m[o] = view[0] * size;
        m[o + 1] = view[1] * size;
        m[o + 2] = view[2] * size;
        m[o + 3] = 0;
        m[o + 4] = view[4] * size;
        m[o + 5] = view[5] * size;
        m[o + 6] = view[6] * size;
        m[o + 7] = 0;
        m[o + 8] = view[8] * size;
        m[o + 9] = view[9] * size;
        m[o + 10] = view[10] * size;
        m[o + 11] = 0;
        m[o + 12] = this.world.x;
        m[o + 13] = this.world.y;
        m[o + 14] = this.world.z;
        m[o + 15] = 1;
        count++;
      }
    }
    this.dot.thinInstanceCount = count;
    if (count > 0) this.dot.thinInstanceBufferUpdated("matrix");
  }

  /** Let the nearest drawn items within range sparkle, and rest the others. */
  private choose(): void {
    const camera = this.scene.activeCameras?.[0] ?? this.scene.activeCamera;
    if (!camera) return;
    this.camera.copyFrom(camera.globalPosition);
    const near: { emitter: ItemSparkles; distance: number }[] = [];
    for (const emitter of this.emitters) {
      emitter.active = false;
      if (!emitter.drawn()) continue;
      const distance = Vector3.Distance(this.camera, emitter.item.getAbsolutePosition());
      if (distance <= SPARKLE_RANGE) near.push({ emitter, distance });
    }
    near.sort((a, b) => a.distance - b.distance);
    for (const { emitter } of near.slice(0, MAX_SPARKLING_ITEMS)) emitter.active = true;
  }
}

/**
 * Small white sparkles that rise slowly from an item and fade out, turning and
 * bobbing with it. They rest while the item is collected, out of view, out of
 * range or not among the nearest, and stop when it is disposed.
 */
class ItemSparkles {
  readonly sparkles: Sparkle[] = [];
  private readonly shell: number;
  active = false;

  constructor(
    readonly item: AbstractMesh,
    count: number,
  ) {
    this.shell = item.getBoundingInfo().boundingSphere.radius * SHELL_SHARE;
    for (let i = 0; i < Math.min(count, MAX_SPARKLES_PER_ITEM); i++) {
      const sparkle = { local: new Vector3(), age: 0, life: 1, rise: 0, size: 0 };
      this.respawn(sparkle);
      // Spread the first births over a lifetime, so they do not all rise together
      sparkle.age = Math.random() * sparkle.life;
      this.sparkles.push(sparkle);
    }
    const scene = item.getScene();
    let field = fields.get(scene);
    if (!field) {
      field = new SparkleField(scene);
      fields.set(scene, field);
    }
    const emitters = field.emitters;
    emitters.add(this);
    item.onDisposeObservable.addOnce(() => emitters.delete(this));
  }

  /** Whether the item is drawn: in play and in view. */
  drawn(): boolean {
    return this.item.isEnabled() && this.item.isVisible;
  }

  /** A new sparkle at a random point just inside the item. */
  private respawn(sparkle: Sparkle): void {
    const u = Math.random() * 2 - 1;
    const angle = Math.random() * Math.PI * 2;
    const ring = Math.sqrt(1 - u * u) * this.shell;
    sparkle.local.set(Math.cos(angle) * ring, u * this.shell, Math.sin(angle) * ring);
    sparkle.age = 0;
    sparkle.life = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
    sparkle.rise = RISE_MIN + Math.random() * (RISE_MAX - RISE_MIN);
    sparkle.size = SIZE_MIN + Math.random() * (SIZE_MAX - SIZE_MIN);
  }

  advance(dt: number): void {
    // Rise speeds are in world units; the sparkles live in the item's own
    const scale = this.item.scaling.y || 1;
    for (const sparkle of this.sparkles) {
      sparkle.age += dt;
      if (sparkle.age >= sparkle.life) this.respawn(sparkle);
      sparkle.local.y += (sparkle.rise * dt) / scale;
    }
  }
}

/** Let up to 16 sparkles rise from an item while it is among the nearest to the camera. */
export function addItemSparkles(item: AbstractMesh, count: number): void {
  if (count > 0 && !item.isDisposed()) new ItemSparkles(item, count);
}
