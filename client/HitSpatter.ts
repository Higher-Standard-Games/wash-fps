/**
 * HitSpatter — what a hit knocks out of a body: blood, or sparks off a robot.
 *
 * A hit sprays tiny pieces from where it landed (the head, the body or the
 * legs), away from the shooter, as many as the hit was hard: red cubes from a
 * person, orange and yellow triangles from a robot. A headshot sprays more,
 * with a short puff at the head. Blood that reaches the floor leaves a few flat
 * splats there for a few seconds (`cl_blood_splats 0` turns them off).
 *
 * Kept cheap: every piece of one colour is a thin instance of one mesh, so the
 * whole effect is a handful of draws however much flies. Pieces shrink away
 * rather than fade, so nothing blends; the floor comes from one trace per hit,
 * not one per piece; and there is a fixed cap on pieces and splats, the oldest
 * giving way when it is reached.
 */

import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBoxVertexData } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import type { Scene } from "@babylonjs/core/scene";
import { Cvar } from "../../../engine/core/Cvar";
import { prepareMaterial } from "../../../engine/loader/map/GpuPreparation";
import { getCollisionManager } from "../../../engine/physics/CollisionManager";
import { CollisionMasks } from "../../../engine/physics/ContentFlags";
import { scaledBodyHeight } from "../shared/BodyScale";

Cvar.register("cl_blood_splats", 1, {
  type: "int",
  min: 0,
  max: 1,
  persist: true,
  description: "Blood leaves splats on the floor where it lands (0 = off, 1 = on)",
});

/** Where a hit landed, as the damage event names it. */
export type HitZone = "head" | "body" | "legs";

/** Height above a player's origin each zone is hit at, on a normal body. */
const ZONE_HEIGHT: Record<HitZone, number> = { head: 30, body: 8, legs: -14 };

/** Most pieces in the air at once; a new hit takes the oldest's place. */
const MAX_PIECES = 256;
/** Most splats on the floor at once. */
const MAX_SPLATS = 48;
/** How long a splat lies, and over how much of its end it shrinks away (seconds). */
const SPLAT_LIFE = 6;
const SPLAT_SHRINK = 1.5;
/** How far below a hit the floor is looked for. */
const FLOOR_REACH = 256;
const FLOOR_TRACE = { radius: 0, height: 0, contentMask: CollisionMasks.SHOT };

/** The colours, one mesh each: two of blood, two of sparks, and the splat. */
enum Shade {
  Blood,
  DarkBlood,
  Orange,
  Yellow,
}
const SHADES: { name: string; color: Color3; shape: "cube" | "shard" }[] = [
  { name: "blood", color: new Color3(0.72, 0.03, 0.04), shape: "cube" },
  { name: "darkblood", color: new Color3(0.42, 0.01, 0.02), shape: "cube" },
  { name: "orange", color: new Color3(1, 0.5, 0.08), shape: "shard" },
  { name: "yellow", color: new Color3(1, 0.86, 0.22), shape: "shard" },
];
const SPLAT_COLOR = new Color3(0.36, 0.01, 0.02);

interface Piece {
  alive: boolean;
  shade: Shade;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  age: number;
  life: number;
  size: number;
  spin: number;
  /** The floor under its hit, or -Infinity when none was found. */
  floor: number;
  /** Leaves a splat where it lands. */
  splats: boolean;
}

interface Splat {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  size: number;
  turn: number;
  age: number;
}

interface Batch {
  mesh: Mesh;
  matrices: Float32Array;
  count: number;
}

const random = (min: number, max: number) => min + Math.random() * (max - min);

export class HitSpatter {
  private static instance: HitSpatter | null = null;
  private scene: Scene | null = null;
  private readonly pieces: Piece[] = [];
  private readonly splats: Splat[] = [];
  private nextPiece = 0;
  private nextSplat = 0;
  private batches: Batch[] = [];
  private splatBatch: Batch | null = null;
  private materials: StandardMaterial[] = [];
  // Scratch for posing, so a frame allocates nothing
  private readonly pose = new Matrix();
  private readonly poseScale = new Vector3();
  private readonly poseTurn = new Quaternion();
  private readonly posePosition = new Vector3();
  private readonly from = new Vector3();
  private readonly to = new Vector3();

