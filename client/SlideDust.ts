import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import type { Scene } from "@babylonjs/core/scene";
import { prepareMaterial } from "../../../engine/loader/map/GpuPreparation";
import { CROUCH_MINS_Z } from "../../../engine/physics/PlayerPhysicsConstants";

const CAPACITY = 128;
const RANGE_SQUARED = 1200 * 1200;
const LIFETIME_SCALE = 1.2;
const GRAVITY = 45 / (LIFETIME_SCALE * LIFETIME_SCALE);
type Position = { x: number; y: number; z: number };
interface Emitter extends Position {
  distance: number;
  phase: number;
  seen: number;
}
interface Cube extends Position {
  active: boolean;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  floor: number;
  peak: number;
  size: number;
  rx: number;
  ry: number;
  rz: number;
  spin: number;
}

/** Bounded, unlit ground trails. Emission uses travel; the owner supplies the effect clock. */
export class SlideDust {
  private static readonly pools = new WeakMap<Scene, SlideDust>();

  static emit(scene: Scene, id: string, at: Position, vx: number, vz: number, sliding: boolean): void {
    const pool = SlideDust.pools.get(scene);
    if (!sliding) {
      pool?.emitters.delete(id);
      return;
    }
    if (scene.isDisposed || !Number.isFinite(at.x + at.y + at.z + vx + vz)) return;
    const camera = scene.activeCameras?.[0] ?? scene.activeCamera;
    const eye = camera?.globalPosition;
    if (eye && (at.x - eye.x) ** 2 + (at.y - eye.y) ** 2 + (at.z - eye.z) ** 2 > RANGE_SQUARED) {
      pool?.emitters.delete(id);
      return;
    }
    const speed = Math.hypot(vx, vz);
    if (speed < 80) {
      pool?.emitters.delete(id);
      return;
    }
    const dust = pool ?? new SlideDust(scene);
    dust.trace(id, at, vx / speed, vz / speed, Math.max(18, speed / 16));
  }

  /** Create and compile the fixed instanced layout while the map is loading. */
  static async prepare(scene: Scene, signal?: AbortSignal): Promise<void> {
    const dust = SlideDust.pools.get(scene) ?? new SlideDust(scene);
    dust.mesh.thinInstanceCount = 1;
    try {
      await prepareMaterial(dust.material, dust.mesh, signal);
      dust.material.freeze();
    } finally {
      if (!dust.disposed) {
        dust.mesh.thinInstanceCount = 1;
        dust.mesh.setEnabled(false);
      }
    }
  }

  static step(scene: Scene | null | undefined, seconds: number): void {
    if (scene) SlideDust.pools.get(scene)?.advance(seconds);
  }
  static flush(scene: Scene | null | undefined): void {
    if (scene) SlideDust.pools.get(scene)?.upload();
  }
  static reset(scene: Scene | null | undefined): void {
    const dust = scene ? SlideDust.pools.get(scene) : undefined;
    if (!dust) return;
    for (const cube of dust.cubes) cube.active = false;
    dust.emitters.clear();
    dust.dirty = true;
    dust.upload();
  }
  static clear(scene: Scene | null | undefined): void {
    if (scene) SlideDust.pools.get(scene)?.dispose();
  }

  private readonly mesh: Mesh;
  private readonly material: StandardMaterial;
  private readonly matrices = new Float32Array(CAPACITY * 16);
  private readonly colors = new Float32Array(CAPACITY * 4).fill(1);
  private readonly cubes: Cube[] = Array.from({ length: CAPACITY }, () => ({
    active: false,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    age: 0,
    life: 1,
    floor: 0,
    peak: 0,
    size: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    spin: 0,
  }));
  private readonly emitters = new Map<string, Emitter>();
  private readonly rotation = new Quaternion();
  private readonly scaling = new Vector3();
  private readonly position = new Vector3();
  private readonly matrix = Matrix.Identity();
  private readonly removeLayerObserver: () => void;
  private readonly removeMeshObserver: () => void;
  private elapsed = 0;
  private cursor = 0;
  private dirty = false;
  private disposed = false;

  private constructor(private readonly scene: Scene) {
    this.mesh = CreateBox(
      "slide-dust",
      { size: 1, faceColors: [0.8, 0.6, 0.7, 0.5, 0.85, 0.55].map((shade) => new Color4(shade, shade, shade, 1)) },
      scene,
    );
    this.mesh.metadata = { mapOwned: true };
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.hasVertexAlpha = true;
    this.material = new StandardMaterial("slide-dust", scene);
    this.material.disableLighting = true;
    this.material.fogEnabled = false;
    this.material.emissiveColor = new Color3(0.7, 0.7, 0.7);
    this.material.specularColor = Color3.Black();
    this.material.alpha = 0.999;
    this.mesh.material = this.material;
    this.mesh.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
    this.mesh.thinInstanceSetBuffer("color", this.colors, 4, false);
    // Readiness checks need the instanced layout even while the batch is disabled.
    this.mesh.thinInstanceCount = 1;
    this.mesh.setEnabled(false);
    const excludeGlow = (layer: Scene["effectLayers"][number]) => {
      if (layer.getClassName() === "GlowLayer") (layer as GlowLayer).addExcludedMesh(this.mesh);
    };
    for (const layer of scene.effectLayers ?? []) excludeGlow(layer);
    const layerObserver = scene.onNewEffectLayerAddedObservable.add(excludeGlow);
    this.removeLayerObserver = () => scene.onNewEffectLayerAddedObservable.remove(layerObserver);
    const meshObserver = this.mesh.onDisposeObservable.addOnce(() => this.dispose(true));
    this.removeMeshObserver = () => this.mesh.onDisposeObservable.remove(meshObserver);
    SlideDust.pools.set(scene, this);
  }

