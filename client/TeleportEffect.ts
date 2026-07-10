/**
 * TeleportEffect — washoi manga teleporter VFX (WO-T4b)
 *
 * Two pieces, both cheap and print-styled (docs/research/triggerbrushes-and-targets.md):
 *
 * 1. GHOST — a posterized afterimage of the player model (Warsow's transparent
 *    outline, celified): the model hierarchy is cloned with a single flat unlit
 *    team-color material and fades out in DISCRETE alpha steps (print/anime
 *    frames, not a smooth ghost). Spawned at BOTH the entry (tells a duelist
 *    where you went — deliberate arcade info) and the exit (materialize flash
 *    over the arriving model). Clones share the source skeleton, so the ghost
 *    holds a live pose for its short life.
 *
 * 2. BURST — a radial manga speed-line starburst (procedural triangle fan,
 *    camera-billboarded) that pops and vanishes.
 *
 * Self-updating via an onBeforeRender observer (same pattern as
 * CartoonHitEffect). All effects hard-cap + self-dispose.
 */

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import type { PlayerModelInstance } from "../../../engine/animation/PlayerModelManager";

// ============================================================================
// Constants
// ============================================================================

/** Ghost lifetime (ms) and its discrete alpha steps (posterized fade). */
const GHOST_LIFETIME_MS = 360;
const GHOST_ALPHA_STEPS = [0.85, 0.55, 0.3, 0.12];

/** Burst lifetime (ms), alpha steps, and scale ramp. */
const BURST_LIFETIME_MS = 240;
const BURST_ALPHA_STEPS = [0.9, 0.55, 0.2];
const BURST_START_SCALE = 0.55;
const BURST_END_SCALE = 1.35;

/** Starburst geometry: N tapered spikes between the two radii. */
const BURST_SPIKES = 12;
const BURST_INNER_RADIUS = 16;
const BURST_OUTER_RADIUS = 56;
const BURST_BASE_HALF_WIDTH = 4;

/** Burst vertical offset — chest height above the player origin. */
const BURST_Y_OFFSET = 8;

/** Hard cap on simultaneous effect instances (ghosts + bursts). */
const MAX_EFFECTS = 12;

/** Team silhouette colors — match the udon/soba model tints. */
const TEAM_COLORS: Record<"alpha" | "bravo", Color3> = {
  alpha: new Color3(0.15, 0.95, 1.0), // cyan (udon)
  bravo: new Color3(1.0, 0.2, 0.75), // magenta (soba)
};

/** Burst line color — hot print-white with a cyan bite. */
const BURST_COLOR = new Color3(0.85, 1.0, 1.0);

// ============================================================================
// Types
// ============================================================================

interface ActiveEffect {
  root: TransformNode | Mesh;
  material: StandardMaterial;
  elapsedMs: number;
  lifetimeMs: number;
  alphaSteps: number[];
  /** Bursts scale up over their lifetime; ghosts stay put. */
  scaleFrom?: number;
  scaleTo?: number;
}

// ============================================================================
// System
// ============================================================================

export class TeleportEffect {
  private static instance: TeleportEffect | null = null;
  private scene: Scene | null = null;
  private effects: ActiveEffect[] = [];
  private observer: Observer<Scene> | null = null;
  private lastTime = 0;

  private constructor() {}

  static getInstance(): TeleportEffect {
    if (!TeleportEffect.instance) {
      TeleportEffect.instance = new TeleportEffect();
    }
    return TeleportEffect.instance;
  }

  /** Idempotent scene hookup; survives scene changes. */
  private ensureScene(scene: Scene): void {
    if (this.scene === scene && this.observer) return;
    if (this.scene && this.observer) {
      this.scene.onBeforeRenderObservable.remove(this.observer);
    }
    // Effects belong to the old scene — drop them.
    for (const fx of this.effects) {
      try {
        fx.root.dispose();
        fx.material.dispose();
      } catch (_) {
        /* noop */
      }
    }
    this.effects = [];
    this.scene = scene;
    this.lastTime = performance.now();
    this.observer = scene.onBeforeRenderObservable.add(() => this.update());
  }

