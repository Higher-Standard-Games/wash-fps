/**
 * ProceduralPickupVisual — the runtime, per-pickup procedural sculpture
 * (docs/research/PROCEDURAL_ITEMS.md §"Cosmetic State Machine").
 *
 * Art direction v6 (cel-shaded objects, per playtest #4):
 *  - Health: a fresnel energy shell — nearly clear face-on, glowing hot at the
 *    silhouette rim, with a slow color↔accent flow (25 HP yellow, 50 HP
 *    orange↔yellow) — around a solid accent-coloured cross whose up/down faces
 *    take the tier colour, plus a ring carrying a scrolling gradient band.
 *  - Armor: ONE sculpted military plate carrier — chest plate, shoulder
 *    pauldrons, sternum ridge, abdomen plate — lit and saturated, with a black
 *    cel outline. Tier is colour + size; shard is the bare chest plate, tilted.
 * The collection burst transient is kept; there is no floor pedestal.
 *
 * Implements the engine `PickupVisual` contract: a fixed anchor + an animated
 * cosmetic root, assembled by cloning scene-cached prototype geometry and driven
 * from an elapsed clock (frame-rate independent, drift-free). It disposes its own
 * clones + private materials + in-flight transients; shared prototype geometry
 * and the structural material are cache-owned and outlive it.
 */

// Side effect: registers AbstractMesh.enableEdgesRendering.
import "@babylonjs/core/Rendering/edgesRenderer";
import type { Material } from "@babylonjs/core/Materials/material";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { PickupVisual } from "../../../../../engine/world/PickupVisual";
import { getPrototypeSet } from "./ProceduralPickupAssetCache";
import {
  baseEmissive,
  cloneEnergyMaterial,
  createFresnelShellMaterial,
  createRingGradientMaterial,
} from "./ProceduralPickupMaterials";
import { PROCEDURAL_GLOBAL_SCALE } from "./ProceduralPickupRecipes";
import { ProceduralPickupTransient } from "./ProceduralPickupTransient";
import type { ProceduralPickupRecipe } from "./types";

const TAU = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

// The pickup anchor sits `dropToGround` +12u above the floor; the beacon drops
// back down to the floor to rise as a column.
const BEACON_HEIGHT = 90;
const BEACON_BASE_BELOW = 12;
/** Extra rest height above the anchor so the item floats clearly off the floor. */
const HOVER_LIFT = 9;
/** Amplifies each recipe's bob so the up/down float is clearly visible. */
const BOB_GAIN = 2.6;
/** Speed of the shell's color↔accent flow (cycles/sec — slow). */
const COLOR_FLOW_SPEED = 0.22;
/** How fast the ring gradient travels around the ring (UV turns/sec). */
const RING_SCROLL_SPEED = 0.35;

interface RingEl {
  pivot: TransformNode;
  speed: number;
}
interface SatEl {
  pivot: TransformNode;
  baseAngle: number;
  speed: number;
}
interface PulseTarget {
  mat: StandardMaterial;
  base: Color3;
}

export class ProceduralPickupVisual implements PickupVisual {
  readonly root: TransformNode;
  private readonly cosmetic: TransformNode;
  private readonly scene: Scene;
  private readonly recipe: ProceduralPickupRecipe;
  private readonly phase: number;

  private readonly matEnergy: StandardMaterial;
  private readonly matAccent: StandardMaterial;
  private readonly matSoft: StandardMaterial;
  private readonly matShell: StandardMaterial | null = null;
  private readonly flowA: Color3;
  private readonly flowB: Color3;
  private readonly pulseTargets: PulseTarget[] = [];

  private readonly ringMaterials: StandardMaterial[] = [];
  private readonly rings: RingEl[] = [];
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
    this.flowA = new Color3(recipe.color.r, recipe.color.g, recipe.color.b);
    this.flowB = new Color3(recipe.accentColor.r, recipe.accentColor.g, recipe.accentColor.b);

