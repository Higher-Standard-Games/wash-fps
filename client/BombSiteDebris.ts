import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { ModelLoader, type ModelLoadResult } from "../../../engine/loader/model/ModelLoader";
import { getCollisionManager } from "../../../engine/physics/CollisionManager";
import type { BrushModelDefinition } from "../../../shared/bsp/BrushModelState";

interface Fragment {
  root: TransformNode;
  velocity: Vector3;
  spin: Vector3;
  age: number;
}

/** Cosmetic, bounded model fragments. Persistent layout comes from the snapshot. */
const TRACE_POINT = { radius: 0, height: 0, contentMask: 1 };

function sameMembers(set: ReadonlySet<number>, list: readonly number[]): boolean {
  if (set.size !== list.length) return false;
  for (const value of list) if (!set.has(value)) return false;
  return true;
}

export class BombSiteDebris {
  private readonly templates = new Map<string, ModelLoadResult>();
  private readonly loading = new Set<string>();
  private fragments: Fragment[] = [];
  private previous: Set<number> | null = null;
  private round = -1;
  private disposed = false;
  private preloadedFor: readonly BrushModelDefinition[] | null = null;
  private readonly to = new Vector3();
  private readonly bounce = new Vector3();

  constructor(private readonly scene: Scene) {}

  update(dt: number, round: number, disabled: readonly number[]): void {
    if (round !== this.round) {
      this.clearFragments();
      this.previous = null;
      this.round = round;
    }
    const definitions = getCollisionManager().getSweepBackend()?.brushModels?.definitions ?? [];
    if (definitions.length === 0) {
      this.previous = null;
      return;
    }
    // The definitions belong to the map: preload their debris once per map,
    // not every frame.
    if (definitions !== this.preloadedFor) {
      this.preloadedFor = definitions;
      for (const definition of definitions) for (const path of definition.debris) this.preload(path);
    }
    // The same disabled list arrives frame after frame; a new set is only
    // needed when it changes.
    if (!this.previous || !sameMembers(this.previous, disabled)) {
      const current = new Set(disabled);
      if (this.previous) {
        for (const definition of definitions) {
          if (current.has(definition.modelIndex) && !this.previous.has(definition.modelIndex)) this.emit(definition);
        }
      }
      // The first snapshot establishes state: joining after an explosion emits nothing.
      this.previous = current;
    }
    if (this.fragments.length === 0) return;
    const step = Math.min(Math.max(dt, 0), 0.05);
    const backend = getCollisionManager().getSweepBackend();
    let kept = 0;
    for (const fragment of this.fragments) {
      fragment.age += step;
      if (fragment.age > 4) {
        fragment.root.dispose();
        continue;
      }
      this.fragments[kept++] = fragment;
      fragment.velocity.y -= 600 * step;
      const from = fragment.root.position;
      const to = from.addToRef(fragment.velocity.scaleToRef(step, this.to), this.to);
      const hit = backend?.trace(from, to, TRACE_POINT);
      if (hit && hit.fraction < 1) {
        from.copyFrom(hit.endPos);
        if (hit.normal) {
          from.addInPlace(hit.normal);
          fragment.velocity.subtractInPlace(
            hit.normal.scaleToRef(1.45 * Vector3.Dot(fragment.velocity, hit.normal), this.bounce),
          );
          fragment.velocity.scaleInPlace(0.65);
        }
      } else from.copyFrom(to);
      fragment.spin.scaleAndAddToRef(step, fragment.root.rotation);
    }
    this.fragments.length = kept;
  }

  private preload(path: string): void {
    if (this.loading.has(path) || this.templates.has(path)) return;
    this.loading.add(path);
    void ModelLoader.getInstance()
      .loadModel(path, {
        position: Vector3.Zero(),
        visible: false,
        hasCollision: false,
        applyLighting: false,
      })
      .then((model) => {
        if (!model) return;
        if (this.disposed || this.scene.isDisposed) {
          model.root.dispose();
          return;
        }
        model.root.setEnabled(false);
        this.templates.set(path, model);
      })
      .catch((error) => console.warn(`[BombSiteDebris] Could not preload ${path}`, error));
  }

  private emit(definition: BrushModelDefinition): void {
    const available = definition.debris.map((path) => this.templates.get(path)).filter((model) => !!model);
    if (available.length === 0) return;
    for (let i = 0; i < 12 && this.fragments.length < 36; i++) {
      const root = available[i % available.length].root.clone(`site_debris_${definition.modelIndex}_${i}`, null);
      if (!root) continue;
      root.setEnabled(true);
      for (const mesh of root.getChildMeshes()) {
        mesh.isVisible = true;
        mesh.isPickable = false;
      }
      root.position.set(
        definition.min.x + (0.25 + Math.random() * 0.5) * (definition.max.x - definition.min.x),
        definition.min.y + (0.25 + Math.random() * 0.5) * (definition.max.y - definition.min.y),
        definition.min.z + (0.25 + Math.random() * 0.5) * (definition.max.z - definition.min.z),
      );
      this.fragments.push({
        root,
        age: 0,
        velocity: new Vector3((Math.random() - 0.5) * 450, 180 + Math.random() * 300, (Math.random() - 0.5) * 450),
        spin: new Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
      });
    }
  }

  private clearFragments(): void {
    for (const fragment of this.fragments) fragment.root.dispose();
    this.fragments = [];
  }

  dispose(): void {
    this.disposed = true;
    this.clearFragments();
    for (const model of this.templates.values()) model.root.dispose();
    this.templates.clear();
  }
}