  static getInstance(): HitSpatter {
    HitSpatter.instance ??= new HitSpatter();
    return HitSpatter.instance;
  }

  /** Create an independently-owned instance for demo playback, run by the demo's clock. */
  static create(scene: Scene): HitSpatter {
    const system = new HitSpatter();
    system.init(scene);
    return system;
  }

  isInitialized(): boolean {
    return this.scene !== null && !this.scene.isDisposed;
  }

  /** Build the meshes in `scene`; nothing to do when they are there already. */
  init(scene: Scene): void {
    if (this.scene === scene && !scene.isDisposed) return;
    this.disposeMeshes();
    this.scene = scene;
    this.batches = SHADES.map((shade) => this.createBatch(shade.name, shade.color, shade.shape, MAX_PIECES));
    this.splatBatch = this.createBatch("splat", SPLAT_COLOR, "splat", MAX_SPLATS);
  }

  /**
   * A hit on a player at `origin` (their position) in `zone`. `away` points
   * from the shooter to the player, so the pieces fly on the way the shot went;
   * null sprays them any way. `scale` is the body's size (a campaign boss is
   * bigger), and `robot` makes sparks instead of blood.
   */
  spawn(
    origin: { x: number; y: number; z: number },
    zone: HitZone,
    damage: number,
    away: { x: number; z: number } | null,
    robot: boolean,
    scale = 1,
  ): void {
    if (!this.isInitialized() || damage <= 0) return;
    const x = origin.x;
    const y = origin.y + scaledBodyHeight(ZONE_HEIGHT[zone], scale);
    const z = origin.z;
    // Unit direction away from the shooter; any way at all without one
    let dx = away?.x ?? 0;
    let dz = away?.z ?? 0;
    const length = Math.hypot(dx, dz);
    if (length < 1e-3) {
      const turn = Math.random() * Math.PI * 2;
      dx = Math.cos(turn);
      dz = Math.sin(turn);
    } else {
      dx /= length;
      dz /= length;
    }

    const headshot = zone === "head";
    let count = Math.max(3, Math.min(14, Math.round(2 + damage / 5)));
    if (headshot) count = Math.round(count * 1.5);
    const floor = this.floorUnder(x, y, z);
    const splatting = !robot && floor > -Infinity && Cvar.getBool("cl_blood_splats");
    let splatsLeft = splatting ? Math.min(3, Math.ceil(count / 4)) : 0;

    for (let i = 0; i < count; i++) {
      const speed = robot ? random(160, 380) : random(90, 240);
      const side = random(-1, 1) * (robot ? 160 : 110);
      const piece = this.takePiece();
      piece.shade = robot ? (i % 2 ? Shade.Yellow : Shade.Orange) : i % 3 ? Shade.Blood : Shade.DarkBlood;
      piece.x = x;
      piece.y = y;
      piece.z = z;
      // Along the shot, out to either side, and up
      piece.vx = dx * speed - dz * side;
      piece.vz = dz * speed + dx * side;
      piece.vy = robot ? random(60, 260) : random(40, 220);
      piece.gravity = robot ? -450 : -800;
      piece.age = 0;
      piece.life = robot ? random(0.2, 0.4) : random(0.45, 0.75);
      piece.size = (robot ? random(2.2, 3.6) : random(1.2, 2.4)) * scale;
      piece.spin = random(-12, 12);
      piece.floor = floor;
      piece.splats = splatsLeft > 0;
      if (piece.splats) splatsLeft--;
    }

    // A headshot puffs: a few big, slow pieces that are gone almost at once
    if (headshot) {
      for (let i = 0; i < 5; i++) {
        const piece = this.takePiece();
        const turn = Math.random() * Math.PI * 2;
        const speed = random(20, 60);
        piece.shade = robot ? Shade.Yellow : Shade.Blood;
        piece.x = x;
        piece.y = y;
        piece.z = z;
        piece.vx = Math.cos(turn) * speed;
        piece.vz = Math.sin(turn) * speed;
        piece.vy = random(10, 50);
        piece.gravity = 0;
        piece.age = 0;
        piece.life = 0.22;
        piece.size = (robot ? random(5, 7) : random(4, 5.5)) * scale;
        piece.spin = random(-4, 4);
        piece.floor = -Infinity;
        piece.splats = false;
      }
    }
  }

