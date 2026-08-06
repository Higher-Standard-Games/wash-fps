/**
 * RemotePlayerRenderer — Renders 3D models + hitbox wireframes for remote entities
 *
 * Each remote player gets:
 * - A `PlayerModelInstance` (vanguard.glb clone) with animation state machine
 * - An optional wireframe hitbox overlay (toggled via `cl_remotehitbox` cvar)
 *
 * Architecture:
 * - pushSnapshot() feeds entity data into SnapshotBuffer (~30Hz from server)
 * - render() samples interpolated positions every frame, positions models,
 *   derives animation state from velocity/grounded/yaw, and plays animations
 */

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { type PlayerModelInstance, PlayerModelManager } from "../../../engine/animation/PlayerModelManager";
import { Cvar } from "../../../engine/core/Cvar";
import { applySafeMaxSimultaneousLights } from "../../../engine/lighting/DynamicLightSafety";
import {
  type EntitySnapshot,
  type InterpolatedEntity,
  SnapshotBuffer,
} from "../../../engine/network/client/SnapshotBuffer";
import type { GameState } from "../../../engine/network/core/GameState";
import { getHitscanEffects } from "../../../engine/weapon/HitscanEffects";
import type { VoltaicRemoteStartResolver } from "../../../engine/weapon/voltaic/VoltaicEffectRenderer";
import { WEAPONS } from "../../../shared/entities/definitions/weapons/WeaponsTable";
import { maskHasPowerup } from "../../../shared/items/Powerups";
import { isClientKey } from "../ClientEntityKey";
import { DemoAnimationTimeline } from "./DemoAnimationTimeline";
import { DemoEntityTimeline } from "./DemoEntityTimeline";
import {
  getPlayerModelVisualStyle,
  getPlayerModelVisualStyleKey,
  getPlayerTeamSlot,
  type PlayerTeamSlot,
  registerPlayerModelVisualCvars,
} from "./PlayerModelVisualSettings";
import { installTeamColorBridge } from "./TeamColorBridge";

// ─── Types ───────────────────────────────────────────────────────

/** Per-entity hitbox wrapper */
interface RemotePlayerHitbox {
  mesh: Mesh;
  smoothedPos: Vector3;
  smoothedYaw: number;
  /** Current hitbox height (56 standing, 36 crouching) */
  currentHeight: number;
  /** 3D model instance (null until model loads) */
  model: PlayerModelInstance | null;
  /** Root node of weapon model attached to hand bone */
  weaponRoot: TransformNode | null;
  /** Authored tag_flash carried with the attached weapon hierarchy. */
  weaponMuzzle: TransformNode | null;
  /** Reference to RightHand bone transform node for per-frame tracking */
  handBone: TransformNode | null;
  /** Current weapon ID string (for detecting weapon switches) */
  currentWeaponId: string;
  /** Last applied visual style key; changes when team slot or cvars change. */
  appliedVisualStyleKey: string | null;
  /** True while this player was last seen carrying a powerup (drives the glow). */
  powerupGlowActive: boolean;
}

// ─── Powerup carrier glow ────────────────────────────────────────

/** Quad carrier glow colour — red reads as "danger", not as a team tint. */
const QUAD_GLOW_COLOR = new Color3(1.0, 0.12, 0.08);
/** Pulse rate of the carrier glow (cycles/sec). */
const QUAD_PULSE_HZ = 1.5;
/** Emissive lift at the trough / peak of the pulse. */
const QUAD_GLOW_MIN = 0.35;
const QUAD_GLOW_MAX = 0.85;
/** Outline width at the trough / peak (world units, pre-model-scale). */
const QUAD_OUTLINE_MIN = 0.9;
const QUAD_OUTLINE_MAX = 1.7;

// ─── Constants (Q3-style player bounds) ──────────────────────────

/** Horizontal collision radius */
const PLAYER_RADIUS = 16;

/** Box extends 24 units below origin (to feet) */
const PLAYER_MINS_Z = -24;

/** Box extends 40 units above origin (to head) */
const PLAYER_MAXS_Z = 40;

/** Total standing height: 64 */
const PLAYER_HEIGHT = PLAYER_MAXS_Z - PLAYER_MINS_Z;

/** Crouched mins Z — box extends 4 units below origin */
const CROUCH_MINS_Z = -4;

/** Total crouched height: 36 */
const CROUCH_HEIGHT = PLAYER_MAXS_Z - CROUCH_MINS_Z;

// ─── Renderer ────────────────────────────────────────────────────

// ─── Model scale (Mixamo → Q3/BSP units) ────────────────────────
const MODEL_SCALE = 36;

// ─── Model Y offset (fine-tune feet vs floor alignment) ──
// The anchor is placed at the player's feet (origin + PLAYER_MINS_Z = origin−24)
// plus this offset. The Mixamo vanguard mesh's local origin sits at its feet, so
// the offset should be ~0. It was previously 12, which floated remote players
// ~12u off the floor while walking (reported 2026-07-12). Browser-confirm the
// exact value if feet clip into / hover above the floor.
const MODEL_Y_OFFSET = 0;

// ─── Animation derivation constants ─────────────────────────────
const IDLE_SPEED_THRESHOLD = 50;
const RUN_SPEED_THRESHOLD = 300;

// Mixamo animation natural speeds (Q3 units/s at 1x playback)
// Lower values → higher speedRatio → faster feet to match actual movement.
// Tuned so feet track the ground at game speeds (maxSpeed=280, runSpeed=350).
const WALK_NATURAL_SPEED = 40;
const RUN_NATURAL_SPEED = 100;
const STRAFE_NATURAL_SPEED = 29;

// Jump velocity for normalizing animation scrub (matches MovementProfile.jumpVelocity)
const JUMP_VELOCITY = 320;

export class RemotePlayerRenderer {
  private scene: Scene;
  private hitboxes: Map<string, RemotePlayerHitbox> = new Map();
  private snapshotBuffer: SnapshotBuffer = new SnapshotBuffer();
  private demoTimeline: DemoEntityTimeline | null = null;
  private demoPlayheadTick: number = 0;
  private demoAnimationTimeScale: number = 1;
  private demoDiscontinuityId: number = -1;
  private demoAnimationTimeline: DemoAnimationTimeline | null = null;
  /** Entities marked dead — value is death timestamp (performance.now) */
  private deadEntities: Map<string, number> = new Map();

  /** Shared model manager — loads vanguard.glb once, creates cloned instances */
  private modelManager: PlayerModelManager | null = null;
  private modelLoadPromise: Promise<void> | null = null;

  /** Reference to enemyWeapons from GameEventContext — maps entityId → weaponId */
  private enemyWeapons: Map<string, string> = new Map();

  /** entityId → server team id ("udon"/"soba"/"spectator"), from snapshot players */
  private teams: Map<string, string> = new Map();

  /** Entity whose mesh+model should be hidden (e.g. followed player in demo POV) */
  private _hiddenEntityId: string | null = null;

  /** Per-entity throttle timestamps for cl_animdebug logging */
  private _lastAnimLog: Map<string, number> = new Map();

  /** Per-playhead memo for getDemoEntitySample (followed entity is sampled 3×/frame). */
  private _demoSampleCache: { entityId: string; tick: number; sample: InterpolatedEntity | null } | null = null;
  private readonly voltaicMuzzleResolver: VoltaicRemoteStartResolver = (entityId, direction, result) =>
    this.getWeaponMuzzleWorldPositionToRef(entityId, direction, result);

  constructor(scene: Scene) {
    this.scene = scene;
    registerPlayerModelVisualCvars();
    // Same colours the models are about to wear, published to CSS so the HUD
    // and the lobby cannot disagree with the map.
    installTeamColorBridge();
    getHitscanEffects().setRemoteLightningMuzzleResolver(this.voltaicMuzzleResolver);
  }

