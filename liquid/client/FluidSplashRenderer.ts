/**
 * Epic-tier splash crowns, drawn through Babylon's FluidRenderer.
 *
 * FluidRenderer is a screen-space renderer for particles: it builds depth and
 * thickness targets from a point cloud and composites something that reads as
 * liquid. It does NOT simulate anything — `SplashDroplets` owns the motion,
 * and this owns the picture.
 *
 * Three things about it decide the shape of this file:
 *
 * 1. **One target renderer, always.** Every `addCustomParticles` call without
 *    an explicit target renderer creates a new one, and each carries its own
 *    render targets and final post-process. A per-splash emitter would be a
 *    per-splash full-screen pass. There is exactly one, for one camera.
 * 2. **The defaults are far too expensive** for a handful of droplets — depth,
 *    several bilateral blur iterations, thickness, its blur, then a composite.
 *    Everything here is pinned: fixed map sizes so a high-DPI display does not
 *    silently quadruple the cost, one blur iteration, no diffuse target.
 * 3. **Removing a render object does not dispose the particle data.** Cleanup
 *    has to do both, or a map change leaks the buffer behind the picture.
 *
 * Crowns render ABOVE the waterline only. Static water is transparent and
 * absent from the opaque depth buffer, so a droplet below the surface has
 * nothing to be occluded by and would show through the pool it is inside.
 * `SplashDroplets` retires them at re-entry for exactly this reason.
 */

import "@babylonjs/core/Rendering/fluidRenderer/fluidRenderer";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { IFluidRenderingRenderObject } from "@babylonjs/core/Rendering/fluidRenderer/fluidRenderer";
import type { FluidRenderingObjectCustomParticles } from "@babylonjs/core/Rendering/fluidRenderer/fluidRenderingObjectCustomParticles";
import type { Scene } from "@babylonjs/core/scene";
import { MAX_DROPLETS } from "./SplashDroplets";

/**
 * Fixed target sizes rather than screen-relative.
 *
 * Screen-relative is the Babylon default and it makes the cost of this effect
 * a property of the player's monitor. A 4K display would pay four times what a
 * 1080p one does for the same handful of droplets.
 */
const DEPTH_MAP_SIZE = 512;
const THICKNESS_MAP_SIZE = 256;

/** Droplet radius in world units, as the renderer sees it. */
const PARTICLE_SIZE = 6;

export class FluidSplashRenderer {
  private renderObject: IFluidRenderingRenderObject | null = null;
  private particles: FluidRenderingObjectCustomParticles | null = null;
  private positions: Float32Array | null = null;
  private available = false;

  constructor(private readonly scene: Scene) {}

  /**
   * Stand up the renderer for a camera.
   *
   * Returns false when FluidRenderer is unavailable — an older backend, a
   * refused float target — so the caller can stay on the ordinary ripple
   * rather than showing nothing. Epic degrading to Medium is a fine outcome;
   * a missing splash is not.
   */
  start(camera: Camera, positions: Float32Array): boolean {
    if (this.available) return true;

    try {
      const fluid = this.scene.enableFluidRenderer();
      if (!fluid) return false;

      this.renderObject = fluid.addCustomParticles(
        { position: positions },
        0,
        // No diffuse target: spray is one colour, and the diffuse pass is a
        // whole extra render target to express that.
        false,
        undefined,
        camera,
      );

      this.particles = this.renderObject.object as FluidRenderingObjectCustomParticles;
      this.particles.particleSize = PARTICLE_SIZE;
      this.positions = positions;

      const target = this.renderObject.targetRenderer;
      target.fluidColor = new Color3(0.72, 0.86, 0.95);
      target.density = 2.2;
      target.depthMapSize = DEPTH_MAP_SIZE;
      target.thicknessMapSize = THICKNESS_MAP_SIZE;
      // One iteration each. The default chain is tuned for a pool of fluid
      // filling the screen, not for a dozen droplets over a pool.
      target.blurDepthNumIterations = 1;
      target.blurThicknessNumIterations = 1;
      // Fixed thickness drops a target and its blur entirely. Crowns are thin
      // and fast, and the flatter result is not worth the pass.
      target.useFixedThickness = true;
      target.minimumThickness = 0.15;

      this.available = true;
      return true;
    } catch (error) {
      console.warn("[Water] FluidRenderer unavailable; Epic splashes disabled", error);
      this.dispose();
      return false;
    }
  }

  /**
   * Show `count` droplets from the shared buffer.
   *
   * `updateDirectly` rather than `addBuffers`, deliberately: `addBuffers`
   * constructs a NEW VertexBuffer every call and never disposes the one it
   * replaces, so calling it per frame would leak a GPU buffer per frame. It
   * creates them updatable precisely so the data can be pushed in place, which
   * is what this does — no allocation, no leak.
   */
  update(count: number): void {
    if (!this.particles || !this.positions) return;

    const shown = Math.min(count, MAX_DROPLETS);
    this.particles.setNumParticles(shown);
    if (shown > 0) this.particles.vertexBuffers.position?.updateDirectly(this.positions, 0);
  }

  get isAvailable(): boolean {
    return this.available;
  }

  /**
   * Release the render object AND the particle data.
   *
   * Babylon's wrapper does not dispose the underlying object for you, so doing
   * only the first leaves the buffer behind the picture alive across a map
   * change. `removeRenderObject` also drops the target renderer once nothing
   * is using it, which is what stops a second map adding a second full-screen
   * composite.
   */
  dispose(): void {
    const fluid = this.scene.fluidRenderer;
    if (fluid && this.renderObject) {
      try {
        fluid.removeRenderObject(this.renderObject);
      } catch {
        // Scene already tearing down; the target goes with it.
      }
    }
    this.particles?.dispose();
    this.particles = null;
    this.renderObject = null;
    this.positions = null;
    this.available = false;
  }
}