    const set = getPrototypeSet(scene, recipe);
    this.matEnergy = cloneEnergyMaterial(set.energyCore, `pp_energy_${recipe.id}_${seed}`);
    this.matAccent = cloneEnergyMaterial(set.energyAccent, `pp_accent_${recipe.id}_${seed}`);
    this.matSoft = cloneEnergyMaterial(set.energySoft, `pp_soft_${recipe.id}_${seed}`);
    this.track(this.matEnergy);
    this.track(this.matAccent);
    this.track(this.matSoft);

    this.root = new TransformNode(`pp_anchor_${recipe.id}_${seed}`, scene);
    this.root.position.copyFrom(position);
    this.cosmetic = new TransformNode(`pp_cosmetic_${recipe.id}_${seed}`, scene);
    this.cosmetic.parent = this.root;

    const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;

    if (recipe.family === "health") {
      // Bright accent-coloured cross whose up/down faces take the (deeper) tier
      // colour, with a dark cel outline, inside a fresnel shell that rims at the
      // silhouette and stays near-clear face-on (so the emblem reads through it).
      this.inst(set.cross, this.cosmetic, this.matAccent, "cross");
      this.inst(set.crossCaps, this.cosmetic, set.emblemFill, "cross_caps");
      this.matShell = createFresnelShellMaterial(scene, `pp_shell_${recipe.id}_${seed}`, recipe.color);
      this.inst(set.core, this.cosmetic, this.matShell, "shell");
    } else {
      // Banded plates in the tier colour. No edge outlines: the plates are lit,
      // so the facets separate on shading alone, and black borders were reading
      // as heavy ink over what should be a solid object.
      const armor = this.inst(set.armor, this.cosmetic, set.armorPlate, "armor");
      // Shard is a broken-off piece — tip it so it never reads as a tiny vest.
      if (armor && recipe.kind === "shard") {
        armor.rotation.z = 0.5;
        armor.rotation.x = 0.22;
      }
    }

    // Orbiting rings with a scrolling colour→accent gradient (all health tiers).
    for (let i = 0; i < recipe.ringCount; i++) {
      const pivot = new TransformNode(`pp_ringpivot_${i}`, scene);
      pivot.parent = this.cosmetic;
      const mat =
        recipe.family === "health"
          ? createRingGradientMaterial(scene, `pp_ring_${recipe.id}_${seed}_${i}`, recipe.color, recipe.accentColor)
          : this.matAccent;
      if (mat !== this.matAccent) this.ringMaterials.push(mat);
      const ring = this.inst(set.ring, pivot, mat, `ring_${i}`);
      if (ring) ring.rotation.x = 0.3 + i * 0.6;
      const dir = i % 2 === 0 ? 1 : -1;
      this.rings.push({ pivot, speed: recipe.spinSpeed * DEG2RAD * (0.9 + i * 0.4) * dir });
    }

    // Orbiting satellites (mega/ultra).
    for (let i = 0; i < recipe.satelliteCount; i++) {
      const pivot = new TransformNode(`pp_satpivot_${i}`, scene);
      pivot.parent = this.cosmetic;
      pivot.rotation.x = 0.4 + i * 0.25;
      const sat = this.inst(set.satellite, pivot, this.matEnergy, `sat_${i}`);
      if (sat) sat.position.set(14 * s, 0, 0);
      this.satellites.push({
        pivot,
        baseAngle: (i / recipe.satelliteCount) * TAU,
        speed: recipe.spinSpeed * DEG2RAD * 1.5,
      });
    }

    // Faint vertical beacon (mega/ultra/red) rising from the floor. Offset so its
    // base still meets the floor despite the cosmetic root's hover lift.
    if (set.beacon) {
      const beacon = this.inst(set.beacon, this.cosmetic, this.matSoft, "beacon");
      if (beacon) beacon.position.y = BEACON_HEIGHT / 2 - BEACON_BASE_BELOW - HOVER_LIFT;
    }