  /** Set reference to enemy weapons map from GameEventContext */
  setEnemyWeapons(weapons: Map<string, string>): void {
    this.enemyWeapons = weapons;
  }

  /** Enable deterministic recorded-tick sampling instead of live network buffering. */
  enableDemoPlayback(): void {
    this.demoTimeline = new DemoEntityTimeline();
    this.demoAnimationTimeline = new DemoAnimationTimeline();
    this.demoDiscontinuityId = -1;
  }

  setDemoPlaybackState(
    playheadTick: number,
    playbackSpeed: number,
    paused: boolean,
    discontinuityId: number,
    tickRate: number = 60,
  ): void {
    if (!this.demoTimeline) this.enableDemoPlayback();
    // Called from both the frame-delivery path and the render loop — skip the
    // full one-shot reconcile (a walk over every model) when nothing changed.
    if (
      playheadTick === this.demoPlayheadTick &&
      discontinuityId === this.demoDiscontinuityId &&
      this.demoAnimationTimeScale === (paused ? 0 : playbackSpeed)
    ) {
      return;
    }
    if (discontinuityId !== this.demoDiscontinuityId) {
      this.demoTimeline?.clear();
      this.demoDiscontinuityId = discontinuityId;
    }
    this.demoPlayheadTick = playheadTick;
    this.demoAnimationTimeScale = paused ? 0 : playbackSpeed;
    this._demoSampleCache = null; // playhead moved — per-frame sample memo is stale
    const animationDiscontinuity =
      this.demoAnimationTimeline?.setClock(playheadTick, tickRate, playbackSpeed, paused, discontinuityId) ?? false;
    if (animationDiscontinuity) this.stopAllDemoOneShots();
    this.syncDemoOneShots();
  }

  /**
   * Hide the mesh + model for a specific entity (e.g. the followed player in demo POV).
   * Restores the previously hidden entity before hiding the new one.
   * Pass null to unhide all.
   */
  setHiddenEntity(entityId: string | null): void {
    // Restore previously hidden entity
    if (this._hiddenEntityId !== null) {
      const old = this.hitboxes.get(this._hiddenEntityId);
      if (old) {
        if (old.model) old.model.anchor.setEnabled(true);
        if (old.weaponRoot) old.weaponRoot.setEnabled(true);
      }
    }
    this._hiddenEntityId = entityId;
    // Immediately hide the new target if its hitbox already exists
    if (entityId !== null) {
      const hitbox = this.hitboxes.get(entityId);
      if (hitbox) {
        hitbox.mesh.setEnabled(false);
        if (hitbox.model) hitbox.model.anchor.setEnabled(false);
        if (hitbox.weaponRoot) hitbox.weaponRoot.setEnabled(false);
      }
    }
  }

  // ── Model Loading ────────────────────────────────────────────

  private async ensureModelLoaded(): Promise<void> {
    if (this.modelManager?.isLoaded) return;
    if (this.modelLoadPromise) {
      await this.modelLoadPromise;
      return;
    }

    this.modelManager = new PlayerModelManager(this.scene);
    this.modelLoadPromise = (async () => {
      await this.modelManager!.loadModel();
      console.log("[RemotePlayerRenderer] Player model loaded");

      // Create model instances for any hitboxes that were created before model loaded
      for (const [entityId, hitbox] of this.hitboxes) {
        if (!hitbox.model) {
          hitbox.model = this.createModelInstance(entityId);
        }
      }
    })();

    try {
      await this.modelLoadPromise;
    } catch (err) {
      console.error("[RemotePlayerRenderer] Failed to load player model:", err);
    } finally {
      this.modelLoadPromise = null;
    }
  }

  private createModelInstance(entityId: string): PlayerModelInstance | null {
    if (!this.modelManager?.isLoaded) return null;
    const instance = this.modelManager.createInstance(entityId, MODEL_SCALE);
    if (instance) {
      // Start with idle animation
      this.modelManager.playAnimation(instance, "idle");
      this.applyModelVisualStyle(instance, entityId);
    }
    return instance;
  }

  /** The viewer's own side, so everyone else can be read as ally or enemy. */
  private localTeam: string | null = null;

  setLocalTeam(teamId: string | null | undefined): void {
    this.localTeam = teamId ?? null;
  }

  private resolvePlayerTeamSlot(entityId: string): PlayerTeamSlot {
    return getPlayerTeamSlot(this.teams.get(entityId), this.localTeam);
  }

  /** Keep legacy alpha/bravo names for older cosmetic effects. */
  private resolveLegacyTeamColor(entityId: string): "alpha" | "bravo" {
    const slot = this.resolvePlayerTeamSlot(entityId);
    if (slot === "ally") return "alpha";
    if (slot === "enemy") return "bravo";
    const hash = entityId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    return hash % 2 === 0 ? "alpha" : "bravo";
  }

  private applyModelVisualStyle(instance: PlayerModelInstance, entityId: string): string {
    const slot = this.resolvePlayerTeamSlot(entityId);
    const style = getPlayerModelVisualStyle(slot, MODEL_SCALE);
    this.modelManager?.applyVisualStyle(instance, style);
    return getPlayerModelVisualStyleKey(slot);
  }

  /**
   * Force a self-lit style on a detached showcase model (post-game winner).
   * Keeps the team tint/outline but forces fullbright emissive on regardless of
   * the `cl_player_fullbright` cvar, so the winner is a clear hero shot even
   * when the camera-relative spawn spot is a dark corner of the map (otherwise
   * the model renders as a black silhouette — it's lit only by the scene).
   */
  applyShowcaseVisualStyle(instance: PlayerModelInstance, entityId: string): void {
    const slot = this.resolvePlayerTeamSlot(entityId);
    const base = getPlayerModelVisualStyle(slot, MODEL_SCALE);
    this.modelManager?.applyVisualStyle(instance, {
      ...base,
      fullbrightEnabled: true,
      fullbrightIntensity: Math.max(base.fullbrightIntensity, 0.6),
    });
  }

  private applyHitboxVisualStyle(hitbox: RemotePlayerHitbox, entityId: string): void {
    if (!hitbox.model) return;
    const key = getPlayerModelVisualStyleKey(this.resolvePlayerTeamSlot(entityId));
    if (hitbox.appliedVisualStyleKey === key) return;
    hitbox.appliedVisualStyleKey = this.applyModelVisualStyle(hitbox.model, entityId);
  }

  // ── Public API ───────────────────────────────────────────────

  /**
   * Push a new snapshot into the interpolation buffer.
   * Called once per server state update (~30Hz).
   *
   * @param state Server game state
   * @param localEntityId ID of local player's entity (excluded from rendering)
   * @param serverLocalTime Optional server timestamp converted to local time via ClockSync
   */
  pushSnapshot(state: GameState, localEntityId: string, serverLocalTime?: number): void {
    // Track team per entity for team-colored models (keyed by client entityId)
    for (const player of state.players.values()) {
      this.teams.set(player.entityId, player.team || "ffa");
      // Our own side comes from the same roster, so ally/enemy stays correct
      // through a side swap without anyone having to push it in.
      if (player.entityId === localEntityId) this.localTeam = player.team || null;
    }

    const entities = this.extractEntities(state, localEntityId);
    this.snapshotBuffer.push(state.tick, entities, serverLocalTime);
    this.clearRespawnedEntities(entities);
  }

