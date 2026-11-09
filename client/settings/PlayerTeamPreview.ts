import "@babylonjs/loaders/glTF";
import "@babylonjs/core/Animations/animatable";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { Scene } from "@babylonjs/core/scene";
import { PLAYER_ANIMATION_ROOT } from "../../../../engine/animation/PlayerModelAssets";
import { type PlayerModelInstance, PlayerModelManager } from "../../../../engine/animation/PlayerModelManager";
import { background } from "../../../../engine/core/AsyncErrors";
import { PK3Index } from "../../../../engine/loader/pk3/PK3Index";
import {
  PLAYER_MODEL_ASSETS,
  type PlayerModelChoice,
  type PlayerModelSide,
  playerModelChoice,
} from "../PlayerModelSelection";
import { getPlayerModelVisualStyle } from "../PlayerModelVisualSettings";

interface PreviewSide {
  side: PlayerModelSide;
  slot: HTMLElement;
  camera: FreeCamera;
  layer: number;
  model?: PlayerModelInstance;
  choice?: PlayerModelChoice;
  generation: number;
}

/** Two camera viewports share one small WebGL context, source cache and render loop. */
export class PlayerTeamPreview {
  private readonly canvas = document.createElement("canvas");
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly manager: PlayerModelManager;
  private readonly sides: PreviewSide[];
  private readonly resize: ResizeObserver;
  private readonly loading = new Map<PlayerModelChoice, Promise<void>>();
  private visible = false;
  private disposed = false;
  private initialized = false;
  private running = false;
  private lastFrame = 0;
  private readonly onVisibility = () => this.syncLoop();
  private readonly render = () => {
    const now = performance.now();
    if (now - this.lastFrame < 1000 / 30) return;
    this.lastFrame = now;
    for (const side of this.sides) {
      if (!side.model) continue;
      side.model.anchor.rotation.y = Math.sin(now / 3500) * 0.22;
      this.manager.resetRootMotion(side.model);
    }
    this.scene.render();
  };

  constructor(
    private readonly root: HTMLElement,
    slots: readonly HTMLElement[],
  ) {
    this.canvas.className = "fps-set-team-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    this.engine = new Engine(this.canvas, true, { stencil: true });
    this.engine.setHardwareScalingLevel(1);
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    this.manager = new PlayerModelManager(this.scene);
    const light = new HemisphericLight("preview-light", new Vector3(0.4, 1, 1), this.scene);
    light.intensity = 1.4;
    this.sides = slots.map((slot, index) => {
      const side = index === 0 ? "ally" : "enemy";
      const camera = new FreeCamera(`preview-${side}`, new Vector3(55, 43, 140), this.scene);
      camera.setTarget(new Vector3(0, 32, 0));
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoTop = 38;
      camera.orthoBottom = -38;
      camera.layerMask = 1 << index;
      return { side, slot, camera, layer: 1 << index, generation: 0 };
    });
    this.scene.activeCameras = this.sides.map((side) => side.camera);
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(root);
    for (const slot of slots) this.resize.observe(slot);
    document.addEventListener("visibilitychange", this.onVisibility);
    root.append(this.canvas);
    this.layout();
  }

  async initialize(): Promise<void> {
    await PK3Index.getInstance().ensureIndex();
    if (this.disposed) return;
    await this.manager.loadModel();
    if (this.disposed) return;
    if (!this.manager.isLoaded) throw new Error("Player preview model failed to load");
    this.initialized = true;
    this.refresh();
    this.syncLoop();
  }

  refresh(): void {
    if (this.disposed || !this.initialized) return;
    for (const side of this.sides) {
      const choice = playerModelChoice(side.side);
      if (side.choice === choice) {
        if (side.model) this.manager.applyVisualStyle(side.model, getPlayerModelVisualStyle(side.side, 36));
        continue;
      }
      side.choice = choice;
      const generation = ++side.generation;
      side.slot.classList.remove("is-live");
      if (side.model) this.manager.releaseInstance(side.model);
      side.model = undefined;
      background(this.select(side, choice, generation), "Player model preview");
    }
  }

  private async select(side: PreviewSide, choice: PlayerModelChoice, generation: number): Promise<void> {
    try {
      if (choice !== "police") {
        let pending = this.loading.get(choice);
        if (!pending) {
          const asset = PLAYER_MODEL_ASSETS[choice];
          pending = this.manager.loadVariant(choice, asset.root, asset.file, PLAYER_ANIMATION_ROOT);
          this.loading.set(choice, pending);
        }
        await pending;
      }
      if (this.disposed || side.generation !== generation) return;
      const model = this.manager.createInstance(`settings-${side.side}`, 36, choice === "police" ? undefined : choice);
      if (!model) throw new Error(`Player preview unavailable: ${choice}`);
      side.model = model;
      for (const mesh of [model.mesh, ...model.mesh.getChildMeshes()]) mesh.layerMask = side.layer;
      this.manager.playAnimation(model, "idle");
      this.manager.applyVisualStyle(model, getPlayerModelVisualStyle(side.side, 36));
      side.slot.classList.add("is-live");
    } catch (error) {
      this.loading.delete(choice);
      if (!this.disposed && side.generation === generation) side.choice = undefined;
      throw error;
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.syncLoop();
  }

  private syncLoop(): void {
    const running = this.visible && this.initialized && !document.hidden && !this.disposed;
    if (running === this.running) return;
    this.running = running;
    if (running) {
      this.layout();
      this.lastFrame = 0;
      this.engine.runRenderLoop(this.render);
    } else this.engine.stopRenderLoop(this.render);
  }

  private layout(): void {
    if (this.disposed) return;
    const bounds = this.root.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    this.engine.setSize(Math.round(bounds.width), Math.round(bounds.height));
    for (const side of this.sides) {
      const slot = side.slot.getBoundingClientRect();
      side.camera.viewport = new Viewport(
        (slot.left - bounds.left) / bounds.width,
        1 - (slot.bottom - bounds.top) / bounds.height,
        slot.width / bounds.width,
        slot.height / bounds.height,
      );
      const halfWidth = (38 * slot.width) / Math.max(1, slot.height);
      side.camera.orthoLeft = -halfWidth;
      side.camera.orthoRight = halfWidth;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.syncLoop();
    this.resize.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    for (const side of this.sides) {
      side.generation++;
      if (side.model) this.manager.disposeInstance(side.model);
      side.slot.classList.remove("is-live");
    }
    this.manager.dispose();
    this.scene.dispose();
    this.engine.dispose();
    this.canvas.remove();
  }
}