    // Fail-closed initial visibility WITHOUT committing prevActive, so the first
    // server reconcile is treated as the initial (silent) state, not a respawn.
    this.applyVisible(!startHidden);
  }

  private track(mat: StandardMaterial): void {
    this.pulseTargets.push({ mat, base: baseEmissive(mat).clone() });
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
    const eff = this.recipe.scale * PROCEDURAL_GLOBAL_SCALE;
    const t = new ProceduralPickupTransient(
      this.scene,
      this.root,
      new Color3(this.recipe.color.r, this.recipe.color.g, this.recipe.color.b),
      {
        duration: this.recipe.highTier ? 0.42 : 0.28,
        endDiameter: 30 * eff * 1.7,
        style: this.recipe.collectStyle,
        scale: eff,
      },
    );
    this.transients.push(t);
  }

  update(dt: number, elapsed: number): void {
    if (this.disposed) return;

    // Transients run even while the persistent visual is hidden (parented to the
    // always-enabled anchor).
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

    // Float higher off the floor, with a clearly visible slow up/down bob.
    const bobW = t * r.bobFrequency * TAU;
    this.cosmetic.position.y = HOVER_LIFT + Math.sin(bobW) * r.bobAmplitude * BOB_GAIN;
    this.cosmetic.position.x = r.figureEight ? Math.sin(bobW * 2) * r.bobAmplitude * 0.35 : 0;
    this.cosmetic.rotation.y = t * r.spinSpeed * DEG2RAD;

    // Breathing + assembly scale.
    const breathe = 1 + 0.02 * Math.sin(t * r.pulseFrequency * TAU);
    this.cosmetic.scaling.setAll(assembleScale * breathe);

    // Gentle emissive pulse (double-beat for high tier; flicker for unstable).
    const pulseW = t * r.pulseFrequency * TAU;
    let pulse = 0.82 + 0.18 * Math.sin(pulseW);
    if (r.highTier) pulse += 0.12 * Math.max(0, Math.sin(pulseW * 2));
    if (r.unstable) pulse += 0.06 * Math.sin(t * 11);
    pulse = Math.max(0.5, pulse);
    for (const target of this.pulseTargets) {
      target.mat.emissiveColor.set(target.base.r * pulse, target.base.g * pulse, target.base.b * pulse);
    }

    // Shell color flow: slow color↔accent lerp × pulse (the legible replacement
    // for the old UV-scrolled gradient — 50 HP visibly flows orange↔yellow).
    if (this.matShell) {
      const f = 0.5 + 0.5 * Math.sin(t * COLOR_FLOW_SPEED * TAU);
      this.matShell.emissiveColor.set(
        (this.flowA.r + (this.flowB.r - this.flowA.r) * f) * pulse,
        (this.flowA.g + (this.flowB.g - this.flowA.g) * f) * pulse,
        (this.flowA.b + (this.flowB.b - this.flowA.b) * f) * pulse,
      );
    }

    // Rings + satellites. The ring gradient also travels along the ring itself,
    // so the band chases around the circle independently of the pivot spin.
    for (const ring of this.rings) ring.pivot.rotation.y = t * ring.speed;
    for (const mat of this.ringMaterials) {
      const tex = mat.emissiveTexture as Texture | null;
      if (tex) tex.uOffset = (t * RING_SCROLL_SPEED) % 1;
    }
    for (const sat of this.satellites) sat.pivot.rotation.y = sat.baseAngle + t * sat.speed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.transients) t.dispose();
    this.transients.length = 0;
    // Recursively dispose clones (their SHARED geometry survives via the cache
    // prototype; disposeMaterialAndTextures=false leaves shared materials alone).
    this.root.dispose(false, false);
    this.matEnergy.dispose();
    this.matAccent.dispose();
    this.matSoft.dispose();
    this.matShell?.dispose();
    // Ring materials own a private gradient DynamicTexture — take it with them.
    for (const mat of this.ringMaterials) {
      mat.emissiveTexture?.dispose();
      mat.dispose();
    }
    this.ringMaterials.length = 0;
  }
}