  /** Push a full recorded frame into the deterministic demo timeline. */
  /**
   * @param lookahead - true when buffering a FUTURE frame for interpolation
   *   (render-loop getNextFrame). Lookahead pushes must not touch life-state
   *   bookkeeping: clearing deadEntities from a future frame un-hides corpses
   *   before the delivery path (_updateDemoLifeState) can re-mark them.
   */
  pushDemoSnapshot(state: GameState, localEntityId: string, lookahead = false): void {
    if (!this.demoTimeline) this.enableDemoPlayback();
    for (const player of state.players.values()) {
      this.teams.set(player.entityId, player.team || "ffa");
      // Our own side comes from the same roster, so ally/enemy stays correct
      // through a side swap without anyone having to push it in.
      if (player.entityId === localEntityId) this.localTeam = player.team || null;
    }
    const entities = this.extractEntities(state, localEntityId);
    this.demoTimeline?.push(state.tick, entities);
    if (!lookahead) {
      this.clearRespawnedEntities(entities);
    }
  }

  private extractEntities(state: GameState, localEntityId: string): Map<string, EntitySnapshot> {
    const entities = new Map<string, EntitySnapshot>();
    for (const [entityId, entity] of state.entities) {
      if (entityId === localEntityId) continue;
      if (!isClientKey(entityId)) continue;

      const transform = entity.getComponent("transform") as any;
      const velocity = entity.getComponent("velocity") as any;
      const movementState = entity.getComponent("movementState") as any;
      const powerups = entity.getComponent("powerups") as { mask?: number } | undefined;

      if (!transform?.position) continue;

      entities.set(entityId, {
        x: transform.position.x,
        y: transform.position.y,
        z: transform.position.z,
        yaw: transform.rotation?.y ?? 0,
        vx: velocity?.linear?.x ?? velocity?.x ?? 0,
        vy: velocity?.linear?.y ?? velocity?.y ?? 0,
        vz: velocity?.linear?.z ?? velocity?.z ?? 0,
        grounded: velocity?.grounded ?? true,
        crouching: movementState?.isCrouching ?? false,
        sliding: movementState?.isSliding ?? false,
        wallJumping: movementState?.wallJumpState === "charging",
        crouchViewOffset: movementState?.crouchViewOffset ?? 0,
        powerupMask: powerups?.mask ?? 0,
      });
    }
    return entities;
  }

  private clearRespawnedEntities(entities: Map<string, EntitySnapshot>): void {
    // Clear dead status ONLY when entity reappears in a fresh snapshot
    // (meaning the server has confirmed respawn with valid position data)
    for (const [entityId] of this.deadEntities) {
      if (entities.has(entityId)) {
        this.deadEntities.delete(entityId);
      }
    }
  }

  /**
   * Render all remote entities using interpolated positions.
   * Called every frame from the render loop.
   */
  render(): void {
    // Get all entities from latest snapshot for lifecycle management
    const aliveIds = this.demoTimeline
      ? this.demoTimeline.getEntityIds(this.demoPlayheadTick)
      : this.snapshotBuffer.getLatestEntityIds();

    // Sample interpolated state for each alive entity
    for (const entityId of aliveIds) {
      // Skip dead entities — their mesh is hidden until entity leaves snapshot
      if (this.deadEntities.has(entityId)) continue;

      const interp = this.demoTimeline
        ? this.demoTimeline.sample(entityId, this.demoPlayheadTick)
        : this.snapshotBuffer.sample(entityId);
      if (!interp) continue;

      let hitbox = this.hitboxes.get(entityId);

      // Create hitbox for new entity
      if (!hitbox) {
        const created = this.createHitbox(entityId, interp);
        if (created) {
          this.hitboxes.set(entityId, created);
          hitbox = created;
          // Trigger async model load on first remote player
          this.ensureModelLoaded();
        }
      }

      if (!hitbox) continue;

      // Hidden entity (followed player in demo POV) — keep invisible every frame.
      // Third-person weapons are bone-driven external roots, so hide them too.
      if (entityId === this._hiddenEntityId) {
        hitbox.mesh.setEnabled(false);
        if (hitbox.model) hitbox.model.anchor.setEnabled(false);
        if (hitbox.weaponRoot) hitbox.weaponRoot.setEnabled(false);
        continue;
      }

      // Ensure model is assigned — catches any timing gaps during initial load
      if (!hitbox.model && this.modelManager?.isLoaded) {
        hitbox.model = this.createModelInstance(entityId);
        if (hitbox.model) {
          console.log(`[RemotePlayerRenderer] Late model assign for ${entityId}`);
        }
      }

      // Ensure hitbox is visible (may have been hidden during death)
      const showHitbox = Cvar.get("cl_remotehitbox");
      hitbox.mesh.setEnabled(showHitbox !== undefined ? Number(showHitbox) > 0 : true);

      // Check if height changed (crouch/uncrouch) — rebuild hitbox mesh if so
      const targetHeight = interp.crouching ? CROUCH_HEIGHT : PLAYER_HEIGHT;
      if (hitbox.currentHeight !== targetHeight) {
        hitbox.mesh.dispose();
        const newMesh = this.createHitboxMesh(entityId, targetHeight);
        hitbox.mesh = newMesh;
        hitbox.currentHeight = targetHeight;
      }

      // Teleport detection: SnapshotBuffer snaps (no lerp) across >256u
      // inter-snapshot jumps, so a teleport arrives here as one huge
      // frame-to-frame delta. Play the washoi ghost + burst at both ends.
      // (Respawns create a fresh hitbox via markDead, so they don't fire.)
      const jdx = interp.x - hitbox.smoothedPos.x;
      const jdy = interp.y - hitbox.smoothedPos.y;
      const jdz = interp.z - hitbox.smoothedPos.z;
      if (jdx * jdx + jdy * jdy + jdz * jdz > RemotePlayerRenderer.TELEPORT_FX_DIST_SQ) {
        this.playTeleportEffect(hitbox, entityId, interp);
      }

      // Update position/rotation from interpolated data
      this.updatePosition(hitbox, interp);

      // Update model position + animation
      this.updateModel(hitbox, interp, entityId, this.demoTimeline ? this.demoAnimationTimeScale : 1);

      // Powerup carrier glow (pulses, so it must run every frame, not on change)
      this.updatePowerupGlow(hitbox, entityId, interp.powerupMask ?? 0, performance.now() / 1000);
    }

    // Remove hitboxes for entities no longer alive
    for (const [entityId, hitbox] of this.hitboxes) {
      if (!aliveIds.has(entityId)) {
        hitbox.mesh.dispose();
        if (hitbox.weaponRoot) {
          hitbox.weaponRoot.dispose(false, true);
          hitbox.weaponRoot = null;
        }
        if (hitbox.model && this.modelManager) {
          this.modelManager.disposeInstance(hitbox.model);
        }
        this.hitboxes.delete(entityId);
        this.deadEntities.delete(entityId);
        this.demoAnimationTimeline?.delete(entityId);
      }
    }
    this.demoAnimationTimeline?.finishPresentationFrame();
  }

  /**
   * Legacy update method — calls pushSnapshot + render for backward compat.
   * NOTE: Prefer using pushSnapshot() + render() separately for proper
   * decoupled interpolation. This method is only kept for smooth migration.
   */
  update(state: GameState, localEntityId: string): void {
    this.pushSnapshot(state, localEntityId);
    this.render();
  }

  /** Clean up all hitboxes and models */
  dispose(): void {
    getHitscanEffects().clearRemoteLightningMuzzleResolver(this.voltaicMuzzleResolver);
    for (const hitbox of this.hitboxes.values()) {
      hitbox.mesh.dispose();
      if (hitbox.weaponRoot) {
        hitbox.weaponRoot.dispose(false, true);
        hitbox.weaponRoot = null;
      }
      if (hitbox.model && this.modelManager) {
        this.modelManager.disposeInstance(hitbox.model);
      }
    }
    this.hitboxes.clear();
    this.deadEntities.clear();
    this.teams.clear();
    this.demoTimeline?.clear();
    this.demoTimeline = null;
    this.demoAnimationTimeline?.clear();
    this.demoAnimationTimeline = null;
    if (this.modelManager) {
      this.modelManager.dispose();
      this.modelManager = null;
    }
  }

