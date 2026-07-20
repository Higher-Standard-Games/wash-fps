/**
 * ProceduralPickupVisual — the runtime, per-pickup procedural sculpture
 * (docs/research/PROCEDURAL_ITEMS.md §"Cosmetic State Machine" + §"Health/Armor
 * recipes"). Implements the engine `PickupVisual` contract: a fixed anchor with
 * an animated cosmetic root and a fixed floor pedestal, assembled by cloning
 * scene-cached prototype geometry and driving it from an elapsed clock.
 *
 * Ownership: this visual disposes its own clones, its 3 private energy materials,
 * and any in-flight collection transient. The shared prototype geometry and
 * structural material are owned by the scene-scoped asset cache and outlive it.
 *
 * Motion is computed from `elapsed` (+ a per-pickup seed phase), never from
 * accumulated frame rotations, so it is frame-rate independent and drift-free.
 */

import type { Material } from "@babylonjs/core/Materials/material";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { PickupVisual } from "../../../../../engine/world/PickupVisual";
import { getPrototypeSet } from "./ProceduralPickupAssetCache";
import { baseEmissive, cloneEnergyMaterial } from "./ProceduralPickupMaterials";
import { ProceduralPickupTransient } from "./ProceduralPickupTransient";
import type { ProceduralPickupRecipe } from "./types";

const TAU = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

// The pickup anchor sits `dropToGround` +12u above the floor; place the floor
// pedestal just above the actual floor (≈1.5u to avoid z-fighting).
const FLOOR_BELOW_ANCHOR = 12;
const FLOOR_PAD = 1.5;
const FLOOR_Y = -(FLOOR_BELOW_ANCHOR - FLOOR_PAD);
const BEACON_HEIGHT = 90;

interface RingEl {
  pivot: TransformNode;
  speed: number;
}
interface PlateEl {
  pivot: TransformNode;
  mesh: Mesh;
  baseAngle: number;
  radius: number;
}
interface PetalEl {
  pivot: TransformNode;
  baseAngle: number;
}
interface MoteEl {
  mesh: Mesh;
  phase: number;
  baseY: number;
  range: number;
}
interface SatEl {
  pivot: TransformNode;
  baseAngle: number;
  speed: number;
}

export class ProceduralPickupVisual implements PickupVisual {
  readonly root: TransformNode;
  private readonly cosmetic: TransformNode;
  private readonly floor: TransformNode;
  private readonly scene: Scene;
  private readonly recipe: ProceduralPickupRecipe;
  private readonly phase: number;

  private readonly matCore: StandardMaterial;
  private readonly matAccent: StandardMaterial;
  private readonly matSoft: StandardMaterial;
  private readonly coreBase: Color3;
  private readonly accentBase: Color3;
  private readonly softBase: Color3;

  private readonly rings: RingEl[] = [];
  private readonly plates: PlateEl[] = [];
  private readonly petals: PetalEl[] = [];
  private readonly motes: MoteEl[] = [];
  private readonly satellites: SatEl[] = [];
  private readonly transients: ProceduralPickupTransient[] = [];

  private prevActive: boolean | null = null;
  private visible = false;
  private assembleAge = Number.POSITIVE_INFINITY;
  private readonly assembleDuration: number;
  private disposed = false;