  /** Move every piece on by `dt` seconds, splat what lands, and draw. */
  update(dt: number): void {
    if (!this.isInitialized()) return;
    const step = Math.max(0, dt);
    for (const piece of this.pieces) {
      if (!piece.alive) continue;
      piece.age += step;
      if (piece.age >= piece.life) {
        piece.alive = false;
        continue;
      }
      piece.vy += piece.gravity * step;
      const nextY = piece.y + piece.vy * step;
      // Landed: blood that leaves a mark marks the floor; nothing falls through it
      if (piece.vy < 0 && nextY <= piece.floor) {
        if (piece.splats) this.addSplat(piece.x, piece.floor, piece.z, piece.size);
        piece.alive = false;
        continue;
      }
      piece.x += piece.vx * step;
      piece.y = nextY;
      piece.z += piece.vz * step;
    }
    for (const splat of this.splats) {
      if (!splat.alive) continue;
      splat.age += step;
      if (splat.age >= SPLAT_LIFE) splat.alive = false;
    }
    this.draw();
  }

  /** Take every piece and splat away (a seek, a new map). */
  clear(): void {
    for (const piece of this.pieces) piece.alive = false;
    for (const splat of this.splats) splat.alive = false;
    this.draw();
  }

  /** Compile the shaders before the first hit, so it does not hitch. */
  async prepareShaders(signal?: AbortSignal): Promise<void> {
    for (const batch of [...this.batches, ...(this.splatBatch ? [this.splatBatch] : [])]) {
      batch.mesh.thinInstanceCount = 1;
      try {
        await prepareMaterial(batch.mesh.material!, batch.mesh, signal);
      } finally {
        batch.mesh.thinInstanceCount = batch.count;
      }
    }
  }

  dispose(): void {
    this.disposeMeshes();
    this.scene = null;
    if (HitSpatter.instance === this) HitSpatter.instance = null;
  }

  // ── Pieces ──────────────────────────────────────────────────────────

  /** A free piece, or the oldest one when all are flying. */
  private takePiece(): Piece {
    if (this.pieces.length < MAX_PIECES) {
      const piece = { alive: true } as Piece;
      this.pieces.push(piece);
      return piece;
    }
    for (let i = 0; i < MAX_PIECES; i++) {
      const piece = this.pieces[(this.nextPiece + i) % MAX_PIECES];
      if (!piece.alive) {
        piece.alive = true;
        return piece;
      }
    }
    const piece = this.pieces[this.nextPiece];
    this.nextPiece = (this.nextPiece + 1) % MAX_PIECES;
    piece.alive = true;
    return piece;
  }

  private addSplat(x: number, y: number, z: number, size: number): void {
    let splat: Splat;
    if (this.splats.length < MAX_SPLATS) {
      splat = {} as Splat;
      this.splats.push(splat);
    } else {
      splat = this.splats[this.nextSplat];
      this.nextSplat = (this.nextSplat + 1) % MAX_SPLATS;
    }
    splat.alive = true;
    splat.x = x;
    // Just above the floor, so it does not flicker into it
    splat.y = y + 0.4;
    splat.z = z;
    splat.size = size * random(2.5, 4.5);
    splat.turn = Math.random() * Math.PI;
    splat.age = 0;
  }

  /** The floor straight under a hit: one trace, shared by all its pieces. */
  private floorUnder(x: number, y: number, z: number): number {
    const collision = getCollisionManager();
    if (!collision.isInitialized()) return -Infinity;
    const trace = collision.trace(this.from.set(x, y, z), this.to.set(x, y - FLOOR_REACH, z), FLOOR_TRACE);
    if (trace.startSolid || trace.fraction >= 1) return -Infinity;
    return trace.endPos.y;
  }