  /**
   * Mark an entity as dead — dispose its mesh immediately.
   * Called from Game on death events.
   * A fresh hitbox will be created when the entity respawns and reappears in snapshots.
   */
  markDead(entityId: string): void {
    this.deadEntities.set(entityId, performance.now());
    this.demoAnimationTimeline?.delete(entityId);
    const hitbox = this.hitboxes.get(entityId);
    if (hitbox) {
      hitbox.mesh.dispose();
      if (hitbox.weaponRoot) {
        hitbox.weaponRoot.dispose(false, true);
        hitbox.weaponRoot = null;
      }
      if (hitbox.model && this.modelManager) {
        this.modelManager.disposeInstance(hitbox.model);
      }
      this.hitboxes.delete(entityId);
    }
  }

  /**
   * Create a standalone player model at a world position — used for the LOCAL
   * player's death ragdoll (the local player is otherwise excluded from
   * third-person rendering, so there's no existing model to detach). Not tracked
   * as a remote entity; ownership passes to the caller (RagdollSystem disposes it).
   */
  createDetachedModelAt(
    entityId: string,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ): import("../../../engine/animation/PlayerModelManager").PlayerModelInstance | null {
    const model = this.createModelInstance(entityId);
    if (!model) return null;
    model.anchor.position.set(x, y + PLAYER_MINS_Z + MODEL_Y_OFFSET, z);
    model.anchor.rotation.y = yaw;
    return model;
  }

  async createDetachedModelAtAsync(
    entityId: string,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ): Promise<import("../../../engine/animation/PlayerModelManager").PlayerModelInstance | null> {
    await this.ensureModelLoaded();
    return this.createDetachedModelAt(entityId, x, y, z, yaw);
  }

  /** Last known weapon id for a remote entity (from snapshots), or null. */
  getKnownWeaponId(entityId: string): string | null {
    return this.enemyWeapons.get(entityId) ?? null;
  }

  /** Best available remote muzzle: authored tag, weapon root, then eye pose. */
  getWeaponMuzzleWorldPosition(entityId: string, shotDirection: Vector3): Vector3 | null {
    const result = new Vector3();
    return this.getWeaponMuzzleWorldPositionToRef(entityId, shotDirection, result) ? result : null;
  }

  /** Allocation-free form used once per render frame by the retained Voltaic batch. */
  getWeaponMuzzleWorldPositionToRef(entityId: string, shotDirection: Vector3, result: Vector3): boolean {
    const hitbox = this.hitboxes.get(entityId);
    if (!hitbox) return false;

    const directionLength = Math.sqrt(shotDirection.lengthSquared());
    const inverseLength = directionLength > 0.0001 ? 1 / directionLength : 0;
    const forwardX = directionLength > 0.0001 ? shotDirection.x * inverseLength : 0;
    const forwardY = directionLength > 0.0001 ? shotDirection.y * inverseLength : 0;
    const forwardZ = directionLength > 0.0001 ? shotDirection.z * inverseLength : 1;

    if (hitbox.weaponMuzzle?.isEnabled()) {
      hitbox.weaponMuzzle.computeWorldMatrix(true);
      result.copyFrom(hitbox.weaponMuzzle.getAbsolutePosition());
      return true;
    }

    if (hitbox.weaponRoot?.isEnabled()) {
      hitbox.weaponRoot.computeWorldMatrix(true);
      const rootPosition = hitbox.weaponRoot.getAbsolutePosition();
      result.set(rootPosition.x + forwardX * 10, rootPosition.y + forwardY * 10, rootPosition.z + forwardZ * 10);
      return true;
    }

    result.set(
      hitbox.smoothedPos.x + forwardX * 5,
      hitbox.smoothedPos.y + 20 + forwardY * 5,
      hitbox.smoothedPos.z + forwardZ * 5,
    );
    return true;
  }

  /**
   * Attach a weapon model to a DETACHED player model's right hand (post-game
   * winner showcase). Same recipe as updateWeaponModel (ModelLoader → leader
   * mesh → attachToBone RightHand → third-person scale/rotation) but without
   * the live-hitbox lifecycle guards — the caller owns the instance and must
   * dispose it (attachedWeapon is set so disposal cleans the gun too).
   */
  async attachShowcaseWeapon(inst: PlayerModelInstance, weaponId: string): Promise<void> {
    const weaponDef = WEAPONS[weaponId];
    const modelPath = weaponDef?.modelPath;
    if (!modelPath) return;

    const defScale = weaponDef.scale ?? 1.5;
    const isGlbWeapon = weaponDef.viewModel.viewModelFormat === "glb" || modelPath.toLowerCase().endsWith(".glb");
    const visualScale = isGlbWeapon ? (weaponDef.viewModel.scale ?? defScale) : defScale;

    const { ModelLoader } = await import("../../../engine/loader/model/ModelLoader");
    const loader = ModelLoader.getInstance();
    if (!loader.isInitialized()) loader.init(this.scene);

    const result = await loader.loadModel(modelPath, {
      position: Vector3.Zero(),
      scale: defScale,
      hasCollision: false,
      applyLighting: false,
    });
    if (!result?.root) return;

    let leaderMesh: Mesh | null = null;
    for (const m of result.meshes) {
      if (m instanceof Mesh && m.getTotalVertices() > 0) {
        if (!leaderMesh) leaderMesh = m;
        if (m.material && "maxSimultaneousLights" in m.material) {
          // biome-ignore lint/suspicious/noExplicitAny: Babylon material introspection
          applySafeMaxSimultaneousLights(m.material as any);
        }
        m.alwaysSelectAsActiveMesh = true;
        m.isVisible = true;
      }
    }
    if (!leaderMesh) {
      result.root.dispose(false, true);
      return;
    }
    if (leaderMesh.rotationQuaternion) leaderMesh.rotationQuaternion = null;

    const hand = inst.skeleton?.bones.find((b) => b.name === "mixamorig:RightHand");
    if (hand) {
      leaderMesh.parent = null;
      leaderMesh.attachToBone(hand, inst.mesh);
      leaderMesh.position.set(0, 0, 0);
      leaderMesh.scaling.setAll((visualScale / MODEL_SCALE) * 0.5);
      if (weaponId === "blade") {
        leaderMesh.rotation.set(Math.PI, 0.9, 0);
      } else {
        leaderMesh.rotation.set(Math.PI, 0, -Math.PI / 2);
      }
    } else {
      leaderMesh.parent = inst.anchor;
      leaderMesh.position.set(0, 30, 0);
      leaderMesh.scaling.setAll(visualScale);
    }

    for (const m of result.meshes) {
      if (m instanceof Mesh && m !== leaderMesh && m.getTotalVertices() > 0) {
        m.parent = leaderMesh;
        m.position.setAll(0);
        if (m.rotationQuaternion) m.rotationQuaternion = null;
        m.rotation.setAll(0);
        m.isVisible = true;
        m.alwaysSelectAsActiveMesh = true;
      }
    }

    inst.attachedWeapon = leaderMesh;
  }

  /**
   * A transform node following one of a remote player's bones, for attaching
   * something to their body — the S&D bomb rides the spine.
   *
   * Returns null until the model has loaded, or if the player is not rendered
   * at all (out of PVS). Callers must handle that every frame rather than once:
   * a player can leave and re-enter view mid-carry.
   */
  /**
   * Every remote player currently being rendered, by client entity key.
   *
   * Rendered is the operative word: a player outside PVS has no hitbox, so they
   * are not a candidate to spectate. Following someone the client cannot see
   * would be a camera pointed at a guess.
   */
  getRenderedPlayers(): Map<string, { position: Vector3; dead: boolean }> {
    const out = new Map<string, { position: Vector3; dead: boolean }>();
    for (const [entityId, hitbox] of this.hitboxes) {
      out.set(entityId, { position: hitbox.smoothedPos, dead: this.deadEntities.has(entityId) });
    }
    return out;
  }