  private trace(id: string, at: Position, dx: number, dz: number, spacing: number): void {
    const last = this.emitters.get(id);
    if (!last) {
      this.emitters.set(id, { ...at, distance: 0, phase: 0, seen: this.elapsed });
      return;
    }
    const travel = Math.hypot(at.x - last.x, at.z - last.z);
    if (travel > 160 || Math.abs(at.y - last.y) > 32) last.distance = 0;
    else {
      last.distance += travel;
      let pairs = 0;
      while (last.distance >= spacing && pairs++ < 2) {
        last.distance -= spacing;
        const t = travel > 0 ? Math.max(0, 1 - last.distance / travel) : 1;
        const x = last.x + (at.x - last.x) * t - dx * 4;
        const y = last.y + (at.y - last.y) * t + CROUCH_MINS_Z;
        const z = last.z + (at.z - last.z) * t - dz * 4;
        const spread = 2 + Math.sin(last.phase) * 0.75;
        this.spawn(x + dz * spread, y, z - dx * spread, dz, -dx);
        this.spawn(x - dz * spread, y, z + dx * spread, -dz, dx);
        last.phase += 0.7;
      }
      last.distance = Math.min(last.distance, spacing - 0.0001);
    }
    last.x = at.x;
    last.y = at.y;
    last.z = at.z;
    last.seen = this.elapsed;
  }

  private spawn(x: number, floor: number, z: number, sideX: number, sideZ: number): void {
    let cube: Cube | undefined;
    for (let i = 0; i < CAPACITY; i++) {
      const candidate = this.cubes[this.cursor++ % CAPACITY];
      if (!candidate.active) {
        cube = candidate;
        break;
      }
    }
    if (!cube) return;
    cube.active = true;
    cube.x = x;
    cube.y = floor + 4;
    cube.z = z;
    cube.floor = floor;
    cube.vx = sideX * (10 + Math.random() * 6);
    cube.vz = sideZ * (10 + Math.random() * 6);
    cube.vy = (12 + Math.random() * 8) / LIFETIME_SCALE;
    cube.peak = cube.vy / GRAVITY;
    cube.age = 0;
    cube.life = (0.8 + Math.random() * 0.2) * LIFETIME_SCALE;
    cube.size = 3 + Math.random() * 2;
    cube.rx = Math.random() * 3;
    cube.ry = Math.random() * 3;
    cube.rz = Math.random() * 3;
    cube.spin = (Math.random() - 0.5) * 2;
    this.dirty = true;
  }

  private advance(seconds: number): void {
    const dt = Math.min(0.1, Math.max(0, Number.isFinite(seconds) ? seconds : 0));
    if (dt === 0) return;
    this.elapsed += dt;
    for (const [id, emitter] of this.emitters) if (this.elapsed - emitter.seen > 0.25) this.emitters.delete(id);
    for (const cube of this.cubes) {
      if (!cube.active) continue;
      this.dirty = true;
      cube.age += dt;
      if (cube.age >= cube.life || cube.y <= cube.floor) {
        cube.active = false;
        continue;
      }
      cube.x += cube.vx * dt;
      cube.z += cube.vz * dt;
      cube.y += cube.vy * dt - GRAVITY * dt * dt * 0.5;
      cube.vy -= GRAVITY * dt;
      cube.rx += cube.spin * dt;
      cube.ry += cube.spin * dt * 0.7;
    }
  }

  private upload(): void {
    if (!this.dirty || this.disposed) return;
    this.dirty = false;
    let count = 0;
    for (const cube of this.cubes) {
      if (!cube.active) continue;
      const falling = Math.max(0, (cube.age - cube.peak) / (cube.life - cube.peak));
      const fade = 1 - Math.min(1, falling) ** 2 * (3 - 2 * Math.min(1, falling));
      this.colors[count * 4 + 3] =
        0.6 *
        Math.min(1, cube.age / 0.06) *
        fade *
        (cube.vy < 0 ? Math.max(0, Math.min(1, (cube.y - cube.floor) / 5)) : 1);
      this.scaling.setAll(cube.size * (1 - falling * 0.6));
      this.position.set(cube.x, cube.y, cube.z);
      Quaternion.RotationYawPitchRollToRef(cube.ry, cube.rx, cube.rz, this.rotation);
      Matrix.ComposeToRef(this.scaling, this.rotation, this.position, this.matrix);
      this.matrix.copyToArray(this.matrices, count++ * 16);
    }
    // One disabled instance keeps INSTANCESCOLOR paired with INSTANCES during scene readiness checks.
    this.mesh.thinInstanceCount = Math.max(1, count);
    if (this.mesh.isEnabled() !== count > 0) this.mesh.setEnabled(count > 0);
    if (count) {
      this.mesh.thinInstancePartialBufferUpdate("matrix", count, 0);
      this.mesh.thinInstancePartialBufferUpdate("color", count, 0);
    }
  }

  private dispose(fromMesh = false): void {
    if (this.disposed) return;
    this.disposed = true;
    SlideDust.pools.delete(this.scene);
    this.removeLayerObserver();
    this.removeMeshObserver();
    for (const layer of this.scene.effectLayers ?? []) {
      if (layer.getClassName() === "GlowLayer") (layer as GlowLayer).removeExcludedMesh(this.mesh);
    }
    if (!fromMesh) this.mesh.dispose();
    this.material.dispose();
  }
}
