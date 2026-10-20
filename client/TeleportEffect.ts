/**
 * TeleportEffect — washoi manga teleporter VFX (WO-T4b)
 *
 * Two pieces, both cheap and print-styled (docs/research/triggerbrushes-and-targets.md):
 *
 * 1. GHOST — a posterized afterimage silhouette (Warsow's transparent outline,
 *    celified): a flat unlit team-color player figure fading out in DISCRETE
 *    alpha steps (print/anime frames, not a smooth ghost). GENERIC by design:
 *    the effect owns a small POOL of dedicated vanguard instances (everyone
 *    uses the same model), so it works identically for remote players AND for
 *    yourself — turn around after a tele and your own afterimage is standing
 *    at the entry. Spawned at BOTH entry and exit for remote players (arcade
 *    info: tele usage is trackable); entry-only for the local player (the
 *    exit ghost would sit inside your camera).
 *
 * 2. BURST — a radial manga speed-line starburst (two interleaved procedural
 *    fans, camera-billboarded, the inner one spinning) that pops and vanishes.
 *
 * Self-updating via an onBeforeRender observer (same pattern as
 * CartoonHitEffect). All effects hard-cap + self-dispose. Call prewarm()
 * after map load so the first teleport doesn't miss its ghost while the
 * pool model streams in.
 */

import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import { AudioManager } from "../../../engine/AudioManager";
import { type PlayerModelInstance, PlayerModelManager } from "../../../engine/animation/PlayerModelManager";
import { devLog } from "./DevLog";

// ============================================================================
// Constants
// ============================================================================

/** Ghost lifetime (ms) and its discrete alpha steps (posterized fade). */
const GHOST_LIFETIME_MS = 450;
const GHOST_ALPHA_STEPS = [0.85, 0.55, 0.3, 0.12];

/** Pooled ghost model instances (entry+exit × a couple of simultaneous teles). */
const GHOST_POOL_SIZE = 4;

/** Model anchor offset from the player origin (feet − MODEL_Y_OFFSET; matches RemotePlayerRenderer). */
const GHOST_ANCHOR_Y_OFFSET = -12;

/** Player model scale (Mixamo → Q3 units; matches RemotePlayerRenderer.MODEL_SCALE). */
const GHOST_MODEL_SCALE = 36;

/** Burst lifetime (ms), alpha steps, and scale ramp. */
const BURST_LIFETIME_MS = 420;
const BURST_ALPHA_STEPS = [0.95, 0.7, 0.45, 0.2];
const BURST_START_SCALE = 0.5;
const BURST_END_SCALE = 1.6;

/**
 * Entry "implosion": the same speed-line star, but it starts large and collapses
 * INWARD — reads as the player being sucked into the portal (in-going), the
 * opposite of the exit burst that explodes outward. Same builder, reversed ramp.
 */
const IMPLOSION_START_SCALE = 1.9;
const IMPLOSION_END_SCALE = 0.2;

/** Teleport entry sfx (Warsow sounds/world). Played 2D for self, 3D for others. */
const TELE_IN_SOUND = "sounds/world/tele_in.ogg";

/** Slow spin over the burst's life (radians) — reads as motion, not a static star. */
const BURST_SPIN_RAD = 0.9;

/** Starburst geometry: N tapered spikes between the two radii. */
const BURST_SPIKES = 16;
const BURST_INNER_RADIUS = 20;
const BURST_OUTER_RADIUS = 84;
const BURST_BASE_HALF_WIDTH = 2.5;

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
  /** Burst child that spins in view space (parent is billboarded; its own rotation is overridden). */
  spinMesh?: Mesh;
  /** Pooled ghost slot to release (disable, not dispose) when the effect ends. */
  ghostSlot?: GhostSlot;
}

interface GhostSlot {
  instance: PlayerModelInstance;
  material: StandardMaterial;
  busy: boolean;
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