  /**
   * WORLD position of a remote player's bone, plus the yaw they are facing.
   *
   * Deliberately world space rather than a node to parent to. Attaching to a
   * bone puts a mesh in bone space, which on these models carries the rig's 36x
   * import scale — the S&D bomb parented that way rendered about thirty times
   * its size, big enough to walk inside. Everything the bomb needs is a point
   * and a facing, and those are unambiguous.
   */
  getBoneAnchor(entityId: string, boneName: string): { position: Vector3; yaw: number } | null {
    const hitbox = this.hitboxes.get(entityId);
    const node = this.getBoneTransform(entityId, boneName);
    if (!hitbox || !node) return null;
    return { position: node.getAbsolutePosition(), yaw: hitbox.smoothedYaw };
  }

  /** Facing of a rendered player, for callers that only need a direction. */
  getSmoothedYaw(entityId: string): number | null {
    return this.hitboxes.get(entityId)?.smoothedYaw ?? null;
  }

  getBoneTransform(entityId: string, boneName: string): TransformNode | null {
    const model = this.hitboxes.get(entityId)?.model;
    if (!model?.skeleton) return null;

    // glTF import writes Mixamo names with a colon; the shared rig map uses the
    // sanitized form. Accept either rather than making callers guess.
    const bone =
      model.skeleton.bones.find((b) => b.name === `mixamorig:${boneName}`) ??
      model.skeleton.bones.find((b) => b.name === `mixamorig${boneName}`) ??
      model.skeleton.bones.find((b) => b.name.toLowerCase().endsWith(boneName.toLowerCase()));
    return bone?.getTransformNode() ?? null;
  }

  /**
   * Detach a player model from the renderer WITHOUT disposing it.
   * Returns the PlayerModelInstance for ragdoll use.
   * The hitbox mesh is disposed but the model (skeleton + mesh + anchor) is preserved.
   */
  detachModel(entityId: string): import("../../../engine/animation/PlayerModelManager").PlayerModelInstance | null {
    this.deadEntities.set(entityId, performance.now());
    const hitbox = this.hitboxes.get(entityId);
    if (!hitbox || !hitbox.model) {
      if (hitbox) {
        hitbox.mesh.dispose();
        if (hitbox.weaponRoot) {
          hitbox.weaponRoot.dispose(false, true);
          hitbox.weaponRoot = null;
        }
        this.hitboxes.delete(entityId);
      }
      return null;
    }
    const model = hitbox.model;
    model.attachedWeapon = hitbox.weaponRoot;
    hitbox.weaponRoot = null;
    hitbox.mesh.dispose();
    this.hitboxes.delete(entityId);
    return model;
  }

  /**
   * Mark an entity as alive — hitbox will reappear on next render.
   * Called when a respawn/combat_state event clears dead status.
   */
  markAlive(entityId: string): void {
    this.deadEntities.delete(entityId);
  }

  /**
   * Collapse the interpolation buffer to its latest snapshot.
   * Used by demo playback on seek so models snap to the new timeline position
   * instead of interpolating across the (large, discontinuous) tick gap.
   */
  flushInterpolation(): void {
    this.snapshotBuffer.flush();
    this.demoTimeline?.flush();
  }

  /** Current deterministic demo sample for camera/diagnostic consumers. */
  getDemoEntitySample(entityId: string): InterpolatedEntity | null {
    // Memo: the followed entity is sampled by the spectator target provider,
    // the POV update, AND render() within one frame — same (entity, playhead)
    // → same result. Invalidated when the playhead moves.
    if (this._demoSampleCache?.entityId === entityId && this._demoSampleCache.tick === this.demoPlayheadTick) {
      return this._demoSampleCache.sample;
    }
    const sample = this.demoTimeline?.sample(entityId, this.demoPlayheadTick) ?? null;
    this._demoSampleCache = { entityId, tick: this.demoPlayheadTick, sample };
    return sample;
  }

  /** Get diagnostics */
  getDiagnostics(): { bufferSize: number; interpDelay: number } {
    return {
      bufferSize: this.demoTimeline?.getSize() ?? this.snapshotBuffer.getBufferSize(),
      interpDelay: this.demoTimeline ? 0 : this.snapshotBuffer.getInterpDelay(),
    };
  }

  /**
   * Play a one-shot attack animation on a remote player entity.
   * Used for blade slash animation on weapon_fire events.
   * @param speedRatio - Playback speed multiplier (default 1.0, higher = faster)
   */
  playAttackAnim(entityId: string, animName: string, speedRatio: number = 1.0): void {
    const hitbox = this.hitboxes.get(entityId);
    if (!hitbox?.model || !this.modelManager) return;
    if (!this.demoAnimationTimeline) {
      this.modelManager.playOnce(hitbox.model, animName, speedRatio);
      return;
    }

    const durationMs = this.modelManager.getOneShotDurationMs(hitbox.model, animName, speedRatio);
    if (!this.demoAnimationTimeline.start(entityId, animName, durationMs, speedRatio)) return;
    if (!this.modelManager.playOnce(hitbox.model, animName, speedRatio)) {
      this.demoAnimationTimeline.delete(entityId);
      return;
    }
    const shot = this.demoAnimationTimeline.get(entityId);
    this.modelManager.setOneShotTimeScale(hitbox.model, shot?.timeScale ?? 0);
  }

  private syncDemoOneShots(): void {
    if (!this.demoAnimationTimeline || !this.modelManager) return;
    for (const [entityId, hitbox] of this.hitboxes) {
      if (!hitbox.model) continue;
      const shot = this.demoAnimationTimeline.get(entityId);
      if (shot) {
        this.modelManager.setOneShotTimeScale(hitbox.model, shot.timeScale);
      } else if (this.modelManager.isOneShotPlaying(hitbox.model)) {
        this.modelManager.stopOneShot(hitbox.model);
        hitbox.model.currentAnim = "";
      }
    }
  }

  private stopAllDemoOneShots(): void {
    if (!this.modelManager) return;
    for (const hitbox of this.hitboxes.values()) {
      if (!hitbox.model || !this.modelManager.isOneShotPlaying(hitbox.model)) continue;
      this.modelManager.stopOneShot(hitbox.model);
      hitbox.model.currentAnim = "";
    }
  }

  // ── Hitbox Creation ─────────────────────────────────────────

  private createHitboxMesh(entityId: string, height: number): Mesh {
    const hw = PLAYER_RADIUS; // 16 (half-width)
    const hh = height / 2; // half-height
    const hd = PLAYER_RADIUS; // 16 (half-depth)

    // 8 corners of the box (centered at origin, positioned later)
    const c = [
      new Vector3(-hw, -hh, -hd), // 0: bottom-back-left
      new Vector3(hw, -hh, -hd), // 1: bottom-back-right
      new Vector3(hw, -hh, hd), // 2: bottom-front-right
      new Vector3(-hw, -hh, hd), // 3: bottom-front-left
      new Vector3(-hw, hh, -hd), // 4: top-back-left
      new Vector3(hw, hh, -hd), // 5: top-back-right
      new Vector3(hw, hh, hd), // 6: top-front-right
      new Vector3(-hw, hh, hd), // 7: top-front-left
    ];

    // 12 edges as a continuous line strip
    const points = [
      // Bottom face
      c[0],
      c[1],
      c[2],
      c[3],
      c[0],
      // Up to top face
      c[4],
      c[5],
      c[6],
      c[7],
      c[4],
      // Remaining 3 vertical edges
      c[5],
      c[1],
      c[2],
      c[6],
      c[7],
      c[3],
    ];

    const mesh = MeshBuilder.CreateLines(
      `hitbox_${entityId}`,
      {
        points,
        updatable: false,
      },
      this.scene,
    );

    mesh.color = new Color3(0, 1, 0); // Bright green
    mesh.isPickable = false;

    return mesh as unknown as Mesh;
  }