  constructor(scene: Scene, recipe: ProceduralPickupRecipe, position: Vector3, startHidden: boolean, seed: number) {
    this.scene = scene;
    this.recipe = recipe;
    this.phase = (seed % 997) * 0.618; // golden-ratio spread so items desync
    this.assembleDuration = recipe.highTier ? 0.7 : 0.45;

    const set = getPrototypeSet(scene, recipe);
    this.matCore = cloneEnergyMaterial(set.energyCore, `pp_core_${recipe.id}_${seed}`);
    this.matAccent = cloneEnergyMaterial(set.energyAccent, `pp_accent_${recipe.id}_${seed}`);
    this.matSoft = cloneEnergyMaterial(set.energySoft, `pp_soft_${recipe.id}_${seed}`);
    this.coreBase = baseEmissive(this.matCore).clone();
    this.accentBase = baseEmissive(this.matAccent).clone();
    this.softBase = baseEmissive(this.matSoft).clone();

    this.root = new TransformNode(`pp_anchor_${recipe.id}_${seed}`, scene);
    this.root.position.copyFrom(position);
    this.cosmetic = new TransformNode(`pp_cosmetic_${recipe.id}_${seed}`, scene);
    this.cosmetic.parent = this.root;
    this.floor = new TransformNode(`pp_floor_${recipe.id}_${seed}`, scene);
    this.floor.parent = this.root;
    this.floor.position.y = FLOOR_Y;

    const s = recipe.scale;

    // ── Central symbol + core shell ────────────────────────────────
    if (recipe.family === "health") {
      this.inst(set.cross, this.cosmetic, this.matCore, "sym");
      this.inst(set.core, this.cosmetic, this.matSoft, "coreshell");
    } else {
      this.inst(set.hexCore, this.cosmetic, this.matCore, "hex");
    }

    // ── Rings ──────────────────────────────────────────────────────
    for (let i = 0; i < recipe.ringCount; i++) {
      const pivot = new TransformNode(`pp_ringpivot_${i}`, scene);
      pivot.parent = this.cosmetic;
      const ring = this.inst(set.ring, pivot, this.matAccent, `ring_${i}`);
      if (ring) ring.rotation.x = 0.35 + i * 0.55; // tilt so the spin reads
      const dir = i % 2 === 0 ? 1 : -1;
      this.rings.push({ pivot, speed: recipe.spinSpeed * DEG2RAD * (0.8 + i * 0.3) * dir });
    }

    // ── Armor plates (assembling shield cage) ──────────────────────
    for (let i = 0; i < recipe.plateCount; i++) {
      const pivot = new TransformNode(`pp_platepivot_${i}`, scene);
      pivot.parent = this.cosmetic;
      const baseAngle = (i / recipe.plateCount) * TAU;
      const radius = 13 * s;
      const mesh = this.inst(set.plate, pivot, set.structural, `plate_${i}`);
      if (mesh) {
        mesh.position.set(radius, 0, 0);
        mesh.rotation.y = Math.PI / 2; // flat face points radially outward
      }
      if (mesh) this.plates.push({ pivot, mesh, baseAngle, radius });
    }

    // ── Health corona petals ───────────────────────────────────────
    for (let i = 0; i < recipe.shellPieces; i++) {
      const pivot = new TransformNode(`pp_petalpivot_${i}`, scene);
      pivot.parent = this.cosmetic;
      const baseAngle = (i / recipe.shellPieces) * TAU;
      pivot.rotation.y = baseAngle;
      const petal = this.inst(set.petal, pivot, this.matAccent, `petal_${i}`);
      if (petal) {
        petal.position.set(12 * s, 0, 0);
        petal.rotation.z = Math.PI / 2; // lie tangential around the core
      }
      this.petals.push({ pivot, baseAngle });
    }

    // ── Rising motes ───────────────────────────────────────────────
    for (let i = 0; i < recipe.moteCount; i++) {
      const mesh = this.inst(set.mote, this.cosmetic, this.matCore, `mote_${i}`);
      if (!mesh) continue;
      const angle = (i / Math.max(1, recipe.moteCount)) * TAU;
      const r = (6 + (i % 3) * 3) * s;
      mesh.position.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
      this.motes.push({ mesh, phase: i / Math.max(1, recipe.moteCount), baseY: -10 * s, range: 26 * s });
    }

    // ── Orbiting satellites ────────────────────────────────────────
    for (let i = 0; i < recipe.satelliteCount; i++) {
      const pivot = new TransformNode(`pp_satpivot_${i}`, scene);
      pivot.parent = this.cosmetic;
      pivot.rotation.x = 0.4 + i * 0.2;
      const baseAngle = (i / recipe.satelliteCount) * TAU;
      const sat = this.inst(set.satellite, pivot, this.matCore, `sat_${i}`);
      if (sat) sat.position.set(22 * s, 0, 0);
      this.satellites.push({ pivot, baseAngle, speed: recipe.spinSpeed * DEG2RAD * 1.6 });
    }

    // ── Floor pedestal ─────────────────────────────────────────────
    this.inst(set.floorDisc, this.floor, this.matSoft, "floordisc");
    this.inst(set.floorRing, this.floor, this.matAccent, "floorring");
    this.inst(set.glyph, this.floor, this.matCore, "glyph");
    if (set.beacon) {
      const beacon = this.inst(set.beacon, this.floor, this.matSoft, "beacon");
      if (beacon) beacon.position.y = FLOOR_Y * -1 + BEACON_HEIGHT / 2 - FLOOR_PAD;
    }

    // Fail-closed initial visibility WITHOUT committing prevActive, so the first
    // server reconcile is treated as the initial (silent) state, not a respawn.
    this.applyVisible(!startHidden);
  }

  /** Clone a prototype into `parent` with a material; enabled + visible. */
  private inst(proto: Mesh | null, parent: TransformNode, material: Material, name: string): Mesh | null {
    if (!proto) return null;
    const m = proto.clone(`pp_${name}_${this.recipe.id}`);
    m.parent = parent;
    m.position.setAll(0);
    m.rotation.setAll(0);
    m.scaling.setAll(1);
    m.rotationQuaternion = null;
    m.material = material;
    m.isPickable = false;
    m.isVisible = true;
    m.setEnabled(true);
    return m;
  }

  private applyVisible(v: boolean): void {
    this.visible = v;
    this.cosmetic.setEnabled(v);
    this.floor.setEnabled(v);
  }

