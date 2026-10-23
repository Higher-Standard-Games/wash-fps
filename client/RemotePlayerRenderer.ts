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

import type { Bone } from "@babylonjs/core/Bones/bone";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import type { Plane } from "@babylonjs/core/Maths/math.plane";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import {
  animationDeltaSeconds,
  PLAYER_POSE_BOUNDS,
  type PlayerModelInstance,
  PlayerModelManager,
  type PlayerModelVisualStyle,
} from "../../../engine/animation/PlayerModelManager";
import { background } from "../../../engine/core/AsyncErrors";
import { Cvar } from "../../../engine/core/Cvar";
import { applySafeMaxSimultaneousLights } from "../../../engine/lighting/DynamicLightSafety";
import { BspManager } from "../../../engine/loader/bsp/BspManager";
import { ModelInstanceCache } from "../../../engine/loader/model/ModelInstanceCache";
import { bindLoaderLeftovers, disposeModelResources } from "../../../engine/loader/model/ModelSourceCache";
import {
  type EntitySnapshot,
  type InterpolatedEntity,
  SnapshotBuffer,
} from "../../../engine/network/client/SnapshotBuffer";
import type { GameState } from "../../../engine/network/core/GameState";
import { waterNeedsLocalReflection } from "../../../engine/rendering/water/WaterActorReflection";
import { getHitscanEffects } from "../../../engine/weapon/HitscanEffects";
import type { VoltaicRemoteStartResolver } from "../../../engine/weapon/voltaic/VoltaicEffectRenderer";
import { WEAPONS } from "../shared/entities/definitions/weapons/WeaponsTable";
import { maskHasPowerup } from "../shared/items/Powerups";
import { attachBladeToPlayer } from "./AttachedBlade";
import { DemoAnimationTimeline } from "./DemoAnimationTimeline";
import { DemoEntityTimeline } from "./DemoEntityTimeline";
import { devLog } from "./DevLog";
import { MatchStateManager } from "./MatchStateManager";
import {
  FfaColors,
  getFfaPlayerModelVisualStyle,
  getPlayerModelVisualStyle,
  getPlayerModelVisualStyleKey,
  getPlayerTeamSlot,
  type PlayerTeamSlot,
  registerPlayerModelVisualCvars,
} from "./PlayerModelVisualSettings";
import {
  getQuadDamagePulse,
  QUAD_DAMAGE_COLOR,
  QUAD_EMISSIVE_MIN,
  QUAD_EMISSIVE_RANGE,
  QUAD_PLAYER_OUTLINE_MIN,
  QUAD_PLAYER_OUTLINE_RANGE,
  QUAD_WORLD_WEAPON_OUTLINE_MIN,
  QUAD_WORLD_WEAPON_OUTLINE_RANGE,
} from "./QuadDamageVisual";
import {
  animationLodRadiusSq,
  applyRoster,
  deriveAnimation,
  extractEntities,
  IDLE_SPEED_THRESHOLD,
  legacyTeamColor,
  sphereInFrustum,
} from "./RemotePlayerLogic";
import { installTeamColorBridge } from "./TeamColorBridge";

// ─── Types ───────────────────────────────────────────────────────

/** Per-entity hitbox wrapper */
/** A rendered remote player as spectating and the bomb see them. */
export interface RenderedPlayer {
  position: Vector3;
  dead: boolean;
}

interface RemotePlayerHitbox {
  mesh: Mesh;
  smoothedPos: Vector3;
  smoothedYaw: number;
  /** Current hitbox height (56 standing, 36 crouching) */
  currentHeight: number;
  /** Height the wireframe geometry was actually built at; crouch scales from it. */
  builtHeight: number;
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
  /** Reject a stale asynchronous A→B→A load, even when its weapon ID matches. */
  weaponLoadGeneration?: number;
  /** Last applied visual style key; changes when team slot or cvars change. */
  appliedVisualStyleKey: string | null;
  /** True while this player was last seen carrying a powerup (drives the glow). */
  powerupGlowActive: boolean;
  /** Pose sampled at the reduced rate (medium distance); see applyAnimationLod. */
  poseStepped?: boolean;
}

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

// Mixamo animation natural speeds (Q3 units/s at 1x playback)
// Lower values → higher speedRatio → faster feet to match actual movement.
// Tuned so feet track the ground at game speeds (maxSpeed=280, runSpeed=350).
const WALK_NATURAL_SPEED = 40;
const RUN_NATURAL_SPEED = 100;
const STRAFE_NATURAL_SPEED = 29;
/** Climb rate the ladder clip reads naturally at 1x (ladder climbSpeed is 168). */
const CLIMB_NATURAL_SPEED = 120;

// Jump velocity for normalizing animation scrub (matches MovementProfile.jumpVelocity)
const JUMP_VELOCITY = 320;

export class RemotePlayerRenderer {
  private scene: Scene;
  private hitboxes: Map<string, RemotePlayerHitbox> = new Map();
  private readonly renderedPlayers = new Map<string, RenderedPlayer>();
  private readonly renderedEntries = new Map<string, RenderedPlayer>();
  private readonly bonesByName = new WeakMap<Skeleton, Map<string, Bone | null>>();
  private snapshotBuffer: SnapshotBuffer = new SnapshotBuffer();
  private demoTimeline: DemoEntityTimeline | null = null;
  private demoPlayheadTick: number = 0;
  private demoAnimationTimeScale: number = 1;
  private demoDiscontinuityId: number = -1;
  private demoAnimationTimeline: DemoAnimationTimeline | null = null;

  /**
   * Splash and ripple emitter, owned by the game and set per map.
   *
   * The renderer is where every remote player's water level already arrives
   * each frame, so it is the cheapest place to notice a crossing — no second
   * pass over the roster to find out what the first pass already knew.
   */
  public liquidInteractions: import("../liquid/client/LiquidInteractionSystem").LiquidInteractionSystem | null = null;
  /** Entities marked dead — value is death timestamp (performance.now) */
  private deadEntities: Map<string, number> = new Map();

  /** Shared model manager — loads vanguard.glb once, creates cloned instances */
  private modelManager: PlayerModelManager | null = null;
  private modelLoadPromise: Promise<void> | null = null;
  private weaponModelCache?: ModelInstanceCache;
  private localReflectionModel: PlayerModelInstance | null = null;
  private localReflectionLoadAttempted = false;
  private disposed = false;

  /** Reference to enemyWeapons from GameEventContext — maps entityId → weaponId */
  private enemyWeapons: Map<string, string> = new Map();

  /** entityId → server team id ("udon"/"soba"/"ffa"/"spectator"), from snapshot players */
  private teams: Map<string, string> = new Map();
  private readonly ffaColors = new FfaColors();