  private createHitbox(entityId: string, initialState: InterpolatedEntity): RemotePlayerHitbox | null {
    const height = initialState.crouching ? CROUCH_HEIGHT : PLAYER_HEIGHT;
    const mesh = this.createHitboxMesh(entityId, height);

    const smoothedPos = new Vector3(initialState.x, initialState.y, initialState.z);

    // Position mesh at correct Y (box center relative to origin)
    this.positionMesh(mesh, smoothedPos, height);

    // Create model instance if manager is loaded
    const model = this.createModelInstance(entityId);

    return {
      mesh,
      smoothedPos,
      smoothedYaw: initialState.yaw,
      currentHeight: height,
      model,
      weaponRoot: null,
      weaponMuzzle: null,
      handBone: null,
      currentWeaponId: "",
      appliedVisualStyleKey: model ? getPlayerModelVisualStyleKey(this.resolvePlayerTeamSlot(entityId)) : null,
      powerupGlowActive: false,
    };
  }

  /**
   * Drive the quad carrier glow for one entity, one frame.
   *
   * On the falling edge the base style is re-applied (by invalidating the style
   * key) rather than "unset" field by field — the base style is the single
   * definition of a normal player, so restoring through it can't drift.
   */
  private updatePowerupGlow(hitbox: RemotePlayerHitbox, entityId: string, mask: number, elapsed: number): void {
    if (!hitbox.model || !this.modelManager) return;
    const active = maskHasPowerup(mask, "quad");

    if (!active) {
      if (hitbox.powerupGlowActive) {
        hitbox.powerupGlowActive = false;
        hitbox.appliedVisualStyleKey = null; // force a base-style re-apply
        this.applyHitboxVisualStyle(hitbox, entityId);
      }
      return;
    }

    hitbox.powerupGlowActive = true;
    // 0..1 breathing curve.
    const p = 0.5 + 0.5 * Math.sin(elapsed * QUAD_PULSE_HZ * Math.PI * 2);
    const intensity = QUAD_GLOW_MIN + (QUAD_GLOW_MAX - QUAD_GLOW_MIN) * p;
    const width = (QUAD_OUTLINE_MIN + (QUAD_OUTLINE_MAX - QUAD_OUTLINE_MIN) * p) / Math.max(1, MODEL_SCALE * 16);
    this.modelManager.applyPowerupGlow(hitbox.model, QUAD_GLOW_COLOR, intensity, width);
  }

  // ── Position Update ─────────────────────────────────────────

  /**
   * Position the hitbox mesh correctly relative to Q3 origin.
   *
   * Q3 origin is at "waist" level. The box bottom should ALWAYS
   * be at feet level (origin + PLAYER_MINS_Z), regardless of crouch.
   * Crouching shrinks the box from the TOP (head lowers), not the bottom.
   */
  private positionMesh(mesh: Mesh, origin: Vector3, height: number): void {
    // Bottom always at feet level
    const bottomY = origin.y + PLAYER_MINS_Z;
    const centerY = bottomY + height / 2;
    mesh.position.set(origin.x, centerY, origin.z);
  }

  /** Frame-to-frame displacement (squared) treated as a teleport for VFX. */
  private static readonly TELEPORT_FX_DIST_SQ = 256 * 256;

  /** Washoi teleport VFX: generic pooled team-color ghost + speed-line burst at both ends. */
  private playTeleportEffect(hitbox: RemotePlayerHitbox, entityId: string, interp: InterpolatedEntity): void {
    const from = { x: hitbox.smoothedPos.x, y: hitbox.smoothedPos.y, z: hitbox.smoothedPos.z };
    const to = { x: interp.x, y: interp.y, z: interp.z };
    const fromYaw = hitbox.smoothedYaw;
    const team = this.resolveLegacyTeamColor(entityId);
    import("./TeleportEffect")
      .then(({ TeleportEffect }) => {
        TeleportEffect.getInstance().playerTeleported(this.scene, from, to, fromYaw, interp.yaw, team);
      })
      .catch(() => {
        /* effect is cosmetic — never break the render loop */
      });
  }

  private updatePosition(hitbox: RemotePlayerHitbox, interp: InterpolatedEntity): void {
    // Direct interpolated position — SnapshotBuffer handles smooth time-based interpolation
    hitbox.smoothedPos.set(interp.x, interp.y, interp.z);

    // Position mesh relative to Q3 origin
    this.positionMesh(hitbox.mesh, hitbox.smoothedPos, hitbox.currentHeight);

    // Rotation from interpolated yaw
    hitbox.smoothedYaw = interp.yaw;
    if (hitbox.mesh.rotationQuaternion) hitbox.mesh.rotationQuaternion = null;
    hitbox.mesh.rotation.set(0, hitbox.smoothedYaw, 0);
  }

  // ── Model Update ─────────────────────────────────────────────