  // ── Drawing ─────────────────────────────────────────────────────────

  private draw(): void {
    for (const batch of this.batches) batch.count = 0;
    for (const piece of this.pieces) {
      if (!piece.alive) continue;
      const batch = this.batches[piece.shade];
      // Shrinks away over its life
      const size = piece.size * Math.sqrt(1 - piece.age / piece.life);
      const turn = piece.spin * piece.age;
      Quaternion.RotationYawPitchRollToRef(turn, turn * 0.7, turn * 0.3, this.poseTurn);
      this.poseScale.setAll(size);
      this.posePosition.set(piece.x, piece.y, piece.z);
      Matrix.ComposeToRef(this.poseScale, this.poseTurn, this.posePosition, this.pose);
      this.pose.copyToArray(batch.matrices, batch.count * 16);
      batch.count++;
    }
    const splats = this.splatBatch;
    if (splats) {
      splats.count = 0;
      for (const splat of this.splats) {
        if (!splat.alive) continue;
        // Spreads out at once, then shrinks away at the end
        const grow = Math.min(1, splat.age / 0.08);
        const shrink = Math.min(1, (SPLAT_LIFE - splat.age) / SPLAT_SHRINK);
        Quaternion.RotationYawPitchRollToRef(splat.turn, 0, 0, this.poseTurn);
        this.poseScale.set(splat.size * grow * shrink, 1, splat.size * grow * shrink);
        this.posePosition.set(splat.x, splat.y, splat.z);
        Matrix.ComposeToRef(this.poseScale, this.poseTurn, this.posePosition, this.pose);
        this.pose.copyToArray(splats.matrices, splats.count * 16);
        splats.count++;
      }
    }
    for (const batch of [...this.batches, ...(splats ? [splats] : [])]) {
      const mesh = batch.mesh;
      if (batch.count === 0) {
        if (mesh.isEnabled()) {
          mesh.thinInstanceCount = 0;
          mesh.setEnabled(false);
        }
        continue;
      }
      mesh.thinInstanceCount = batch.count;
      mesh.thinInstancePartialBufferUpdate("matrix", batch.count, 0);
      if (!mesh.isEnabled()) mesh.setEnabled(true);
    }
  }

  private createBatch(name: string, color: Color3, shape: "cube" | "shard" | "splat", capacity: number): Batch {
    const scene = this.scene!;
    const mesh = new Mesh(`hitspatter_${name}`, scene);
    shapeData(shape).applyToMesh(mesh);
    const material = new StandardMaterial(`hitspatter_${name}`, scene);
    // Its own colour in any light: no lights to compute, nothing to blend
    material.disableLighting = true;
    material.emissiveColor = color;
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.backFaceCulling = false;
    this.materials.push(material);
    mesh.material = material;
    mesh.isPickable = false;
    // Pieces spread across the room: one piece's bounds would cull the rest
    mesh.alwaysSelectAsActiveMesh = true;
    const matrices = new Float32Array(capacity * 16);
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
    mesh.thinInstanceCount = 0;
    mesh.setEnabled(false);
    return { mesh, matrices, count: 0 };
  }

  private disposeMeshes(): void {
    for (const batch of [...this.batches, ...(this.splatBatch ? [this.splatBatch] : [])]) batch.mesh.dispose();
    for (const material of this.materials) material.dispose();
    this.batches = [];
    this.splatBatch = null;
    this.materials = [];
    this.pieces.length = 0;
    this.splats.length = 0;
  }
}

/** A unit cube, a spark shard (a flat triangle seen from both sides), or a flat square splat. */
function shapeData(shape: "cube" | "shard" | "splat"): VertexData {
  if (shape === "cube") return CreateBoxVertexData({ size: 1 });
  const data = new VertexData();
  if (shape === "shard") {
    data.positions = [0, 0.7, 0, -0.5, -0.35, 0, 0.5, -0.35, 0];
    data.indices = [0, 1, 2];
    data.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
    return data;
  }
  // Lying flat, facing up
  data.positions = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5];
  data.indices = [0, 2, 1, 0, 3, 2];
  data.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  return data;
}