  /** Each model's child meshes; see bodyPartsOf. */
  private readonly bodyParts = new WeakMap<PlayerModelInstance, AbstractMesh[]>();
  /** Style key per team slot, for the frame being rendered only; see applyHitboxVisualStyle. */
  private readonly frameStyleKeys = new Map<PlayerTeamSlot, string>();
  /** cl_animdebug for the frame being rendered; null outside render(). */
  private frameAnimDebug: boolean | null = null;
  /** The sample each live player is read into during render(); see renderEntities. */
  private readonly frameSample = {} as InterpolatedEntity;
  /** Sphere around {@link PLAYER_POSE_BOUNDS}, anchor-relative, for the pose frustum test. */
  private static readonly POSE_SPHERE_CENTER_Y = (PLAYER_POSE_BOUNDS.minY + PLAYER_POSE_BOUNDS.maxY) / 2;
  private static readonly POSE_SPHERE_RADIUS = Math.hypot(
    PLAYER_POSE_BOUNDS.radius,
    (PLAYER_POSE_BOUNDS.maxY - PLAYER_POSE_BOUNDS.minY) / 2,
  );
  /** Main-view frustum planes, reused every frame; see poseFrustum. */
  private readonly frustumPlanes = Frustum.GetPlanes(Matrix.Identity());

  /**
   * Medium-distance players are posed at {@link POSE_STEP_HZ} once they are
   * shorter than {@link POSE_STEP_ENTER_PIXELS} on screen, and back at full
   * rate above {@link POSE_STEP_LEAVE_PIXELS}.
   */
  private static readonly POSE_STEP_HZ = 30;
  private static readonly POSE_STEP_ENTER_PIXELS = 56;
  private static readonly POSE_STEP_LEAVE_PIXELS = 72;
  /** Set once per frame by render(); see poseStepPlan. */
  private framePoseStep: ReturnType<RemotePlayerRenderer["poseStepPlan"]> = null;

  /** Remote bodies whose bounds already hold every pose; see updateModel. */
  private readonly poseBounded = new WeakSet<PlayerModelInstance>();

  /** Scratch point for the PVS probes up a player's body. */
  private readonly pvsProbe = new Vector3();

  /** Entity whose mesh+model should be hidden (e.g. followed player in demo POV) */
  private _hiddenEntityId: string | null = null;
  /**
   * The ragdoll of the player we were watching from inside their head, kept
   * hidden while the camera is still there and shown once it leaves.
   */
  private hiddenCorpse: PlayerModelInstance | null = null;

  /** Per-entity throttle timestamps for cl_animdebug logging */
  private _lastAnimLog: Map<string, number> = new Map();

  /** Per-playhead memo for getDemoEntitySample (followed entity is sampled 3×/frame). */
  private _demoSampleCache: { entityId: string; tick: number; sample: InterpolatedEntity | null } | null = null;
  private readonly voltaicMuzzleResolver: VoltaicRemoteStartResolver = (entityId, direction, result) =>
    this.getWeaponMuzzleWorldPositionToRef(entityId, direction, result);

  /**
   * The muzzle of the gun in front of the camera while someone is watched
   * through their eyes. Their own body and gun are hidden then, so a beam must
   * leave this barrel, the one on screen, as the local player's does.
   */
  private followedMuzzle: (() => Vector3 | null) | null = null;

  setFollowedMuzzle(resolver: (() => Vector3 | null) | null): void {
    this.followedMuzzle = resolver;
  }

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
  private lastLookaheadState: GameState | null = null;
  private lastLookaheadVersion = -1;

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
    if (this.hiddenCorpse && entityId !== this._hiddenEntityId) {
      showCorpse(this.hiddenCorpse);
      this.hiddenCorpse = null;
    }
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

  /** Explicit readiness boundary for unattended demo benchmarks. */
  async waitForModels(): Promise<void> {
    await this.ensureModelLoaded();
    if (!this.modelManager?.isLoaded) throw new Error("Timedemo player model failed to load");
  }

  getPlaybackModelStats(): { alivePlayers: number; loadedBodies: number } {
    let loadedBodies = 0;
    for (const hitbox of this.hitboxes.values()) if (hitbox.model) loadedBodies++;
    return { alivePlayers: this.hitboxes.size, loadedBodies };
  }