  private updateModel(
    hitbox: RemotePlayerHitbox,
    interp: InterpolatedEntity,
    entityId: string,
    animationTimeScale: number,
  ): void {
    const inst = hitbox.model;
    if (!inst || !this.modelManager) return;

    // Re-apply visibility style when the player team slot or accessibility cvars change.
    this.applyHitboxVisualStyle(hitbox, entityId);

    // ── Weapon model on hand ──
    this.updateWeaponModel(hitbox, inst, entityId);

    // Position the model anchor at player feet (Q3 origin - 24 = feet level)
    // MODEL_Y_OFFSET raises the model so visual feet align with hitbox bottom
    let feetY = interp.y + PLAYER_MINS_Z + MODEL_Y_OFFSET;

    // Crouch/slide Y offset: Mixamo animations don't lower the skeleton
    // enough to match the shorter hitbox. Drop the model anchor to compensate.
    // Slide needs full -20 (Mixamo slide anim doesn't lower at all).
    // Crouch walk needs only -10 (Mixamo crouch walk partially lowers).
    if (interp.sliding) {
      feetY -= 20;
    } else if (interp.crouching) {
      feetY -= 10;
    }

    inst.anchor.position.set(interp.x, feetY, interp.z);

    // Rotation
    if (inst.anchor.rotationQuaternion) inst.anchor.rotationQuaternion = null;
    inst.anchor.rotation.set(0, interp.yaw, 0);
    inst.anchor.setEnabled(true);

    // Reset root motion each frame (position + rotation drift from anims)
    this.modelManager.resetRootMotion(inst);
    inst.mesh.scaling.set(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);
    if (inst.mesh.rotationQuaternion) inst.mesh.rotationQuaternion = null;
    inst.mesh.rotation.set(0, 0, 0);

    // Ensure the body is renderable. The weapon mesh is separately attached to
    // a bone and already disables frustum culling; keep the player body in the
    // same safe state so stale skinned bounds cannot hide it.
    inst.mesh.setEnabled(true);
    inst.mesh.isVisible = true;
    inst.mesh.visibility = 1;
    inst.mesh.alwaysSelectAsActiveMesh = true;
    inst.mesh.getChildMeshes().forEach((m) => {
      m.setEnabled(true);
      m.isVisible = true;
      m.visibility = 1;
      m.alwaysSelectAsActiveMesh = true;
    });

    // Derive animation from network data
    // Skip if a one-shot animation (e.g. blade slash) is still playing
    if (this.demoAnimationTimeline) {
      const demoShot = this.demoAnimationTimeline.get(entityId);
      if (demoShot) {
        this.modelManager.setOneShotTimeScale(inst, demoShot.timeScale);
        return;
      }
    } else {
      if (inst.oneshotUntil > 0 && performance.now() < inst.oneshotUntil) {
        // One-shot is playing — don't override with locomotion
        return;
      }
      // Clear expired one-shot flag and force locomotion re-evaluation
      if (inst.oneshotUntil > 0) {
        inst.oneshotUntil = 0;
        inst.currentAnim = ""; // Force playAnimation to re-apply locomotion
      }
    }
    const animName = this.deriveAnimation(interp);
    this.modelManager.playAnimation(inst, animName);
    this._animDebug(entityId, animName, interp, inst);

    // Scale animation speed to match movement speed (eliminate foot sliding)
    if (inst.masterGroup) {
      const speed = Math.sqrt(interp.vx * interp.vx + interp.vz * interp.vz);

      if (animName === "run" || animName === "walk") {
        const naturalSpeed = animName === "run" ? RUN_NATURAL_SPEED : WALK_NATURAL_SPEED;

        // Detect backward movement
        const fwdX = Math.sin(interp.yaw);
        const fwdZ = Math.cos(interp.yaw);
        const forwardDot = fwdX * interp.vx + fwdZ * interp.vz;
        const isBackward = forwardDot < 0;

        let speedRatio = speed / naturalSpeed;
        if (isBackward) speedRatio = -speedRatio;
        inst.masterGroup.speedRatio = Math.max(-3.0, Math.min(3.0, speedRatio));
      } else if (animName === "strafe_l" || animName === "strafe_r") {
        // Use lateral speed for strafe ratio
        const fwdX = Math.sin(interp.yaw);
        const fwdZ = Math.cos(interp.yaw);
        const rightX = fwdZ;
        const rightZ = -fwdX;
        const rightDot = rightX * interp.vx + rightZ * interp.vz;
        const lateralSpeed = Math.abs(rightDot);
        const speedRatio = lateralSpeed / STRAFE_NATURAL_SPEED;
        inst.masterGroup.speedRatio = Math.max(0.3, Math.min(3.0, speedRatio));
      } else if (animName === "jump") {
        // Warsow-style: ascending plays forward to tucked pose,
        // descending reverses back to extended pose.
        // Freeze at peak (vy ≈ 0).
        if (interp.vy > 10) {
          // Ascending — play forward, speed proportional to upward velocity
          inst.masterGroup.speedRatio = Math.max(0.3, (interp.vy / JUMP_VELOCITY) * 2.0);
        } else if (interp.vy < -10) {
          // Descending — play in reverse, speed proportional to downward velocity
          inst.masterGroup.speedRatio = Math.min(-0.2, (interp.vy / JUMP_VELOCITY) * 1.5);
        } else {
          // At peak — freeze
          inst.masterGroup.speedRatio = 0;
        }
      } else if (animName === "slide") {
        // Crouchslide: play forward proportional to horizontal speed
        // Animation naturally decelerates as slide velocity drops
        const slideSpeed = Math.sqrt(interp.vx * interp.vx + interp.vz * interp.vz);
        const slideRatio = slideSpeed / 400; // Normalize to max slide speed
        inst.masterGroup.speedRatio = Math.max(0.3, Math.min(2.0, slideRatio));
      } else if (animName === "crouch_walk") {
        // Crouch walk: speed proportional to horizontal velocity
        // When speed is very low (crouch idle), freeze on first frame
        // When walking backward, reverse the animation (negative speedRatio)
        const crouchSpeed = Math.sqrt(interp.vx * interp.vx + interp.vz * interp.vz);
        if (crouchSpeed < IDLE_SPEED_THRESHOLD) {
          inst.masterGroup.speedRatio = 0; // Freeze first frame = crouch idle
        } else {
          // Detect backward movement
          const fwdX = Math.sin(interp.yaw);
          const fwdZ = Math.cos(interp.yaw);
          const forwardDot = fwdX * interp.vx + fwdZ * interp.vz;
          const isBackward = forwardDot < 0;

          let crouchRatio = crouchSpeed / WALK_NATURAL_SPEED;
          if (isBackward) crouchRatio = -crouchRatio;
          inst.masterGroup.speedRatio = Math.max(-3.0, Math.min(3.0, crouchRatio));
        }
      } else if (animName === "crouch_strafe_l" || animName === "crouch_strafe_r") {
        // Crouch strafe: same as standing strafe
        const fwdX = Math.sin(interp.yaw);
        const fwdZ = Math.cos(interp.yaw);
        const rightX = fwdZ;
        const rightZ = -fwdX;
        const rightDot = rightX * interp.vx + rightZ * interp.vz;
        const lateralSpeed = Math.abs(rightDot);
        const crouchStrafeRatio = lateralSpeed / STRAFE_NATURAL_SPEED;
        inst.masterGroup.speedRatio = Math.max(0.3, Math.min(3.0, crouchStrafeRatio));
      } else {
        inst.masterGroup.speedRatio = 1.0;
      }
      inst.masterGroup.speedRatio *= animationTimeScale;
    }
  }