  /**
   * Full teleport effect for a player with a visible model (remote players):
   * ghost + burst at the entry, ghost + burst at the exit.
   *
   * Called BEFORE the renderer moves the model, so the source anchor still
   * stands at the ENTRY — the entry ghost clones it in place (zero delta) and
   * the exit ghost is offset by (to − from). Exact placement by construction,
   * no anchor-offset math.
   */
  playerTeleported(
    scene: Scene,
    model: PlayerModelInstance | null,
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    fromYaw: number,
    toYaw: number,
    team: "alpha" | "bravo",
  ): void {
    this.ensureScene(scene);
    if (model) {
      this.spawnGhost(model, { x: 0, y: 0, z: 0 }, fromYaw, team);
      this.spawnGhost(model, { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }, toYaw, team);
    }
    this.spawnBurst(from);
    this.spawnBurst(to);
  }

  /**
   * Local-player effect (no third-person model to ghost — other clients
   * render our ghosts from their own remote view): burst at the entry, and
   * the exit burst thrown ~90u ahead along the exit yaw at eye height so the
   * player flies THROUGH the speed-lines instead of leaving them at their
   * own chest (invisible from first person).
   */
  localTeleported(
    scene: Scene,
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    exitYaw: number,
  ): void {
    this.ensureScene(scene);
    this.spawnBurst(from);
    this.spawnBurst({
      x: to.x + Math.sin(exitYaw) * 90,
      y: to.y + 26, // chest offset (8) + up to eye line (34)
      z: to.z + Math.cos(exitYaw) * 90,
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Ghost
  // ──────────────────────────────────────────────────────────────

  private spawnGhost(
    model: PlayerModelInstance,
    delta: { x: number; y: number; z: number },
    yaw: number,
    team: "alpha" | "bravo",
  ): void {
    if (!this.scene || this.effects.length >= MAX_EFFECTS) return;

    try {
      // Clone the anchor hierarchy (anchor transform + skinned mesh children).
      // Cloned meshes share the source skeleton → the ghost holds a live pose.
      // The clone starts EXACTLY where the source model stands (the entry);
      // `delta` relocates it (zero for the entry ghost, to−from for the exit).
      const ghostRoot = model.anchor.clone(`tp_ghost_${Date.now()}`, null, false);
      if (!ghostRoot) return;

      ghostRoot.position.set(
        model.anchor.position.x + delta.x,
        model.anchor.position.y + delta.y,
        model.anchor.position.z + delta.z,
      );
      ghostRoot.rotation = model.anchor.rotation.clone();
      ghostRoot.rotation.y = yaw;
      ghostRoot.scaling = model.anchor.scaling.clone();

      // Flat unlit team-color silhouette — one shared material for the ghost.
      const mat = new StandardMaterial(`tp_ghost_mat_${Date.now()}`, this.scene);
      mat.emissiveColor = TEAM_COLORS[team];
      mat.diffuseColor = Color3.Black();
      mat.specularColor = Color3.Black();
      mat.disableLighting = true;
      mat.alpha = GHOST_ALPHA_STEPS[0];
      mat.backFaceCulling = false;

      const meshes = ghostRoot instanceof Mesh ? [ghostRoot, ...ghostRoot.getChildMeshes()] : ghostRoot.getChildMeshes();
      for (const m of meshes) {
        m.material = mat;
        m.isPickable = false;
        m.alwaysSelectAsActiveMesh = true;
      }

      this.effects.push({
        root: ghostRoot,
        material: mat,
        elapsedMs: 0,
        lifetimeMs: GHOST_LIFETIME_MS,
        alphaSteps: GHOST_ALPHA_STEPS,
      });
    } catch (e) {
      console.warn("[TeleportEffect] ghost spawn failed:", e);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Speed-line burst
  // ──────────────────────────────────────────────────────────────

  private spawnBurst(pos: { x: number; y: number; z: number }): void {
    if (!this.scene || this.effects.length >= MAX_EFFECTS) return;

    try {
      const mesh = this.buildStarburstMesh();
      mesh.position.set(pos.x, pos.y + BURST_Y_OFFSET, pos.z);
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
      mesh.scaling.setAll(BURST_START_SCALE);
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;

      const mat = new StandardMaterial(`tp_burst_mat_${Date.now()}`, this.scene);
      mat.emissiveColor = BURST_COLOR;
      mat.diffuseColor = Color3.Black();
      mat.specularColor = Color3.Black();
      mat.disableLighting = true;
      mat.alpha = BURST_ALPHA_STEPS[0];
      mat.backFaceCulling = false;
      mesh.material = mat;

      this.effects.push({
        root: mesh,
        material: mat,
        elapsedMs: 0,
        lifetimeMs: BURST_LIFETIME_MS,
        alphaSteps: BURST_ALPHA_STEPS,
        scaleFrom: BURST_START_SCALE,
        scaleTo: BURST_END_SCALE,
      });
    } catch (e) {
      console.warn("[TeleportEffect] burst spawn failed:", e);
    }
  }

  /** Radial fan of tapered spikes in the local XY plane (billboarded to camera). */
  private buildStarburstMesh(): Mesh {
    const positions: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i < BURST_SPIKES; i++) {
      const angle = (i / BURST_SPIKES) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      // Perpendicular for the spike base width
      const px = -sin;
      const py = cos;

      const baseIndex = positions.length / 3;
      // Two base corners at the inner radius, tip at the outer radius
      positions.push(
        cos * BURST_INNER_RADIUS + px * BURST_BASE_HALF_WIDTH,
        sin * BURST_INNER_RADIUS + py * BURST_BASE_HALF_WIDTH,
        0,
        cos * BURST_INNER_RADIUS - px * BURST_BASE_HALF_WIDTH,
        sin * BURST_INNER_RADIUS - py * BURST_BASE_HALF_WIDTH,
        0,
        cos * BURST_OUTER_RADIUS,
        sin * BURST_OUTER_RADIUS,
        0,
      );
      indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
    }

    const mesh = new Mesh(`tp_burst_${Date.now()}`, this.scene);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.applyToMesh(mesh);
    return mesh;
  }

  // ──────────────────────────────────────────────────────────────
  // Update / dispose
  // ──────────────────────────────────────────────────────────────

  private update(): void {
    if (this.effects.length === 0) return;

    const now = performance.now();
    const dtMs = Math.min(100, now - this.lastTime);
    this.lastTime = now;

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.elapsedMs += dtMs;

      if (fx.elapsedMs >= fx.lifetimeMs) {
        try {
          fx.root.dispose(false, false);
          fx.material.dispose();
        } catch (_) {
          /* noop */
        }
        this.effects.splice(i, 1);
        continue;
      }

      // Posterized fade: floor into discrete alpha steps (print frames).
      const step = Math.min(fx.alphaSteps.length - 1, Math.floor((fx.elapsedMs / fx.lifetimeMs) * fx.alphaSteps.length));
      fx.material.alpha = fx.alphaSteps[step];

      // Bursts scale up smoothly (motion reads better continuous).
      if (fx.scaleFrom !== undefined && fx.scaleTo !== undefined && fx.root instanceof Mesh) {
        const t = fx.elapsedMs / fx.lifetimeMs;
        fx.root.scaling.setAll(fx.scaleFrom + (fx.scaleTo - fx.scaleFrom) * t);
      }
    }
  }

  dispose(): void {
    if (this.scene && this.observer) {
      this.scene.onBeforeRenderObservable.remove(this.observer);
      this.observer = null;
    }
    for (const fx of this.effects) {
      try {
        fx.root.dispose();
        fx.material.dispose();
      } catch (_) {
        /* noop */
      }
    }
    this.effects = [];
    this.scene = null;
  }
}