  private async ensureModelLoaded(): Promise<void> {
    if (this.modelManager?.isLoaded) return;
    if (this.modelLoadPromise) {
      await this.modelLoadPromise;
      return;
    }

    this.modelManager = new PlayerModelManager(this.scene);
    const loadingManager = this.modelManager;
    this.modelLoadPromise = (async () => {
      await loadingManager.loadModel();
      if (this.disposed || this.modelManager !== loadingManager) {
        loadingManager.dispose();
        return;
      }
      // A failed load resolves like any other, so report what actually happened.
      // Reported as loaded, it presents as invisible players and no explanation.
      if (!loadingManager.isLoaded) {
        console.error("[RemotePlayerRenderer] Player model failed to load — remote players will be invisible");
        return;
      }
      devLog("[RemotePlayerRenderer] Player model loaded");
      await loadingManager.setOutlineProxyEnabled(Cvar.getBool("cl_player_outline_proxy"));
      if (this.disposed || this.modelManager !== loadingManager) {
        loadingManager.dispose();
        return;
      }

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
      // Explicit opt-in for the engine's optional near-water reflection layer.
      // Root metadata also covers model children; hidden POV roots stay excluded.
      instance.anchor.metadata = { ...instance.anchor.metadata, waterReflectionActorId: entityId };
      // Start with idle animation
      this.modelManager.playAnimation(instance, "idle");
      this.applyModelVisualStyle(instance, entityId);
    }
    return instance;
  }

  /** A local body exists only for water capture, never for main/depth/refraction
   * cameras. Reuse the same model/locomotion assets, but no weapon or hitbox. */
  syncLocalWaterReflection(state: InterpolatedEntity | null): void {
    if (this.disposed) return;
    if (!state) {
      this.localReflectionModel?.anchor.setEnabled(false);
      this.localReflectionModel?.masterGroup?.pause();
      return;
    }
    if (!this.modelManager?.isLoaded) {
      if (!this.localReflectionLoadAttempted) {
        this.localReflectionLoadAttempted = true;
        void this.ensureModelLoaded();
      }
      return;
    }
    if (!this.localReflectionModel) {
      this.localReflectionModel = this.createModelInstance("water-local-body");
      if (!this.localReflectionModel) return;
      const model = this.localReflectionModel;
      model.anchor.metadata = { ...model.anchor.metadata, waterReflectionOnly: true };
      for (const mesh of [model.mesh, ...model.mesh.getChildMeshes()]) {
        mesh.isVisible = false;
        mesh.isPickable = false;
      }
    }
    const model = this.localReflectionModel;
    const resumed = !model.anchor.isEnabled();
    model.anchor.setEnabled(true);
    model.anchor.position.set(
      state.x,
      state.y + PLAYER_MINS_Z + MODEL_Y_OFFSET - (state.sliding ? 20 : state.crouching ? 10 : 0),
      state.z,
    );
    model.anchor.rotation.y = state.yaw;
    this.modelManager.resetRootMotion(model);
    if (resumed) model.currentAnim = "";
    this.modelManager.playAnimation(model, deriveAnimation(state));
    if (resumed) model.masterGroup?.play(true);
  }

  /** The viewer's own side, so everyone else can be read as ally or enemy. */
  private localTeam: string | null = null;

  setLocalTeam(teamId: string | null | undefined): void {
    this.localTeam = teamId ?? null;
  }

  /**
   * Whose eyes the viewer borrows in a demo: that player is coloured as your
   * own side, and everyone else is read from their side, as in live play.
   */
  private perspectiveEntityId: string | null = null;

  setPerspectiveEntity(entityId: string | null): void {
    this.perspectiveEntityId = entityId;
  }

  private resolvePlayerTeamSlot(entityId: string): PlayerTeamSlot {
    const viewer = this.perspectiveEntityId;
    if (viewer !== null) {
      if (entityId === viewer) return "ally";
      return getPlayerTeamSlot(this.teams.get(entityId), this.teams.get(viewer));
    }
    return getPlayerTeamSlot(this.teams.get(entityId), this.localTeam);
  }

  /**
   * A free-for-all opponent's own colour; null in a team gametype (Duel
   * included: two sides of one), where the slot colours apply even to a
   * spectator's view. The gametype decides rather than the player's team,
   * which older servers and demos sent as "spectator" for FFA players.
   */
  private ffaColor(entityId: string, slot: PlayerTeamSlot) {
    if (slot !== "ffa" || MatchStateManager.getInstance().teamBased) return null;
    return this.ffaColors.colorFor(entityId);
  }

  private visualStyle(entityId: string): { style: PlayerModelVisualStyle; key: string } {
    const slot = this.resolvePlayerTeamSlot(entityId);
    const color = this.ffaColor(entityId, slot);
    return color
      ? {
          style: getFfaPlayerModelVisualStyle(color, MODEL_SCALE),
          key: `${getPlayerModelVisualStyleKey(slot)}|${color.id}`,
        }
      : { style: getPlayerModelVisualStyle(slot, MODEL_SCALE), key: getPlayerModelVisualStyleKey(slot) };
  }

  /** Keep legacy alpha/bravo names for older cosmetic effects. */
  private resolveLegacyTeamColor(entityId: string): "alpha" | "bravo" {
    return legacyTeamColor(this.resolvePlayerTeamSlot(entityId), entityId);
  }

  private applyModelVisualStyle(instance: PlayerModelInstance, entityId: string): string {
    const { style, key } = this.visualStyle(entityId);
    this.modelManager?.applyVisualStyle(instance, style);
    return key;
  }

  /**
   * Force a self-lit style on a detached showcase model (post-game winner).
   * Keeps the team tint/outline but forces fullbright emissive on regardless of
   * the `cl_player_fullbright` cvar, so the winner is a clear hero shot even
   * when the camera-relative spawn spot is a dark corner of the map (otherwise
   * the model renders as a black silhouette — it's lit only by the scene).
   */
  applyShowcaseVisualStyle(instance: PlayerModelInstance, entityId: string): void {
    const base = this.visualStyle(entityId).style;
    this.modelManager?.applyVisualStyle(instance, {
      ...base,
      fullbrightEnabled: true,
      fullbrightIntensity: Math.max(base.fullbrightIntensity, 0.6),
    });
  }

  private applyHitboxVisualStyle(hitbox: RemotePlayerHitbox, entityId: string): void {
    if (!hitbox.model) return;
    // Three team slots, so three keys a frame instead of one per player: each is
    // six settings reads and a join, almost always to find nothing changed.
    const slot = this.resolvePlayerTeamSlot(entityId);
    let key = this.frameStyleKeys.get(slot);
    if (key === undefined) {
      key = getPlayerModelVisualStyleKey(slot);
      this.frameStyleKeys.set(slot, key);
    }
    const color = this.ffaColor(entityId, slot);
    if (color) key = `${key}|${color.id}`;
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
    // The buffer owns freshness: a stale or duplicate tick must not roll the
    // roster or respawn bookkeeping back either, so nothing is applied until
    // the snapshot has been accepted.
    const entities = extractEntities(state, localEntityId);
    if (!this.snapshotBuffer.push(state.tick, entities, serverLocalTime)) return;

    // Track team per entity for team-colored models (keyed by client entityId)
    const localTeam = applyRoster(this.teams, state.players.values(), localEntityId);
    if (localTeam !== undefined) this.localTeam = localTeam;

    this.clearRespawnedEntities(entities);
  }

  /**
   * Start a new connection's presentation state.
   *
   * The renderer outlives a session, so everything keyed by entity id has to go:
   * a new server hands the same ids to different people, and a body left dead,
   * on the wrong team, or bracketed against its predecessor's position would
   * render that mix-up. Bodies themselves need no explicit removal — render()
   * drops every hitbox missing from the (now empty) buffer on the next frame.
   */
  resetSession(): void {
    this.snapshotBuffer.reset();
    this.deadEntities.clear();
    this.teams.clear();
    this.ffaColors.clear();
    this.localTeam = null;
    this._hiddenEntityId = null;
    this.hiddenCorpse = null;
    this._lastAnimLog.clear();
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
    // The render loop pushes the next frame as lookahead every frame, and it
    // is the same frame until the playhead moves: at 144 fps on a 60 Hz demo,
    // two or three identical rebuilds. Skip it when nothing touched the
    // timeline since this very push.
    const timeline = this.demoTimeline;
    if (lookahead && timeline && state === this.lastLookaheadState && timeline.version === this.lastLookaheadVersion) {
      return;
    }
    const localTeam = applyRoster(this.teams, state.players.values(), localEntityId);
    if (localTeam !== undefined) this.localTeam = localTeam;
    const entities = extractEntities(state, localEntityId);
    this.demoTimeline?.push(state.tick, entities);
    this.lastLookaheadState = lookahead ? state : null;
    this.lastLookaheadVersion = this.demoTimeline?.version ?? -1;
    if (!lookahead) {
      this.clearRespawnedEntities(entities);
    }
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
    void this.modelManager?.setOutlineProxyEnabled(Cvar.getBool("cl_player_outline_proxy"));
    // One camera read for the whole frame, for the animation LOD below.
    const camera = this.scene?.activeCamera ?? null;
    const cameraPos = camera?.globalPosition ?? null;
    const animationLodRadiusSq = this.animationLodRadiusSq(camera);
    const poseFrustum = this.poseFrustum(camera);
    this.framePoseStep = this.poseStepPlan(camera);

    // Get all entities from latest snapshot for lifecycle management
    const aliveIds = this.demoTimeline
      ? this.demoTimeline.getEntityIds(this.demoPlayheadTick)
      : this.snapshotBuffer.getLatestEntityIds();

    // Settings read once a frame, not once per player (B12 stage 3).
    //
    // Absent cvar means OFF, matching the registered default. It used to mean
    // ON, so any frame where the lookup came back empty — before registration
    // has run, or after a registry reset — flashed a debug wireframe around
    // every player.
    const showHitbox = Number(Cvar.get("cl_remotehitbox") ?? 0) > 0;
    this.frameAnimDebug = Number(Cvar.get("cl_animdebug") ?? 0) > 0;
    this.frameStyleKeys.clear();
    try {
      this.renderEntities(aliveIds, showHitbox, cameraPos, animationLodRadiusSq, poseFrustum);
    } finally {
      // Outside a frame the settings may change, so nothing read here is kept.
      this.frameStyleKeys.clear();
      this.frameAnimDebug = null;
    }

    // Remove hitboxes for entities no longer alive
    for (const [entityId, hitbox] of this.hitboxes) {
      if (!aliveIds.has(entityId)) {
        hitbox.mesh.dispose();
        if (hitbox.weaponRoot) {
          disposeModelResources([hitbox.weaponRoot]);
          hitbox.weaponRoot = null;
        }
        if (hitbox.model && this.modelManager) {
          this.modelManager.disposeInstance(hitbox.model);
        }
        this.hitboxes.delete(entityId);
        this.deadEntities.delete(entityId);
        this.demoAnimationTimeline?.delete(entityId);
        // Their tracked water level goes with them. Left behind it would both
        // accumulate for every player who ever entered PVS, and hand a reused
        // id a stale depth to be compared against.
        this.liquidInteractions?.forget(entityId);
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
    this.disposed = true;
    if (this.localReflectionModel && this.modelManager) this.modelManager.disposeInstance(this.localReflectionModel);
    this.localReflectionModel = null;
    getHitscanEffects().clearRemoteLightningMuzzleResolver(this.voltaicMuzzleResolver);
    for (const hitbox of this.hitboxes.values()) {
      hitbox.mesh.dispose();
      if (hitbox.weaponRoot) {
        disposeModelResources([hitbox.weaponRoot]);
        hitbox.weaponRoot = null;
      }
      if (hitbox.model && this.modelManager) {
        this.modelManager.disposeInstance(hitbox.model);
      }
    }
    this.hitboxes.clear();
    this.deadEntities.clear();
    this.teams.clear();
    this.ffaColors.clear();
    this.demoTimeline?.clear();
    this.demoTimeline = null;
    this.demoAnimationTimeline?.clear();
    this.demoAnimationTimeline = null;
    if (this.modelManager) {
      this.modelManager.dispose();
      this.modelManager = null;
    }
    this.weaponModelCache?.dispose();
  }

  /**
   * Mark an entity as dead — dispose its mesh immediately.
   * Called from Game on death events.
   * A fresh hitbox will be created when the entity respawns and reappears in snapshots.
   */
  markDead(entityId: string): void {
    this.forgetLife(entityId);
    const hitbox = this.hitboxes.get(entityId);
    if (hitbox) {
      hitbox.mesh.dispose();
      if (hitbox.weaponRoot) {
        disposeModelResources([hitbox.weaponRoot]);
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
    // This body is physicalised in the same tick it is built, before any frame
    // has evaluated its idle clip. Without settling the pose first the ragdoll
    // builds its bone bodies from the bind pose and the corpse stays a T-pose.
    this.modelManager?.settlePose(model);
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
    if (entityId === this._hiddenEntityId && this.followedMuzzle) {
      const muzzle = this.followedMuzzle();
      if (muzzle) {
        result.copyFrom(muzzle);
        return true;
      }
    }
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
    // The showcase can end while the gun loads (next warmup, disconnect). Its
    // model is gone then, and a gun attached to nothing leaked (S5).
    if (inst.mesh.isDisposed()) {
      disposeModelResources([result.root], { animationGroups: result.animationGroups });
      return;
    }

    let leaderMesh: Mesh | null = null;
    for (const m of result.meshes) {
      if (m instanceof Mesh && m.getTotalVertices() > 0) {
        if (!leaderMesh) leaderMesh = m;
        if (m.material && "maxSimultaneousLights" in m.material) {
          applySafeMaxSimultaneousLights(m.material);
        }
        m.alwaysSelectAsActiveMesh = true;
        m.isVisible = true;
      }
    }
    if (!leaderMesh) {
      disposeModelResources([result.root], { animationGroups: result.animationGroups });
      return;
    }
    if (weaponId === "blade") {
      attachBladeToPlayer(result, inst, visualScale, MODEL_SCALE);
      return;
    }
    if (leaderMesh.rotationQuaternion) leaderMesh.rotationQuaternion = null;

    const hand = inst.skeleton?.bones.find((b) => b.name === "mixamorig:RightHand");
    if (hand) {
      leaderMesh.parent = null;
      leaderMesh.attachToBone(hand, inst.mesh);
      leaderMesh.position.set(0, 0, 0);
      leaderMesh.scaling.setAll((visualScale / MODEL_SCALE) * 0.5);
      leaderMesh.rotation.set(Math.PI, 0, -Math.PI / 2);
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

    result.root.parent = null;
    result.root.setEnabled(false);
    bindLoaderLeftovers(leaderMesh, result.root, result.animationGroups);
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
  getRenderedPlayers(): ReadonlyMap<string, Readonly<RenderedPlayer>> {
    // Spectating asks every frame, so the map and its entries are reused rather
    // than rebuilt: valid until the next call, which is all any caller needs.
    const out = this.renderedPlayers;
    out.clear();
    for (const [entityId, hitbox] of this.hitboxes) {
      let entry = this.renderedEntries.get(entityId);
      if (!entry) {
        entry = { position: hitbox.smoothedPos, dead: false };
        this.renderedEntries.set(entityId, entry);
      }
      entry.position = hitbox.smoothedPos;
      entry.dead = this.deadEntities.has(entityId);
      out.set(entityId, entry);
    }
    if (this.renderedEntries.size > out.size) {
      for (const entityId of this.renderedEntries.keys()) {
        if (!out.has(entityId)) this.renderedEntries.delete(entityId);
      }
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

    // The bomb asks for its carrier's spine every frame, and a rig's bones do
    // not change after load: look each name up once per skeleton.
    let byName = this.bonesByName.get(model.skeleton);
    if (!byName) {
      byName = new Map();
      this.bonesByName.set(model.skeleton, byName);
    }
    let bone = byName.get(boneName);
    if (bone === undefined) {
      // glTF import writes Mixamo names with a colon; the shared rig map uses the
      // sanitized form. Accept either rather than making callers guess.
      const bones = model.skeleton.bones;
      const suffix = boneName.toLowerCase();
      bone =
        bones.find((b) => b.name === `mixamorig:${boneName}`) ??
        bones.find((b) => b.name === `mixamorig${boneName}`) ??
        bones.find((b) => b.name.toLowerCase().endsWith(suffix)) ??
        null;
      byName.set(boneName, bone);
    }
    return bone?.getTransformNode() ?? null;
  }

  /**
   * What a death ends, whichever way the body goes (removed, or handed to a
   * ragdoll): the player counts as dead, and their demo one-shot and water level
   * are forgotten. A body that dies at the bottom of a pool and respawns dry
   * goes from level 3 to level 0 without ever breaking the surface; remembered,
   * the respawn announces itself with an exit splash on dry land.
   */
  private forgetLife(entityId: string): void {
    this.deadEntities.set(entityId, performance.now());
    this.demoAnimationTimeline?.delete(entityId);
    this.liquidInteractions?.forget(entityId);
  }

  /**
   * Detach a player model from the renderer WITHOUT disposing it.
   * Returns the PlayerModelInstance for ragdoll use.
   * The hitbox mesh is disposed but the model (skeleton + mesh + anchor) is preserved.
   */
  detachModel(entityId: string): import("../../../engine/animation/PlayerModelManager").PlayerModelInstance | null {
    this.forgetLife(entityId);
    const hitbox = this.hitboxes.get(entityId);
    if (!hitbox?.model) {
      if (hitbox) {
        hitbox.mesh.dispose();
        if (hitbox.weaponRoot) {
          disposeModelResources([hitbox.weaponRoot]);
          hitbox.weaponRoot = null;
        }
        this.hitboxes.delete(entityId);
      }
      return null;
    }
    const model = hitbox.model;
    // A one-shot (a blade swing) is the manager's; the ragdoll drives the bones now.
    this.modelManager?.stopOneShot(model, false);
    // Physics carries the bones off the anchor, outside the pose bounds.
    this.modelManager?.selectAlways(model);
    this.poseBounded.delete(model);
    model.attachedWeapon = hitbox.weaponRoot;
    hitbox.weaponRoot = null;
    hitbox.mesh.dispose();
    this.hitboxes.delete(entityId);
    // PVS or spectating may have switched the body and weapon off, and the
    // ragdoll draws whatever it is handed. The one we watched from inside
    // their head stays hidden until the camera moves on (setHiddenEntity).
    if (entityId === this._hiddenEntityId) this.hiddenCorpse = model;
    else showCorpse(model);
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

  /**
   * The sample a player is drawn from this frame: the demo timeline during
   * playback, the interpolated snapshot buffer live.
   */
  getEntitySample(entityId: string): InterpolatedEntity | null {
    return this.demoTimeline ? this.getDemoEntitySample(entityId) : this.snapshotBuffer.sample(entityId);
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
      builtHeight: height,
      model,
      weaponRoot: null,
      weaponMuzzle: null,
      handBone: null,
      currentWeaponId: "",
      appliedVisualStyleKey: model ? this.visualStyle(entityId).key : null,
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

  /**
   * Decide what this player still costs us: drawing, animating, both or
   * neither.
   *
   * Two independent reasons to stop work, applied to two different budgets:
   *
   * - **PVS** answers "can the camera see this room at all". Players move, so
   *   they carry no compiled cluster and the static culler never considered
   *   them — every body in the map was being submitted every frame.
   * - **Distance** answers "is limb motion resolvable". Beyond the far
   *   threshold a stride is sub-pixel, so the skeleton is updating to produce
   *   an image nobody can distinguish from a still one.
   *
   * Hiding a mesh saves the draw call and nothing else — AnimationGroups run at
   * the scene level and keep evaluating bones for an invisible model — so the
   * animation is paused separately, and that is the larger saving on a map full
   * of bots.
   *
   * PVS is decided first (`isInView`) and switches the body, hitbox and weapon
   * on or off once; distance only pauses the animation (`applyAnimationLod`).
   */

  /**
   * The distance at which a standing player covers
   * {@link ANIMATION_LOD_MIN_PIXELS} of screen height, squared.
   *
   * Solved once per frame from the live camera rather than per player, so the
   * per-player test stays a squared-distance compare. Returns 0 — meaning "do
   * not pause anything for size" — whenever the camera cannot be measured, so
   * an unusual projection fails toward animating rather than toward frozen
   * bodies.
   */
  private animationLodRadiusSq(camera: { fov?: number; mode?: number } | null): number {
    const engine = this.scene?.getEngine();
    if (!engine || !camera) return 0;
    return animationLodRadiusSq(
      camera.fov,
      camera.mode,
      engine.getRenderHeight(),
      PLAYER_HEIGHT,
      RemotePlayerRenderer.ANIMATION_LOD_MIN_PIXELS,
    );
  }

  /**
   * The main view's frustum, for pausing the skeletons of players it cannot
   * see; null when something else may be looking. A water mirror shows bodies
   * the main camera does not, and so does a second active camera, and a
   * frozen stride there is the visible kind of wrong. Drawing is not decided
   * here: each pass culls bodies by their pose bounds on its own.
   */
  private poseFrustum(camera: { getTransformationMatrix(): Matrix } | null) {
    const scene = this.scene;
    if (!scene || !camera || (scene.activeCameras?.length ?? 0) > 1 || waterNeedsLocalReflection(scene)) return null;
    Frustum.GetPlanesToRef(camera.getTransformationMatrix(), this.frustumPlanes);
    return this.frustumPlanes;
  }

  /**
   * This frame's reduced-rate pose plan: who counts as medium distance, and
   * how often their skeleton is posed. Null when the rate is off
   * (`cl_player_pose_hz 0`) or the camera cannot be measured.
   */
  private poseStepPlan(camera: { fov?: number; mode?: number } | null): {
    enterSq: number;
    leaveSq: number;
    dtSeconds: number;
    stepSeconds: number;
  } | null {
    const hz = Number(Cvar.get("cl_player_pose_hz") ?? RemotePlayerRenderer.POSE_STEP_HZ);
    const engine = this.scene?.getEngine();
    if (!this.scene || !engine || !camera || !(hz > 0)) return null;
    const radiusSq = (pixels: number) =>
      animationLodRadiusSq(camera.fov, camera.mode, engine.getRenderHeight(), PLAYER_HEIGHT, pixels);
    const enterSq = radiusSq(RemotePlayerRenderer.POSE_STEP_ENTER_PIXELS);
    const leaveSq = radiusSq(RemotePlayerRenderer.POSE_STEP_LEAVE_PIXELS);
    if (!(enterSq > 0) || !(leaveSq > 0)) return null;
    return { enterSq, leaveSq, dtSeconds: animationDeltaSeconds(this.scene), stepSeconds: 1 / hz };
  }

  /** One frame of every alive remote player; see render(). */
  private renderEntities(
    aliveIds: Iterable<string>,
    showHitbox: boolean,
    cameraPos: Vector3 | null,
    animationLodRadiusSq: number,
    poseFrustum: readonly Plane[] | null,
  ): void {
    // Settings, clock and bracketing snapshots once for every player, and each
    // sample written into one reused object (B12 stage 4). Nothing below keeps
    // `interp` past its player: createHitbox and playTeleportEffect copy it.
    if (!this.demoTimeline) this.snapshotBuffer.beginFrame();

    // Sample interpolated state for each alive entity
    for (const entityId of aliveIds) {
      // Skip dead entities — their mesh is hidden until entity leaves snapshot
      if (this.deadEntities.has(entityId)) continue;

      const interp = this.demoTimeline
        ? this.demoTimeline.sample(entityId, this.demoPlayheadTick)
        : this.snapshotBuffer.sampleInFrame(entityId, this.frameSample);
      if (!interp) continue;

      let hitbox = this.hitboxes.get(entityId);

      // Create hitbox for new entity
      if (!hitbox) {
        const created = this.createHitbox(entityId, interp);
        if (created) {
          this.hitboxes.set(entityId, created);
          hitbox = created;
          // Trigger async model load on first remote player
          background(this.ensureModelLoaded(), "RemotePlayerRenderer");
        }
      }

      if (!hitbox) continue;

      // Hidden entity (followed player in demo POV) — keep invisible every frame.
      // Third-person weapons are bone-driven external roots, so hide them too.
      if (entityId === this._hiddenEntityId) {
        hitbox.mesh.setEnabled(false);
        if (hitbox.model) hitbox.model.anchor.setEnabled(false);
        if (hitbox.weaponRoot) hitbox.weaponRoot.setEnabled(false);
        // Still tracked, undrawn: frozen where we started following them, the
        // first frame after switching away was a jump, taken for a teleport (R2).
        this.updatePosition(hitbox, interp);
        continue;
      }

      // Ensure model is assigned — catches any timing gaps during initial load
      if (!hitbox.model && this.modelManager?.isLoaded) {
        hitbox.model = this.createModelInstance(entityId);
        if (hitbox.model) {
          devLog(`[RemotePlayerRenderer] Late model assign for ${entityId}`);
        }
      }

      // Crouch/uncrouch scales the wireframe rather than rebuilding it. The box
      // is centred on its origin and the only thing height changes is its half
      // extent, so a Y scale is exactly the same geometry — and this fires on
      // every crouch transition of every player, which was twelve edges of mesh
      // allocated and discarded each time.
      const targetHeight = interp.crouching ? CROUCH_HEIGHT : PLAYER_HEIGHT;
      if (hitbox.currentHeight !== targetHeight) {
        hitbox.mesh.scaling.y = targetHeight / hitbox.builtHeight;
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

      // PVS: a player in a room the camera cannot see is not drawn. Players
      // move, so they carry no compiled cluster and the static culler never
      // considered them — every body in the map was submitted every frame.
      //
      // Decided before anything is switched on, so a culled player is switched
      // off once rather than on and off again: each change walks the whole
      // skeleton (B12 stage 2).
      const visible = this.isInView(hitbox.mesh.position);

      // Restore hitbox visibility (it is hidden during death).
      hitbox.mesh.setEnabled(visible && showHitbox);

      // Update model position + animation
      this.updateModel(hitbox, interp, entityId, this.demoTimeline ? this.demoAnimationTimeScale : 1, visible);

      // Powerup carrier glow (pulses, so it must run every frame, not on change)
      this.updatePowerupGlow(hitbox, entityId, interp.powerupMask ?? 0, performance.now() / 1000);

      // Animation runs only for a player who is drawn and big enough to read.
      this.applyAnimationLod(hitbox, visible, cameraPos, animationLodRadiusSq, poseFrustum);
    }
  }

  /**
   * Whether the camera's room can see this player. Three points up the body: a
   * player in a doorway or on a stair has their origin in one cluster and their
   * shoulders in another, and culling on the origin alone makes them blink.
   */
  private isInView(at: Vector3): boolean {
    const culler = BspManager.getInstance().getPvsCuller();
    if (!culler) return true;
    const probe = this.pvsProbe;
    return (
      culler.isPositionVisible(at) ||
      culler.isPositionVisible(probe.set(at.x, at.y + PLAYER_MINS_Z + 2, at.z)) ||
      culler.isPositionVisible(probe.set(at.x, at.y + PLAYER_MAXS_Z - 2, at.z))
    );
  }

  private applyAnimationLod(
    hitbox: RemotePlayerHitbox,
    visible: boolean,
    cameraPosition: Vector3 | null,
    animationLodRadiusSq: number,
    poseFrustum: readonly Plane[] | null,
  ): void {
    if (!hitbox.model || !this.modelManager) return;

    // Behind the camera or off to the side, nobody sees the stride. The sphere
    // wraps the pose bounds, so a player resumes before any limb reaches the
    // screen edge.
    const anchor = hitbox.model.anchor.position;
    const offScreen =
      poseFrustum !== null &&
      !sphereInFrustum(
        poseFrustum,
        anchor.x,
        anchor.y + RemotePlayerRenderer.POSE_SPHERE_CENTER_Y,
        anchor.z,
        RemotePlayerRenderer.POSE_SPHERE_RADIUS,
      );

    // Beyond the LOD radius the body is a thumbnail and its limbs cannot be
    // read; a radius of 0 means the camera could not be measured, so nothing is
    // paused for distance.
    const tooSmall =
      cameraPosition !== null &&
      animationLodRadiusSq > 0 &&
      Vector3.DistanceSquared(cameraPosition, hitbox.mesh.position) > animationLodRadiusSq;

    if (!visible || tooSmall || offScreen) {
      hitbox.poseStepped = false;
      this.modelManager.setAnimationActive(hitbox.model, false);
      return;
    }

    // Medium distance: the stride reads, but a pose 30 times a second is
    // indistinguishable from one every frame at this size. Entering and
    // leaving at different sizes keeps a player on the boundary from
    // alternating every frame.
    const plan = this.framePoseStep;
    if (plan && cameraPosition) {
      const distanceSq = Vector3.DistanceSquared(cameraPosition, hitbox.mesh.position);
      hitbox.poseStepped = distanceSq > (hitbox.poseStepped ? plan.leaveSq : plan.enterSq);
    } else {
      hitbox.poseStepped = false;
    }
    if (hitbox.poseStepped && plan) this.modelManager.stepAnimation(hitbox.model, plan.dtSeconds, plan.stepSeconds);
    else this.modelManager.setAnimationActive(hitbox.model, true);
  }

  /**
   * The body's child meshes, listed once per model: the rig is cloned once and
   * never gains or loses a mesh (the hand weapon hangs off a bone, not the
   * body), and listing them built a new array per player per frame.
   */
  /** applyAttachedWeaponQuadOutline's meshes and their fixed scale, per weapon model. */
  private readonly weaponOutlineMeshes = new WeakMap<object, { mesh: AbstractMesh; scale: number }[]>();

  private bodyPartsOf(inst: PlayerModelInstance): AbstractMesh[] {
    let parts = this.bodyParts.get(inst);
    if (!parts) {
      parts = inst.mesh.getChildMeshes();
      this.bodyParts.set(inst, parts);
    }
    return parts;
  }

  private updatePowerupGlow(hitbox: RemotePlayerHitbox, entityId: string, mask: number, elapsed: number): void {
    if (!hitbox.model || !this.modelManager) return;
    const active = maskHasPowerup(mask, "quad");

    if (!active) {
      if (hitbox.powerupGlowActive) {
        hitbox.powerupGlowActive = false;
        hitbox.appliedVisualStyleKey = null; // force a base-style re-apply
        this.applyHitboxVisualStyle(hitbox, entityId);
        this.applyAttachedWeaponQuadOutline(hitbox, false, Color3.Black(), 0);
      }
      return;
    }

    hitbox.powerupGlowActive = true;
    const pulse = getQuadDamagePulse(elapsed);
    const intensity = QUAD_EMISSIVE_MIN + QUAD_EMISSIVE_RANGE * pulse;
    const playerOutlineSize = QUAD_PLAYER_OUTLINE_MIN + QUAD_PLAYER_OUTLINE_RANGE * pulse;
    const weaponOutlineWidth = QUAD_WORLD_WEAPON_OUTLINE_MIN + QUAD_WORLD_WEAPON_OUTLINE_RANGE * pulse;
    const width = playerOutlineSize / Math.max(1, MODEL_SCALE * 16);
    this.modelManager.applyPowerupGlow(hitbox.model, QUAD_DAMAGE_COLOR, intensity, width);
    this.applyAttachedWeaponQuadOutline(hitbox, true, QUAD_DAMAGE_COLOR, weaponOutlineWidth);
  }

  /**
   * The hand weapon is loaded outside PlayerModelInstance, so the body styling
   * pass cannot see it. Give it the same override explicitly and compensate for
   * absolute scale so GLB and MD3 weapons receive comparable silhouettes.
   */
  private applyAttachedWeaponQuadOutline(
    hitbox: RemotePlayerHitbox,
    active: boolean,
    color: Color3,
    worldWidth: number,
  ): void {
    const root = hitbox.weaponRoot;
    if (!root) return;
    // Listed, and their scale measured, once per weapon model: this runs every
    // frame while quad is held, and the scale of an attached weapon is fixed.
    let outlined = this.weaponOutlineMeshes.get(root);
    if (!outlined) {
      outlined = [];
      const meshes: AbstractMesh[] =
        root instanceof Mesh ? [root, ...root.getChildMeshes(false)] : root.getChildMeshes(false);
      for (const mesh of meshes) {
        if (mesh.getTotalVertices() <= 0) continue;
        mesh.computeWorldMatrix(true);
        const scale = Math.max(0.001, mesh.absoluteScaling.x, mesh.absoluteScaling.y, mesh.absoluteScaling.z);
        outlined.push({ mesh, scale });
      }
      this.weaponOutlineMeshes.set(root, outlined);
    }

    for (const { mesh, scale } of outlined) {
      mesh.renderOutline = active;
      if (active) {
        mesh.outlineColor = color;
        mesh.outlineWidth = worldWidth / scale;
      }
    }
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

  /**
   * Below this on-screen height, in pixels, a player's skeleton is paused.
   *
   * Screen height rather than world distance, because "can a viewer resolve
   * limb motion" is a question about projected size: the same distance is a
   * different picture at 70 degrees and at 110, or on 1080p and on a phone. The
   * first cut of this used a flat 2500-unit radius and froze bots in plain
   * sight — 2500 Quake units is about sixty metres, where a stride is small but
   * perfectly readable.
   *
   * 24 pixels is roughly a thumbnail of a body, where a limb is a pixel or two
   * and its motion is not resolvable. Deliberately conservative: a frozen
   * animation somewhere a player can read it is far more noticeable than the
   * CPU it saves.
   */
  private static readonly ANIMATION_LOD_MIN_PIXELS = 24;

  /** Washoi teleport VFX: generic pooled team-color ghost + speed-line burst at both ends. */
  private playTeleportEffect(hitbox: RemotePlayerHitbox, entityId: string, interp: InterpolatedEntity): void {
    const from = { x: hitbox.smoothedPos.x, y: hitbox.smoothedPos.y, z: hitbox.smoothedPos.z };
    const to = { x: interp.x, y: interp.y, z: interp.z };
    const fromYaw = hitbox.smoothedYaw;
    // Read now: the sample is reused for the next player before the import lands.
    const toYaw = interp.yaw;
    const team = this.resolveLegacyTeamColor(entityId);
    import("./TeleportEffect")
      .then(({ TeleportEffect }) => {
        TeleportEffect.getInstance().playerTeleported(this.scene, from, to, fromYaw, toYaw, team);
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
    visible: boolean,
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
    inst.anchor.setEnabled(visible);
    // The hand weapon is parented to a bone, not the anchor, so switching the
    // anchor does not reach it: it follows the body explicitly.
    hitbox.weaponRoot?.setEnabled(visible);

    // Reset root motion each frame (position + rotation drift from anims)
    this.modelManager.resetRootMotion(inst);
    inst.mesh.scaling.set(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);
    if (inst.mesh.rotationQuaternion) inst.mesh.rotationQuaternion = null;
    inst.mesh.rotation.set(0, 0, 0);

    // Ensure the body is renderable. Its bounds hold every pose (set once, with
    // the scale and root motion above in place), so each camera and pass culls
    // it against its own frustum: a player behind the camera is not drawn, and
    // one a water mirror can see still is.
    if (!this.poseBounded.has(inst)) {
      this.modelManager.useConservativeBounds(inst);
      this.poseBounded.add(inst);
    }
    inst.mesh.setEnabled(true);
    inst.mesh.isVisible = true;
    inst.mesh.visibility = 1;
    for (const m of this.bodyPartsOf(inst)) {
      m.setEnabled(true);
      m.isVisible = true;
      m.visibility = 1;
    }

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
    const animName = deriveAnimation(interp);
    this.modelManager.playAnimation(inst, animName);
    this._animDebug(entityId, animName, interp, inst);

    // Splashes come from the water level already on the wire, so a remote
    // diving into a pool produces the same interaction as the local player
    // with no new network state. Replicate causes, derive effects.
    this.liquidInteractions?.notify(
      entityId,
      (interp.waterLevel ?? 0) as 0 | 1 | 2 | 3,
      "water",
      { x: interp.x, y: interp.y, z: interp.z },
      interp.vy,
      false,
    );

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
      } else if (animName === "climb") {
        // Hand-over-hand is driven by vertical velocity, so the clip advances
        // exactly as far as the body does: climbing plays forward, descending
        // plays the same clip backwards, and pausing on a rung freezes it
        // mid-reach. Tying it to displacement rather than wall-clock also means
        // prediction and reconciliation cannot drift the hands off the ladder.
        const climbRatio = interp.vy / CLIMB_NATURAL_SPEED;
        inst.masterGroup.speedRatio = Math.max(-2.0, Math.min(2.0, climbRatio));
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
   * Imports each source once and clones independent instances on weapon changes.
   */
  private updateWeaponModel(hitbox: RemotePlayerHitbox, inst: PlayerModelInstance, entityId: string): void {
    const weaponId = this.enemyWeapons.get(entityId);
    if (!weaponId) return;

    // No change — nothing to do
    if (weaponId === hitbox.currentWeaponId) return;

    devLog(`[RemoteWeapon] ★ Weapon change: ${entityId} → ${weaponId}`);
    hitbox.currentWeaponId = weaponId;
    const generation = (hitbox.weaponLoadGeneration ?? 0) + 1;
    hitbox.weaponLoadGeneration = generation;

    // Dispose previous weapon
    if (hitbox.weaponRoot) {
      disposeModelResources([hitbox.weaponRoot]);
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

        if (this.disposed || this.scene.isDisposed) return;
        this.weaponModelCache ??= new ModelInstanceCache(
          this.scene,
          async (path, scale) =>
            loader.loadModel(path, {
              position: Vector3.Zero(),
              scale,
              hasCollision: false,
              applyLighting: false,
            }),
          {
            // Weapon highlights belong to meshes; these PBR materials are read-only.
            // A weapon switch then builds no material, and so no shader. WebGPU
            // keeps clones: sharing was only ever measured on WebGL.
            shareStaticMaterials: !this.scene.getEngine().isWebGPU,
          },
        );
        const result = await this.weaponModelCache.createInstance(modelPath, defScale);

        if (!result?.root) {
          console.warn(`[RemoteWeapon] ModelLoader returned null for ${weaponId}`);
          return;
        }

        if (
          this.hitboxes.get(entityId) !== hitbox ||
          this.deadEntities.has(entityId) ||
          hitbox.currentWeaponId !== weaponId ||
          hitbox.weaponLoadGeneration !== generation
        ) {
          disposeModelResources([result.root], result);
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
              applySafeMaxSimultaneousLights(m.material);
            }
            // Disable frustum culling
            m.alwaysSelectAsActiveMesh = true;
            m.isVisible = true;
          }
        }

        if (!leaderMesh) {
          console.warn(`[RemoteWeapon] No meshes with geometry for ${weaponId}`);
          disposeModelResources([result.root], { animationGroups: result.animationGroups });
          return;
        }

        if (weaponId === "blade") {
          hitbox.weaponRoot = attachBladeToPlayer(result, inst, visualScale, MODEL_SCALE);
          hitbox.weaponMuzzle = null;
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
              // GLB weapons use their authored view-model scale; MD3s use world scale.
              const thirdPersonScale = (visualScale / MODEL_SCALE) * 0.5;
              leaderMesh.scaling.setAll(thirdPersonScale);

              // Weapon-specific rotation in bone-local space
              // (differs from first-person loadGlbWeapon rotations)
              // IQM→GLB guns: barrel along +X in model space.
              // Bone +Y = along fingers; X/Z rotations align and right the gun.
              leaderMesh.rotation.set(Math.PI, 0, -Math.PI / 2);

              attached = true;
              devLog(
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

        // Detach loader root. It may still hold the bones a skinned weapon is
        // drawn with, so it goes when the weapon goes, not now.
        if (result.root) {
          result.root.parent = null;
          result.root.setEnabled(false);
          bindLoaderLeftovers(leaderMesh, result.root, result.animationGroups);
        }

        hitbox.weaponRoot = leaderMesh as unknown as TransformNode;
        hitbox.weaponMuzzle = muzzleNode ?? null;
        // Track the weapon on the model instance so it is disposed WITH the model
        // (bone-attached meshes aren't scene-graph children). This makes a dropped
        // blade ride the death ragdoll and vanish with it instead of leaking a
        // floating mesh that piles up over a match.
        inst.attachedWeapon = leaderMesh as unknown as TransformNode;
        devLog(
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
    if (!(this.frameAnimDebug ?? Number(Cvar.get("cl_animdebug") ?? 0) > 0)) return;
    const now = performance.now();
    if (now - (this._lastAnimLog.get(entityId) ?? 0) < 1000) return; // throttle: 1/s per entity
    this._lastAnimLog.set(entityId, now);
    const speed = Math.sqrt(interp.vx * interp.vx + interp.vz * interp.vz);
    const g = inst.masterGroup;
    const frame = g?.animatables?.[0]?.masterFrame;
    devLog(
      `[AnimDebug] ${entityId} anim=${animName} speed=${speed.toFixed(0)} grounded=${interp.grounded} ` +
        `vy=${interp.vy.toFixed(0)} ratio=${g?.speedRatio?.toFixed(2) ?? "—"} ` +
        `playing=${g?.isPlaying ?? false} frame=${frame?.toFixed(1) ?? "—"}`,
    );
  }
}

// ─── Cvar Registration ───────────────────────────────────────────

Cvar.register("cl_remotehitbox", 0, {
  type: "int",
  min: 0,
  max: 1,
  description: "Show wireframe hitbox outlines on remote players",
});

Cvar.register("cl_player_pose_hz", 30, {
  type: "int",
  min: 0,
  max: 240,
  description:
    "Pose rate for medium-distance remote players, in Hz (they still move every frame). 0 poses every player every frame",
});

Cvar.register("cl_animdebug", 0, {
  type: "int",
  min: 0,
  max: 1,
  description:
    "Log remote/demo player animation state (derived anim, speed, grounded, whether the anim group advances)",
});

/** Switch a handed-over body and its weapon on, unless the ragdoll is already gone. */
function showCorpse(model: PlayerModelInstance): void {
  if (!model.anchor.isDisposed()) model.anchor.setEnabled(true);
  if (model.attachedWeapon && !model.attachedWeapon.isDisposed()) model.attachedWeapon.setEnabled(true);
}
