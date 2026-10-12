/**
 * Underwater presentation, driven by the camera rather than by the player.
 *
 * Sampling the local player's water level would be wrong for every camera that
 * is not attached to them: spectating, the death chase, freefly and the
 * round-end focus all cross the surface independently of the body they belong
 * to. The camera is what sees, so the camera is what gets asked.
 *
 * Hooked to `onBeforeCameraRender` so it runs after whichever controller wrote
 * the transform this frame — `FPSController`, `FreeflyController`,
 * `SpectatorController`, `DeathCamera` and `SpectateEyeCamera` all write
 * directly, and which one owns the frame is decided at runtime. Sampling
 * earlier would read last frame's position, a lag most visible at exactly the
 * moment it matters.
 */

import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";
import { Cvar } from "../../../../engine/core/Cvar";
import { WorldFogController } from "../../../../engine/rendering/WorldFogController";
import { MASK_LIQUID } from "../../../../shared/collision/CollisionWorld";
import type { LiquidKind } from "../LiquidTypes";
import { liquidKindAt, type PointContentsSource } from "../LiquidVolumeSampler";
import { approachSubmersion, fogDensityFor, fovWarpDegrees, lookFor } from "./UnderwaterLook";

const RAD_PER_DEG = Math.PI / 180;

export class UnderwaterView {
  private submersion = 0;
  private kind: LiquidKind = "water";
  private elapsed = 0;
  private observer: Observer<Camera> | null = null;
  private collision: PointContentsSource | null = null;

  /** Scene fog as we found it, so a map without water is left exactly as-is. */
  private saved: { mode: number; color: Color3; density: number } | null = null;
  /**
   * Camera FOV as authored, so the warp oscillates around it rather than
   * drifting, and the FOV we last wrote. A camera whose FOV is no longer what we
   * wrote was set by its controller since (zoom, the FOV slider), and that is
   * the new base. Captured once, it froze the FOV at the dive: no zoom (E7).
   */
  private baseFov = new WeakMap<Camera, number>();
  private writtenFov = new WeakMap<Camera, number>();
  /** Cameras currently carrying a warped FOV, so dispose() can undo all of them. */
  private readonly warped = new Set<Camera>();

  constructor(private readonly scene: Scene) {}

  setCollisionWorld(collision: PointContentsSource | null): void {
    this.collision = collision;
  }

  start(): void {
    if (this.observer) return;
    this.observer = this.scene.onBeforeCameraRenderObservable.add((camera) => {
      // Gameplay renders an eye camera and a weapon camera. The weapon camera
      // is parented to the eye and sits at a fixed local offset, so asking it
      // where it is in the world gives an answer about the wrong point.
      const active = this.scene.activeCameras;
      if (active && active.length > 0 && camera !== active[0]) return;
      this.update(camera);
    });
  }

  /**
   * Sample, mix, and apply. Public so a test or a debug command can step it
   * without a render loop.
   */
  update(camera: Camera, deltaTimeOverride?: number): void {
    const dt = deltaTimeOverride ?? Math.min(0.1, this.scene.getEngine().getDeltaTime() / 1000);
    this.elapsed += dt;

    const eye = camera.globalPosition;
    const contents = this.collision?.pointContents({ x: eye.x, y: eye.y, z: eye.z }) ?? 0;
    const liquid = liquidKindAt(contents & MASK_LIQUID);

    // Hold the last kind while fading out, so leaving the water fades through
    // the colour of the water rather than snapping to a default blue.
    if (liquid) this.kind = liquid;

    const previous = this.submersion;
    this.submersion = approachSubmersion(this.submersion, liquid ? 1 : 0, dt);

    if (this.submersion <= 0) {
      if (previous > 0) {
        this.restoreScene();
        this.onSubmersion?.(0);
      }
      this.restoreFov(camera);
      return;
    }

    this.applyFog();
    this.applyWarp(camera);
    this.onSubmersion?.(this.submersion);
  }

  /**
   * Called every frame with the current 0-1 submersion.
   *
   * A callback rather than the view reaching into the viewmodel: the weapon
   * lives in the engine, liquid lives in the game, and the engine must not
   * learn that water exists.
   */
  public onSubmersion: ((amount: number) => void) | null = null;

  private applyFog(): void {
    const look = lookFor(this.kind);

    if (!this.saved) {
      // World fog stands aside while under water, and comes back current
      WorldFogController.getInstance().suspend("underwater");
      this.saved = {
        mode: this.scene.fogMode,
        color: this.scene.fogColor.clone(),
        density: this.scene.fogDensity,
      };
    }

    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = fogDensityFor(look, this.submersion);

    // Blend toward the liquid colour rather than replacing it, so a map with
    // its own atmospheric fog keeps some of its character underwater.
    const base = this.saved.color;
    const t = look.tintStrength * this.submersion;
    this.scene.fogColor.set(
      base.r + (look.color[0] - base.r) * t,
      base.g + (look.color[1] - base.g) * t,
      base.b + (look.color[2] - base.b) * t,
    );
  }

  private applyWarp(camera: Camera): void {
    const comfort = Cvar.getNumber("r_underwater_distortion");
    let base = this.baseFov.get(camera);
    if (base === undefined || camera.fov !== this.writtenFov.get(camera)) {
      base = camera.fov;
      this.baseFov.set(camera, base);
    }

    // Held strongly as well as weakly. The WeakMap is keyed by camera and is
    // the right store while the camera lives, but dispose() has to put the FOV
    // back and cannot enumerate a WeakMap — and an unload while submerged that
    // skipped the restore would leave the camera warped for the rest of the
    // session, across every map after it.
    this.warped.add(camera);

    const warp = fovWarpDegrees(this.elapsed, this.submersion, comfort);
    camera.fov = base + warp * RAD_PER_DEG;
    this.writtenFov.set(camera, camera.fov);
  }

  private restoreFov(camera: Camera): void {
    const base = this.baseFov.get(camera);
    if (base !== undefined) {
      // Only undo our own write; a FOV the controller set since is already right.
      if (camera.fov === this.writtenFov.get(camera)) camera.fov = base;
      this.baseFov.delete(camera);
      this.writtenFov.delete(camera);
    }
    this.warped.delete(camera);
  }

  private restoreScene(): void {
    if (!this.saved) return;
    this.scene.fogMode = this.saved.mode;
    this.scene.fogColor.copyFrom(this.saved.color);
    this.scene.fogDensity = this.saved.density;
    this.saved = null;
    WorldFogController.getInstance().resume("underwater");
  }

  /**
   * Leave everything exactly as it was found.
   *
   * Fog AND field of view. Cameras outlive the map — the same camera object is
   * handed to the next one — so unloading while submerged used to leave the
   * warp applied permanently, on every map after it.
   */
  dispose(): void {
    if (this.observer) {
      this.scene.onBeforeCameraRenderObservable.remove(this.observer);
      this.observer = null;
    }
    this.restoreScene();
    for (const camera of [...this.warped]) this.restoreFov(camera);
    this.warped.clear();
    this.submersion = 0;
    this.collision = null;
  }

  /** 0 dry, 1 fully under. Read by the viewmodel to float the weapon. */
  get submersionAmount(): number {
    return this.submersion;
  }

  get liquidKind(): LiquidKind {
    return this.kind;
  }
}
