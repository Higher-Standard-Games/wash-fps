import type { Material } from "@babylonjs/core/Materials/material";
import type { Scene } from "@babylonjs/core/scene";
import { abortable } from "./MovieClock";

/** Shader variants must match the current light-buffer layout before a movie frame is copied. */
export class ExportSceneReadiness {
  private waiting = false;
  private readonly materials = new Map<Material, () => void>();
  private readonly added;
  private readonly bind: (material: Material) => void;

  constructor(
    private readonly scene: Scene,
    private readonly clock: { deltaMs: number },
  ) {
    const bind = (material: Material) => {
      if (this.materials.has(material)) return;
      const previous = material.allowShaderHotSwapping;
      const ready = material.isReady;
      const readyForSubMesh = material.isReadyForSubMesh;
      material.allowShaderHotSwapping = false;
      material.isReady = (...args) => {
        const result = ready.apply(material, args);
        if (!result) this.waiting = true;
        return result;
      };
      material.isReadyForSubMesh = (...args) => {
        const result = readyForSubMesh.apply(material, args);
        if (!result) this.waiting = true;
        return result;
      };
      const restore = () => {
        material.allowShaderHotSwapping = previous;
        material.isReady = ready;
        material.isReadyForSubMesh = readyForSubMesh;
      };
      const disposed = material.onDisposeObservable.add(() => {
        restore();
        this.materials.delete(material);
      });
      this.materials.set(material, () => {
        restore();
        material.onDisposeObservable.remove(disposed);
      });
    };
    this.bind = bind;
    this.added = scene.onNewMaterialAddedObservable.add(bind);
    for (const material of scene.materials) bind(material);
  }

  async render(signal: AbortSignal): Promise<void> {
    const delta = this.clock.deltaMs;
    const deadline = performance.now() + 60_000;
    try {
      for (;;) {
        signal.throwIfAborted();
        // Babylon's material-added notification is deferred; catch additions before their first draw.
        for (const material of this.scene.materials) this.bind(material);
        this.waiting = false;
        this.scene.render();
        signal.throwIfAborted();
        // Inspect attempted draws rather than forcing shader variants for hidden source meshes.
        if (!this.waiting && this.scene.getWaitingItemsCount() === 0 && this.scene.getEngine().areAllEffectsReady())
          return;
        if (performance.now() > deadline) throw new Error("A movie shader did not become ready");
        // Readiness redraws warm the same picture without advancing animation or game events.
        this.clock.deltaMs = 0;
        await abortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
      }
    } finally {
      this.clock.deltaMs = delta;
    }
  }

  dispose(): void {
    this.scene.onNewMaterialAddedObservable.remove(this.added);
    for (const release of this.materials.values()) release();
    this.materials.clear();
  }
}