  // Generic ghost pool (own vanguard instances — see header)
  private ghostManager: PlayerModelManager | null = null;
  private ghostPool: GhostSlot[] = [];
  private ghostPoolLoading = false;

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
    // Effects + pool belong to the old scene — drop them.
    for (const fx of this.effects) {
      if (fx.ghostSlot) continue; // pool instances are torn down below
      try {
        fx.root.dispose();
        fx.material.dispose();
      } catch (_) {
        /* noop */
      }
    }
    this.effects = [];
    this.disposeGhostPool();
    this.scene = scene;
    this.lastTime = performance.now();
    this.observer = scene.onBeforeRenderObservable.add(() => this.update());
  }

  /**
   * Load the ghost model pool ahead of time (call after map load) so the
   * FIRST teleport already has its afterimage. Without prewarm the pool
   * lazy-loads on first use and that teleport shows bursts only.
   */
  prewarm(scene: Scene): void {
    this.ensureScene(scene);
    void this.ensureGhostPool();
    // Predecode the entry sfx so the first teleport isn't silent while it streams.
    void AudioManager.getInstance().preloadSfx([TELE_IN_SOUND]);
  }

  private async ensureGhostPool(): Promise<void> {
    if (!this.scene || this.ghostPoolLoading || this.ghostPool.length > 0) return;
    this.ghostPoolLoading = true;

    try {
      // Own manager, idle-only animation set (vanguard.glb + one anim GLB —
      // both already browser-cached by the remote-player renderer).
      this.ghostManager = new PlayerModelManager(this.scene);
      await this.ghostManager.loadModel(undefined, undefined, [{ name: "idle", file: "rifle aiming idle.glb" }]);

      for (let i = 0; i < GHOST_POOL_SIZE; i++) {
        const instance = this.ghostManager.createInstance(`tp_ghost_${i}`, GHOST_MODEL_SCALE);
        if (!instance) continue;
        this.ghostManager.playAnimation(instance, "idle");

        // One flat unlit silhouette material per slot (recolored per use).
        const mat = new StandardMaterial(`tp_ghost_mat_${i}`, this.scene);
        mat.emissiveColor = TEAM_COLORS.alpha;
        mat.diffuseColor = Color3.Black();
        mat.specularColor = Color3.Black();
        mat.disableLighting = true;
        mat.alpha = GHOST_ALPHA_STEPS[0];
        mat.backFaceCulling = false;

        instance.mesh.material = mat;
        for (const m of instance.mesh.getChildMeshes()) {
          m.material = mat;
          m.isPickable = false;
        }
        instance.anchor.setEnabled(false);

        this.ghostPool.push({ instance, material: mat, busy: false });
      }
      devLog(`[TeleportEffect] ghost pool ready (${this.ghostPool.length} instances)`);
    } catch (e) {
      console.warn("[TeleportEffect] ghost pool load failed:", e);
      this.ghostManager = null;
      this.ghostPool = [];
    } finally {
      this.ghostPoolLoading = false;
    }
  }

  private disposeGhostPool(): void {
    for (const slot of this.ghostPool) {
      try {
        this.ghostManager?.disposeInstance(slot.instance);
        slot.material.dispose();
      } catch (_) {
        /* noop */
      }
    }
    this.ghostPool = [];
    try {
      this.ghostManager?.dispose();
    } catch (_) {
      /* noop */
    }
    this.ghostManager = null;
  }

  /**
   * Full teleport effect for a REMOTE player: generic pooled ghost + burst
   * at the entry, and again at the exit (arcade info both ways).
   */
  playerTeleported(
    scene: Scene,
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    fromYaw: number,
    toYaw: number,
    team: "alpha" | "bravo",
  ): void {
    this.ensureScene(scene);
    // Entry (in-going): ghost afterimage + imploding speed-lines + 3D sfx so the
    // grab of a remote player reads as "sucked in", not a silent disappearance.
    AudioManager.getInstance().playSfx3D(TELE_IN_SOUND, from, { volume: 0.85 });
    this.spawnGhost(from, fromYaw, team);
    this.spawnImplosion(from);
    // Exit (out-going): ghost + exploding burst.
    this.spawnGhost(to, toYaw, team);
    this.spawnBurst(to);
  }

  /**
   * Local-player effect: your OWN afterimage at the entry (turn around after
   * the tele and you're standing there — the effect is generic, pool-based,
   * not tied to remote rendering), burst at the entry, and the exit burst
   * thrown ~90u ahead along the exit yaw at eye height so you fly THROUGH
   * the speed-lines. No exit ghost for self — it would sit inside the camera.
   */
  localTeleported(
    scene: Scene,
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    entryYaw: number,
    exitYaw: number,
    team: "alpha" | "bravo" = "alpha",
  ): void {
    this.ensureScene(scene);
    // In-going feedback the local player actually perceives: a 2D entry sfx (you
    // hear yourself get pulled in) + imploding speed-lines at the entry. The entry
    // ghost sits behind the camera post-teleport, so on its own it read as just
    // vanishing — the sound + implosion fix that.
    AudioManager.getInstance().playSfx2D(TELE_IN_SOUND, 0.8, 2);
    this.spawnGhost(from, entryYaw, team);
    this.spawnImplosion(from);
    // Out-going: exit burst thrown ~90u ahead at eye height so you fly THROUGH it.
    this.spawnBurst({
      x: to.x + Math.sin(exitYaw) * 90,
      y: to.y + 26, // chest offset (8) + up to eye line (34)
      z: to.z + Math.cos(exitYaw) * 90,
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Ghost
  // ──────────────────────────────────────────────────────────────

  /**
   * Place a pooled ghost instance at a player-origin position. If the pool
   * isn't loaded yet, kick the load and skip (bursts still play; the next
   * teleport has ghosts — prewarm() avoids even that).
   */
  private spawnGhost(pos: { x: number; y: number; z: number }, yaw: number, team: "alpha" | "bravo"): void {
    if (!this.scene) return;
    if (this.ghostPool.length === 0) {
      void this.ensureGhostPool();
      return;
    }

    const slot = this.ghostPool.find((s) => !s.busy);
    if (!slot) return; // all ghosts on stage — skip rather than steal mid-fade

    try {
      slot.busy = true;
      slot.material.emissiveColor = TEAM_COLORS[team];
      slot.material.alpha = GHOST_ALPHA_STEPS[0];

      const anchor = slot.instance.anchor;
      anchor.position.set(pos.x, pos.y + GHOST_ANCHOR_Y_OFFSET, pos.z);
      if (anchor.rotationQuaternion) anchor.rotationQuaternion = null;
      anchor.rotation.set(0, yaw, 0);
      anchor.setEnabled(true);
      slot.instance.mesh.isVisible = true;
      for (const m of slot.instance.mesh.getChildMeshes()) {
        m.isVisible = true;
      }

      this.effects.push({
        root: anchor,
        material: slot.material,
        elapsedMs: 0,
        lifetimeMs: GHOST_LIFETIME_MS,
        alphaSteps: GHOST_ALPHA_STEPS,
        ghostSlot: slot,
      });
    } catch (e) {
      slot.busy = false;
      console.warn("[TeleportEffect] ghost spawn failed:", e);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Speed-line burst
  // ──────────────────────────────────────────────────────────────

  /** Entry counterpart to spawnBurst — same star, collapsing inward (in-going). */
  private spawnImplosion(pos: { x: number; y: number; z: number }): void {
    this.spawnBurst(pos, true);
  }

  private spawnBurst(pos: { x: number; y: number; z: number }, implode = false): void {
    if (!this.scene || this.effects.length >= MAX_EFFECTS) return;

    const startScale = implode ? IMPLOSION_START_SCALE : BURST_START_SCALE;
    const endScale = implode ? IMPLOSION_END_SCALE : BURST_END_SCALE;

    try {
      // Billboard the PARENT and spin the child: with billboardMode set,
      // Babylon overrides the node's own rotation, so the spin must live one
      // level below the billboarded transform.
      const mesh = this.buildStarburstMesh();
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
      mesh.position.set(pos.x, pos.y + BURST_Y_OFFSET, pos.z);
      mesh.scaling.setAll(startScale);

      const spin = this.buildStarburstMesh();
      spin.parent = mesh;
      spin.position.setAll(0);
      spin.rotation.z = Math.PI / BURST_SPIKES; // interleave the two fans
      spin.scaling.setAll(0.8);
      spin.isPickable = false;
      spin.alwaysSelectAsActiveMesh = true;

      const mat = new StandardMaterial(`tp_burst_mat_${Date.now()}`, this.scene);
      mat.emissiveColor = BURST_COLOR;
      mat.diffuseColor = Color3.Black();
      mat.specularColor = Color3.Black();
      mat.disableLighting = true;
      mat.alpha = BURST_ALPHA_STEPS[0];
      mat.backFaceCulling = false;
      mesh.material = mat;
      spin.material = mat;

      this.effects.push({
        root: mesh,
        material: mat,
        elapsedMs: 0,
        lifetimeMs: BURST_LIFETIME_MS,
        alphaSteps: BURST_ALPHA_STEPS,
        scaleFrom: startScale,
        scaleTo: endScale,
        spinMesh: spin,
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
    // The clock runs while idle too. Left at the last effect's end, the first
    // frame of the next teleport counted the whole idle gap, capped at 100 ms,
    // and the ghosts lost that much of their life (E6).
    const now = performance.now();
    const dtMs = Math.min(100, now - this.lastTime);
    this.lastTime = now;
    if (this.effects.length === 0) return;

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.elapsedMs += dtMs;

      if (fx.elapsedMs >= fx.lifetimeMs) {
        if (fx.ghostSlot) {
          // Pooled ghost: hide + release, never dispose.
          try {
            fx.ghostSlot.instance.anchor.setEnabled(false);
          } catch (_) {
            /* noop */
          }
          fx.ghostSlot.busy = false;
        } else {
          try {
            fx.root.dispose(false, false);
            fx.material.dispose();
          } catch (_) {
            /* noop */
          }
        }
        this.effects.splice(i, 1);
        continue;
      }

      // Posterized fade: floor into discrete alpha steps (print frames).
      const step = Math.min(
        fx.alphaSteps.length - 1,
        Math.floor((fx.elapsedMs / fx.lifetimeMs) * fx.alphaSteps.length),
      );
      fx.material.alpha = fx.alphaSteps[step];

      // Bursts scale up + spin smoothly (motion reads better continuous).
      if (fx.scaleFrom !== undefined && fx.scaleTo !== undefined && fx.root instanceof Mesh) {
        const t = fx.elapsedMs / fx.lifetimeMs;
        fx.root.scaling.setAll(fx.scaleFrom + (fx.scaleTo - fx.scaleFrom) * t);
        // The parent is billboarded (its rotation is overridden by Babylon) —
        // spin the CHILD fan around the view axis instead.
        if (fx.spinMesh) {
          fx.spinMesh.rotation.z = Math.PI / BURST_SPIKES + BURST_SPIN_RAD * t;
        }
      }
    }
  }

  dispose(): void {
    if (this.scene && this.observer) {
      this.scene.onBeforeRenderObservable.remove(this.observer);
      this.observer = null;
    }
    for (const fx of this.effects) {
      if (fx.ghostSlot) continue; // pool instances are torn down below
      try {
        fx.root.dispose();
        fx.material.dispose();
      } catch (_) {
        /* noop */
      }
    }
    this.effects = [];
    this.disposeGhostPool();
    this.scene = null;
  }
}