  setActive(active: boolean): void {
    if (this.disposed) return;
    if (this.prevActive === null) {
      // First authoritative value — apply silently (no collect/respawn burst).
      this.prevActive = active;
      this.applyVisible(active);
      return;
    }
    if (active === this.prevActive) return;
    this.prevActive = active;
    if (active) {
      this.applyVisible(true);
      this.assembleAge = 0; // trigger respawn assembly
    } else {
      this.spawnCollectTransient();
      this.applyVisible(false);
    }
  }

  private spawnCollectTransient(): void {
    const t = new ProceduralPickupTransient(
      this.scene,
      this.root,
      new Color3(this.recipe.color.r, this.recipe.color.g, this.recipe.color.b),
      {
        duration: this.recipe.highTier ? 0.42 : 0.28,
        endDiameter: 44 * this.recipe.scale * 1.7,
        style: this.recipe.collectStyle,
        scale: this.recipe.scale,
      },
    );
    this.transients.push(t);
  }

  update(dt: number, elapsed: number): void {
    if (this.disposed) return;

    // Transients run even while the persistent visual is hidden (they're
    // parented to the always-enabled anchor).
    if (this.transients.length > 0) {
      for (let i = this.transients.length - 1; i >= 0; i--) {
        if (!this.transients[i].update(dt)) this.transients.splice(i, 1);
      }
    }

    if (!this.visible) return;

    const t = elapsed + this.phase;
    const r = this.recipe;

    // Respawn assembly: scale in from 0.35 → 1 with an ease-out.
    let assembleScale = 1;
    if (this.assembleAge < this.assembleDuration) {
      this.assembleAge += dt;
      const p = Math.min(1, this.assembleAge / this.assembleDuration);
      assembleScale = 0.35 + 0.65 * (1 - (1 - p) * (1 - p));
    }

    // Bob (+ figure-eight for health) and yaw spin.
    const bobW = t * r.bobFrequency * TAU;
    this.cosmetic.position.y = Math.sin(bobW) * r.bobAmplitude;
    this.cosmetic.position.x = r.figureEight ? Math.sin(bobW * 2) * r.bobAmplitude * 0.35 : 0;
    this.cosmetic.rotation.y = t * r.spinSpeed * DEG2RAD;

    // Breathing + assembly scale.
    const breathe = 1 + 0.02 * Math.sin(t * r.pulseFrequency * TAU);
    this.cosmetic.scaling.setAll(assembleScale * breathe);

    // Emissive pulse (heartbeat double-beat for high tier; flicker for unstable).
    const pulseW = t * r.pulseFrequency * TAU;
    let pulse = 0.72 + 0.28 * Math.sin(pulseW);
    if (r.highTier) pulse += 0.15 * Math.max(0, Math.sin(pulseW * 2));
    if (r.unstable) pulse += 0.09 * Math.sin(t * 13.3);
    pulse = Math.max(0.4, pulse);
    this.setEmissive(this.matCore, this.coreBase, pulse);
    this.setEmissive(this.matAccent, this.accentBase, pulse);
    this.setEmissive(this.matSoft, this.softBase, pulse);

    // Rings.
    for (const ring of this.rings) ring.pivot.rotation.y = t * ring.speed;

    // Plates: orbit the cage + a subtle radial lock pulse.
    for (const plate of this.plates) {
      plate.pivot.rotation.y = plate.baseAngle + t * r.spinSpeed * DEG2RAD * 0.5;
      const lock = Math.sin(t * r.pulseFrequency * TAU) * 1.5 * r.scale;
      plate.mesh.position.x = plate.radius + lock;
    }

    // Petals gently open/close.
    for (const petal of this.petals) {
      petal.pivot.rotation.z = Math.sin(t * r.pulseFrequency * TAU + petal.baseAngle) * 0.18;
    }

    // Motes rise and shrink at the top, then loop.
    for (const mote of this.motes) {
      const f = (t * 0.35 + mote.phase) % 1;
      mote.mesh.position.y = mote.baseY + f * mote.range;
      const fade = f < 0.85 ? 1 : 1 - (f - 0.85) / 0.15;
      mote.mesh.scaling.setAll(Math.max(0.001, fade));
    }

    // Satellites orbit with a vertical wobble.
    for (const sat of this.satellites) {
      sat.pivot.rotation.y = sat.baseAngle + t * sat.speed;
    }
  }

  private setEmissive(mat: StandardMaterial, base: Color3, factor: number): void {
    mat.emissiveColor.set(base.r * factor, base.g * factor, base.b * factor);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.transients) t.dispose();
    this.transients.length = 0;
    // Recursively dispose clones (their SHARED geometry survives via the cache
    // prototype; disposeMaterialAndTextures=false leaves the shared structural
    // material alone). Then dispose our 3 private energy materials.
    this.root.dispose(false, false);
    this.matCore.dispose();
    this.matAccent.dispose();
    this.matSoft.dispose();
  }
}