  // ── Weapon Model on Hand ─────────────────────────────────────
  /**
   * Load and attach the correct weapon model to the player's right hand bone.
   * Called each frame from updateModel; only acts when weaponId changes.
   *
   * Uses ModelLoader — same proven code path as DroppedWeaponRenderer.
   */
  private updateWeaponModel(hitbox: RemotePlayerHitbox, inst: PlayerModelInstance, entityId: string): void {
    const weaponId = this.enemyWeapons.get(entityId);
    if (!weaponId) return;

    // No change — nothing to do
    if (weaponId === hitbox.currentWeaponId) return;

    console.log(`[RemoteWeapon] ★ Weapon change: ${entityId} → ${weaponId}`);
    hitbox.currentWeaponId = weaponId;

    // Dispose previous weapon
    if (hitbox.weaponRoot) {
      hitbox.weaponRoot.dispose(false, true);
      hitbox.weaponRoot = null;
    }
    hitbox.weaponMuzzle = null;
    inst.attachedWeapon = null;

    // Look up weapon def for model path
    const weaponDef = WEAPONS[weaponId];
    const modelPath = weaponDef?.modelPath;
    if (!modelPath) {
      console.warn(`[RemoteWeapon] No modelPath for '${weaponId}'`);
      return;
    }

    const defScale = weaponDef.scale ?? 1.5;
    const isGlbWeapon = weaponDef.viewModel.viewModelFormat === "glb" || modelPath.toLowerCase().endsWith(".glb");
    const visualScale = isGlbWeapon ? (weaponDef.viewModel.scale ?? defScale) : defScale;

    // Load weapon via ModelLoader — same approach as DroppedWeaponRenderer.loadModel()
    import("../../../engine/loader/model/ModelLoader")
      .then(async ({ ModelLoader }) => {
        const loader = ModelLoader.getInstance();
        if (!loader.isInitialized()) loader.init(this.scene);

        const result = await loader.loadModel(modelPath, {
          position: Vector3.Zero(),
          scale: defScale,
          hasCollision: false,
          applyLighting: false,
        });

        if (!result?.root) {
          console.warn(`[RemoteWeapon] ModelLoader returned null for ${weaponId}`);
          return;
        }

        if (
          this.hitboxes.get(entityId) !== hitbox ||
          this.deadEntities.has(entityId) ||
          hitbox.currentWeaponId !== weaponId
        ) {
          result.root.dispose(false, true);
          return;
        }

        // Find leader mesh (first mesh with geometry) — same as DroppedWeaponRenderer
        let leaderMesh: Mesh | null = null;
        for (const m of result.meshes) {
          if (m instanceof Mesh && m.getTotalVertices() > 0) {
            if (!leaderMesh) {
              leaderMesh = m;
            }
            // Cap lights to prevent shader overflow
            if (m.material && "maxSimultaneousLights" in m.material) {
              applySafeMaxSimultaneousLights(m.material as any);
            }
            // Disable frustum culling
            m.alwaysSelectAsActiveMesh = true;
            m.isVisible = true;
          }
        }

        if (!leaderMesh) {
          console.warn(`[RemoteWeapon] No meshes with geometry for ${weaponId}`);
          result.root.dispose();
          return;
        }

        const muzzleNode = result.root
          .getDescendants(false)
          .find((node) => node.name === "tag_flash" && node instanceof TransformNode) as TransformNode | undefined;

        if (leaderMesh.rotationQuaternion) leaderMesh.rotationQuaternion = null;

        // Use Babylon.js attachToBone() API — the official way to attach
        // external meshes to animated skeleton bones.
        // attachToBone(bone, affectedTransformNode) where affectedTransformNode
        // is the mesh that owns the skeleton.
        let attached = false;
        if (inst.skeleton) {
          for (const bone of inst.skeleton.bones) {
            if (bone.name === "mixamorig:RightHand") {
              leaderMesh.parent = null;
              leaderMesh.attachToBone(bone, inst.mesh);
              leaderMesh.position.set(0, 0, 0);
              // Scale: compensate for 36x player mesh + shrink for 3rd person.
              // GLB weapons (blade) use their authored view-model scale; MD3s use world scale.
              const thirdPersonScale = (visualScale / MODEL_SCALE) * 0.5;
              leaderMesh.scaling.setAll(thirdPersonScale);

              // Weapon-specific rotation in bone-local space
              // (differs from first-person loadGlbWeapon rotations)
              if (weaponId === "blade") {
                leaderMesh.rotation.set(Math.PI, 0.9, 0);
              } else {
                // IQM→GLB guns: barrel along +X in model space
                // Bone +Y = along fingers (forward), so Z rot of -90° aligns barrel
                // X rot of π flips right-side up
                leaderMesh.rotation.set(Math.PI, 0, -Math.PI / 2);
              }

              attached = true;
              console.log(
                `[RemoteWeapon] ✓ attachToBone: ${weaponId} → RightHand, scale: ${(visualScale / MODEL_SCALE).toFixed(4)}`,
              );
              break;
            }
          }
        }

        if (!attached) {
          // Fallback: parent to anchor
          leaderMesh.parent = inst.anchor;
          leaderMesh.position.set(0, 30, 0);
          leaderMesh.rotation.setAll(0);
          leaderMesh.scaling.setAll(visualScale);
          console.warn(`[RemoteWeapon] No RightHand bone, using anchor for ${entityId}`);
        }

        // Parent other meshes under leader
        for (const m of result.meshes) {
          if (m instanceof Mesh && m !== leaderMesh && m.getTotalVertices() > 0) {
            m.parent = leaderMesh;
            m.position.setAll(0);
            if (m.rotationQuaternion) m.rotationQuaternion = null;
            m.rotation.setAll(0);
            m.isVisible = true;
            m.alwaysSelectAsActiveMesh = true;
          }
        }

        // Preserve the authored muzzle tag when detaching the geometry from the
        // loader root. Its model-space transform now follows the hand-attached
        // leader exactly, including animation, scale, and rotation.
        if (muzzleNode) muzzleNode.parent = leaderMesh;

        // Detach loader root
        if (result.root) {
          result.root.parent = null;
          result.root.setEnabled(false);
        }

        hitbox.weaponRoot = leaderMesh as unknown as TransformNode;
        hitbox.weaponMuzzle = muzzleNode ?? null;
        // Track the weapon on the model instance so it is disposed WITH the model
        // (bone-attached meshes aren't scene-graph children). This makes a dropped
        // blade ride the death ragdoll and vanish with it instead of leaking a
        // floating mesh that piles up over a match.
        inst.attachedWeapon = leaderMesh as unknown as TransformNode;
        console.log(
          `[RemoteWeapon] ✓ Done: ${weaponId} for ${entityId}, bone: ${attached}, scale: ${attached ? visualScale / MODEL_SCALE : visualScale}`,
        );
      })
      .catch((err) => {
        console.warn(`[RemoteWeapon] Failed to load ${weaponId} for ${entityId}:`, err);
      });
  }

  /**
   * Diagnostic (cl_animdebug 1): logs the derived animation, movement inputs, and
   * — crucially — the animation group's master frame, which only advances when the
   * scene is stepping AnimationGroups. If `frame` is stuck across logs while the
   * player is moving, skeletal animation isn't advancing (a render/scene issue);
   * if `frame` advances but you see no motion, it's elsewhere.
   */
  private _animDebug(entityId: string, animName: string, interp: InterpolatedEntity, inst: PlayerModelInstance): void {
    if (Number(Cvar.get("cl_animdebug") ?? 0) <= 0) return;
    const now = performance.now();
    if (now - (this._lastAnimLog.get(entityId) ?? 0) < 1000) return; // throttle: 1/s per entity
    this._lastAnimLog.set(entityId, now);
    const speed = Math.sqrt(interp.vx * interp.vx + interp.vz * interp.vz);
    const g = inst.masterGroup;
    const frame = g?.animatables?.[0]?.masterFrame;
    console.log(
      `[AnimDebug] ${entityId} anim=${animName} speed=${speed.toFixed(0)} grounded=${interp.grounded} ` +
        `vy=${interp.vy.toFixed(0)} ratio=${g?.speedRatio?.toFixed(2) ?? "—"} ` +
        `playing=${g?.isPlaying ?? false} frame=${frame?.toFixed(1) ?? "—"}`,
    );
  }

  /**
   * Derive animation name from interpolated network data.
   * Uses velocity, grounded state, and yaw — all available from SnapshotBuffer.
   */
  private deriveAnimation(interp: InterpolatedEntity): string {
    // Walljump — player is on a wall, play wallrun animation
    // Check BEFORE grounded/airborne since walljump happens while !grounded
    if (interp.wallJumping) return "walljump";

    // Airborne — use jump for entire air time (Warsow-style)
    if (!interp.grounded) return "jump";

    // Crouchslide — takes priority over walk/run/strafe
    if (interp.sliding) {
      return "slide";
    }

    const speed = Math.sqrt(interp.vx * interp.vx + interp.vz * interp.vz);

    // Crouching (not sliding) — use crouch walk animations
    if (interp.crouching) {
      if (speed < IDLE_SPEED_THRESHOLD) return "crouch_walk"; // Frozen first frame = crouch idle

      const fwdX = Math.sin(interp.yaw);
      const fwdZ = Math.cos(interp.yaw);
      const rightX = fwdZ;
      const rightZ = -fwdX;
      const forwardDot = fwdX * interp.vx + fwdZ * interp.vz;
      const rightDot = rightX * interp.vx + rightZ * interp.vz;

      if (Math.abs(rightDot) > Math.abs(forwardDot) * 1.5) {
        return rightDot > 0 ? "crouch_strafe_l" : "crouch_strafe_r";
      }
      return "crouch_walk"; // Backward handled by negative speedRatio
    }

    // Idle
    if (speed < IDLE_SPEED_THRESHOLD) return "idle";

    // Strafe detection
    const fwdX = Math.sin(interp.yaw);
    const fwdZ = Math.cos(interp.yaw);
    const rightX = fwdZ;
    const rightZ = -fwdX;

    const forwardDot = fwdX * interp.vx + fwdZ * interp.vz;
    const rightDot = rightX * interp.vx + rightZ * interp.vz;

    if (Math.abs(rightDot) > Math.abs(forwardDot) * 1.5) {
      return rightDot > 0 ? "strafe_l" : "strafe_r";
    }

    // Run vs walk
    return speed > RUN_SPEED_THRESHOLD ? "run" : "walk";
  }
}

// ─── Cvar Registration ───────────────────────────────────────────

Cvar.register("cl_remotehitbox", 0, {
  type: "int",
  min: 0,
  max: 1,
  description: "Show wireframe hitbox outlines on remote players",
});

Cvar.register("cl_animdebug", 0, {
  type: "int",
  min: 0,
  max: 1,
  description:
    "Log remote/demo player animation state (derived anim, speed, grounded, whether the anim group advances)",
});
