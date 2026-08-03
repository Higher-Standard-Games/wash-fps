/**
 * WeaponPreview — one weapon, lit and turning, inside a UI panel.
 *
 * Runs on its OWN engine and canvas rather than borrowing the game scene.
 *
 * The alternative — placing the model in the world in front of the camera, the
 * way `PostGameShowcase` does — has to fight the map for every frame: the
 * picker opens before you spawn, so the camera can sit in the dark, inside
 * geometry, or facing a wall, and the weapon would be lit by whatever the room
 * happens to have. A menu that shows you a black silhouette half the time is
 * worse than no picture. An isolated scene has one light, one camera and one
 * object, so it looks the same every round.
 *
 * The cost is a second WebGL context for as long as the picker is open. That is
 * the reason everything here is lazy and disposed on close, and the reason
 * every failure path is silent: the picker is a blocking dialog on the way into
 * a round, so a preview that cannot start must cost the player nothing more
 * than a missing picture.
 */

import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";

/** Radians per second the weapon turns on its stand. */
const SPIN_RATE = 0.6;
/** Framing padding — how much of the panel the model fills. */
const FRAME_MARGIN = 1.45;

export class WeaponPreview {
  readonly canvas: HTMLCanvasElement;

  private engine: Engine | null = null;
  private scene: Scene | null = null;
  private camera: ArcRotateCamera | null = null;
  private root: AbstractMesh | null = null;
  /** Guards against a slow load landing after the selection moved on. */
  private generation = 0;
  private disposed = false;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "fps-loadout-preview-canvas";
  }

  /**
   * Show `modelPath`. Safe to call repeatedly and before the engine exists —
   * the first call builds it.
   */
  async show(modelPath: string): Promise<void> {
    if (this.disposed) return;
    const gen = ++this.generation;

    try {
      const scene = await this.ensureScene();
      if (!scene || gen !== this.generation || this.disposed) return;

      const { ImportMeshAsync } = await import("@babylonjs/core/Loading/sceneLoader");
      // Same split the weapon view and model loader use: Babylon resolves the
      // .bin and textures against rootUrl, so passing the whole path loses them.
      const lastSlash = modelPath.lastIndexOf("/");
      const dir = modelPath.substring(0, lastSlash + 1);
      const file = modelPath.substring(lastSlash + 1);
      const result = await ImportMeshAsync(file, scene, { rootUrl: dir });
      if (gen !== this.generation || this.disposed) {
        for (const mesh of result.meshes) mesh.dispose();
        return;
      }

      this.clearModel();
      const root = result.meshes.find((m) => !m.parent) ?? result.meshes[0];
      if (!root) return;
      this.root = root;
      // The viewmodel rigs carry their own offsets; the stand wants it centred.
      root.position.setAll(0);
      root.rotationQuaternion = null;
      this.frame(root);
    } catch {
      // A weapon with no model, a bad path, or a context the browser refused.
      // The names still work as a picker.
      this.clearModel();
    }
  }

  /** Frame the camera on the model's bounds, so every weapon fills the panel. */
  private frame(root: AbstractMesh): void {
    if (!this.camera) return;
    const bounds = root.getHierarchyBoundingVectors(true);
    const size = bounds.max.subtract(bounds.min);
    const centre = bounds.min.add(size.scale(0.5));
    const radius = Math.max(size.x, size.y, size.z) * FRAME_MARGIN;

    this.camera.setTarget(centre);
    this.camera.radius = Math.max(radius, 0.01);
  }

  private async ensureScene(): Promise<Scene | null> {
    if (this.scene) return this.scene;

    const [
      { Engine: EngineCtor },
      { Scene: SceneCtor },
      { ArcRotateCamera: CameraCtor },
      { HemisphericLight },
      { Vector3 },
      { Color4 },
    ] = await Promise.all([
      import("@babylonjs/core/Engines/engine"),
      import("@babylonjs/core/scene"),
      import("@babylonjs/core/Cameras/arcRotateCamera"),
      import("@babylonjs/core/Lights/hemisphericLight"),
      import("@babylonjs/core/Maths/math.vector"),
      import("@babylonjs/core/Maths/math.color"),
    ]);
    if (this.disposed) return null;

    const engine = new EngineCtor(this.canvas, true, { preserveDrawingBuffer: false, stencil: false }, false);
    const scene = new SceneCtor(engine);
    // Transparent, so the panel's own slab shows through behind the weapon.
    scene.clearColor = new Color4(0, 0, 0, 0);

    const camera = new CameraCtor("weapon_preview_cam", -Math.PI / 2, Math.PI / 2.35, 1, Vector3.Zero(), scene);
    // Not attached to the canvas: this is a display, not a viewer. Letting the
    // mouse drag it would steal drags meant for the picker underneath.
    const key = new HemisphericLight("weapon_preview_key", new Vector3(0.4, 1, -0.6), scene);
    key.intensity = 1.15;

    engine.runRenderLoop(() => {
      if (this.root) this.root.rotation.y += SPIN_RATE * (engine.getDeltaTime() / 1000);
      scene.render();
    });

    this.engine = engine;
    this.scene = scene;
    this.camera = camera;
    return scene;
  }

  /** Match the backing buffer to the element, so the weapon is not blurry. */
  resize(): void {
    this.engine?.resize();
  }

  private clearModel(): void {
    this.root?.dispose(false, true);
    this.root = null;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.clearModel();
    this.scene?.dispose();
    this.engine?.dispose();
    this.scene = null;
    this.engine = null;
    this.camera = null;
    this.canvas.remove();
  }
}
