/**
 * Game - Manages network simulation for FPS game
 *
 * Bridges FPSPlayer/FPSController with the authoritative simulation.
 * In single-player, runs LocalGameHost with FPSSimulation.
 * In multiplayer, uses NetworkGameHost to connect to a dedicated server.
 */

import { EngineStore } from "@babylonjs/core/Engines/engineStore";
import type { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AudioManager } from "../../engine/AudioManager";
import { CameraSystem } from "../../engine/camera";
import { setGameFrameHook } from "../../engine/camera/GameFrameHook";
import { EventBus } from "../../engine/core/EventBus";
import { log } from "../../engine/core/Log";
import { InputSystem } from "../../engine/input/InputSystem";
import { LocalGameHost } from "../../engine/network/client/hosts/LocalGameHost";
import { NetworkGameHost } from "../../engine/network/client/hosts/NetworkGameHost";
import { NetGraph } from "../../engine/network/client/NetGraph";
import { SnapshotBuffer } from "../../engine/network/client/SnapshotBuffer";
import { TransportFactory } from "../../engine/network/client/transport/Transport";
import { InputButtons } from "../../engine/network/components/InputComponent";
import type { TransformComponent } from "../../engine/network/components/TransformComponent";
import type { GameState } from "../../engine/network/core/GameState";
import type { IGameHost } from "../../engine/network/core/IGameHost";
import { MessageCodec } from "../../engine/network/protocol/MessageCodec";
import { getCollisionManager } from "../../engine/physics/CollisionManager";
import { DEFAULT_VIEWHEIGHT } from "../../engine/physics/PlayerPhysicsConstants";
import { PlayerProfile } from "../../engine/player/PlayerProfile";
import { getProjectileManager } from "../../engine/weapon/ProjectileManager";
import { getWeaponViewManager } from "../../engine/weapon/WeaponViewManager";
import { WEAPONS } from "../../shared/entities/definitions/weapons/WeaponsTable";
import { clientKeyDisplayId, ensureClientKey } from "./ClientEntityKey";
import { V2NetworkClient } from "./client";
import { getAmmoStatus } from "./client/AmmoStatus";
import { BombRenderer } from "./client/BombRenderer";
import { BombSiteMarkers } from "./client/BombSiteMarkers";
import { Crosshair } from "./client/Crosshair";
import { DeathCamera } from "./client/DeathCamera";
import type { DroppedWeaponRenderer } from "./client/DroppedWeaponRenderer";
import { registerFPSActions } from "./client/FPSActions";
import { preloadFPSAudio } from "./client/FPSAudio";
import { FPSBombAudio } from "./client/FPSBombAudio";
import { FPSHud } from "./client/FPSHud";
import { playDrownGasp, playDrownTick } from "./client/FPSLiquidAudio";
import { resetFPSMovementAudio } from "./client/FPSMovementAudio";
// Game event handling (extracted from this file)
import { type GameEventContext, handleServerStateUpdate } from "./client/GameEvents";
import { HUDState } from "./client/HUDState";
import { MatchPhase, MatchStateManager } from "./client/MatchStateManager";
import { RemotePlayerRenderer } from "./client/RemotePlayerRenderer";
import { SpectateEyeCamera } from "./client/SpectateEyeCamera";
import { LiquidInteractionSystem } from "./liquid/client/LiquidInteractionSystem";
import { LocalAirTracker } from "./liquid/client/LocalAirTracker";
import { UnderwaterView } from "./liquid/client/UnderwaterView";
import { createBSPCollisionWorld } from "./simulation/collision/BSPCollisionWorld";
import { type FPSInputCommand, FPSSimulation } from "./simulation/FPSSimulation";

export interface FPSGameConfig {
  tickRate?: number;
  maxPlayers?: number;
  /** When true, auto-join the game after map loads (skip spectator overlay) */
  autoJoin?: boolean;
  /** When true, enter pure spectator mode with auto-chase-cam (no join option) */
  watchOnly?: boolean;
}

/**
 * Player input captured from FPSController
 */
export interface PlayerInputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  fire: boolean;
  altFire: boolean;
  reload?: boolean;
  use: boolean;
  pitch: number; // Camera X rotation
  yaw: number; // Camera Y rotation
  /** Weapon slot (1-based, 0 = no change) */
  weaponSlot: number;
}

/**
 * State update for client to apply
 */
export interface PlayerStateUpdate {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  grounded: boolean;
  tick: number;

  // Advanced movement state for client effects
  isSliding: boolean;
  isCrouching: boolean;
  crouchViewOffset: number;
  wallJumpState: "none" | "available" | "charging";
  ledgeGrabState: "none" | "grabbing" | "pulling";
  actualHorizSpeed: number;
  slidePhase: number;
  ledgeGrabPhase: number;
}

/**
 * How long the death camera keeps your own corpse before handing over to a
 * teammate. Long enough for the ragdoll to land and be read as a death.
 */
const SPECTATE_AFTER_DEATH_MS = 3000;

/**
 * The side chosen in the lobby, if this session came from one.
 *
 * Stashed in sessionStorage by `MatchLobbyView` on the connect handoff, the
 * same way the return-lobby id is, rather than threaded through four layers of
 * connect plumbing that otherwise has no interest in teams.
 */
function readLobbyTeam(): string | undefined {
  try {
    return sessionStorage.getItem("shag.lobby_team") ?? undefined;
  } catch {
    return undefined;
  }
}

/** How long to wait between checks for the server naming the gametype. */
const JOIN_GAMETYPE_WAIT_MS = 100;
/** Give up after this many — a join that never learns the mode still joins. */
const MAX_JOIN_GAMETYPE_WAITS = 30;

export class Game {
  private static instance: Game | null = null;

  private gameHost: IGameHost | null = null;
  private simulation: FPSSimulation | null = null;
  private localPlayerId: string = "";
  private commandSeq: number = 1; // Must match InputHistory.nextSeq (starts at 1)
  private isRunning: boolean = false;
  private isNetworkMode: boolean = false;
  private serverUrl: string | null = null;

  // V2 Network Client for prediction/reconciliation
  private v2Client: V2NetworkClient | null = null;

  // Remote player model renderer
  private remoteRenderer: RemotePlayerRenderer | null = null;
  private droppedWeaponRenderer: DroppedWeaponRenderer | null = null;
  private bombRenderer: BombRenderer | null = null;
  private bombSiteMarkers: BombSiteMarkers | null = null;
  private readonly bombAudio = new FPSBombAudio();

  // Server-driven projectile tracking (Q3-style)
  /** Maps server projectile entity ID (e.g. 'proj_10001') → weapon defId */
  private serverProjectileDefIds: Map<string, string> = new Map();
  /** Set of server entity IDs that already have client-side visuals spawned */
  private activeServerProjectiles: Set<string> = new Set();
  /** SnapshotBuffer for projectile entity interpolation (Q3-style lerp between snapshots) */
  private projectileBuffer: SnapshotBuffer = new SnapshotBuffer();

  // Weapon state sync
  private _lastServerWeapon: string | undefined = undefined;
  /** Maps remote player entityId → currentWeapon string (for third-person rendering) */
  public readonly enemyWeapons: Map<string, string> = new Map();

  // Remote blade charge glow tracking
  /** Entity IDs currently charging their blade (for third-person glow) */
  private chargingPlayers: Set<string> = new Set();
  /** Active charge glow lights — one per charging entity */
  private chargingGlows: Map<string, PointLight> = new Map();
  /** Whether the local player is currently charging (for skipping slash trail on projectile fire) */
  private _localCharging: boolean = false;

  // Callbacks
  private onStateUpdateCallbacks: ((state: PlayerStateUpdate) => void)[] = [];

  // Death state tracking (for death camera)
  private _isPlayerDead: boolean = false;
  private _respawnRequested: boolean = false;
  private _respawnCooldownEnd: number = 0;

  // Tab-recovery: clamp deltaTime for N frames after tab-return
  private _tabReturnFrameSkips: number = 0;

  // Spectator state
  private playerState: "spectator" | "playing" = "spectator";
  private _joinPending: boolean = false;
  private _joinPendingTimeout: ReturnType<typeof setTimeout> | null = null;
  /** True while `completeJoinGame` is in flight, so it is not started twice. */
  private _joinCompleting = false;
  /** True when the side came from an in-game button rather than the lobby. */
  private _teamWasPicked = false;
  /** Last match phase the announcer spoke for, so each transition fires once. */
  private _lastAnnouncedPhase: import("./client/MatchStateManager").MatchPhase | null = null;
  private spectatorOverlay: import("./client/SpectatorOverlay").SpectatorOverlay | null = null;
  private _joinKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private _specMouseHandler: ((e: MouseEvent) => void) | null = null;
  private _scoreboardKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private _scoreboardKeyUpHandler: ((e: KeyboardEvent) => void) | null = null;
  private _specCycleKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  // Chase-cam spectator (Phase 1)
  private spectatorCycling: import("./../../engine/camera/controllers/SpectatorCycling").SpectatorCycling | null = null;
  private spectatorController:
    | import("./../../engine/camera/controllers/SpectatorController").SpectatorController
    | null = null;
  private _latestGameState: GameState | null = null;

  private pendingTick: number = 0;

  // Cached effect system singletons (lazy-resolved, avoids per-frame import())
  private _gibSystem: any = null;
  private _gibSystemLoading = false; // true while import() is pending
  private _pendingGibSpawns: { x: number; y: number; z: number; vx: number; vy: number; vz: number }[] = [];
  private _damageNumbers: any = null;
  private _damageOverlay: any = null;
  private _ragdollSystem: any = null;
  private _ragdollSystemLoading = false;
  private _cartoonHit: any = null;
  private _cartoonHitLoading = false;
  /** Smoothed corpse-follow death camera. Driven by FPSController each frame. */
  private _deathCamera: DeathCamera = new DeathCamera();
  /** First-person view of a living teammate, while dead in a round mode. */
  private _eyeCamera: SpectateEyeCamera = new SpectateEyeCamera();

  /**
   * Drive the corpse-follow death camera. Called by FPSController at the very end
   * of its update (after all its own camera writes). Returns true when the death
   * camera took over the camera, so the controller skips its fallback roll/drop
   * and the view-bob pass.
   */
  public applyDeathCamera(
    camera: import("./client/DeathCamera").DeathCameraTarget & import("./client/SpectateEyeCamera").SpectateEyeTarget,
    dt: number,
  ): boolean {
    this.updateRoundEndCamera();
    // First person wins whenever we are watching a living teammate. The chase
    // cam is for the ragdoll and the round-end focus; pointing it at a player
    // who walks around puts their own model across the screen.
    if (this._eyeCamera.update(dt, camera)) return true;
    if (this._deathCamera.update(dt, camera)) return true;

    // Nothing has a picture for this frame. In a round mode that must still
    // count as a claim.
    //
    // Returning false is not "no opinion" — the FPS controller reads it as
    // permission to apply its forty-degree death tilt, an effect meant to last
    // the couple of seconds before a deathmatch respawn. A round mode has no
    // respawn: you are dead until the round turns over, which can be ninety
    // seconds of watching the map at forty degrees. Every gap qualifies — a
    // death with no ragdoll to follow, a spectate between snapshots, and a
    // round that ends on the clock rather than on the bomb, where there is no
    // focus point for the intermission camera to move to at all.
    if (this._isPlayerDead && MatchStateManager.getInstance().round > 0) {
      camera.rotation.z = 0;
      return true;
    }

    return false;
  }

  /**
   * Point the camera at what decided the round, for the intermission.
   *
   * Reuses the death camera rather than adding a second one: it already
   * smooths, keeps itself out of walls and follows a moving target, and the job
   * here is the same job — watch a fixed point from a sensible distance while
   * the player has no control. The server sends the focus, so everyone watches
   * the same thing.
   *
   * A player who is dead already has this camera on their corpse. Retargeting
   * it to the bomb is the right call anyway: the corpse is not the story.
   */
  private updateRoundEndCamera(): void {
    const match = MatchStateManager.getInstance();

    // Stamp the moment of death here rather than in the event handler: this
    // runs every frame and only needs the edge, so the death path stays
    // untouched by a camera concern.
    if (this._isPlayerDead !== this._wasDeadLastFrame) {
      this._wasDeadLastFrame = this._isPlayerDead;
      if (this._isPlayerDead) this._deathAtMs = performance.now();
    }

    // The intermission wins: once a round is decided, everyone watches the same
    // thing, whether they were alive for it or not.
    const focus = match.phase === MatchPhase.RoundEnd ? match.roundResult?.focus : undefined;
    if (focus) {
      if (this._roundEndCameraActive) return;
      this._roundEndCameraActive = true;
      this.stopTeammateSpectate();
      const target = new Vector3(focus.x, focus.y, focus.z);
      // Approach from behind wherever the player was looking, so the cut is a
      // pull-back rather than a jump to an unrelated angle.
      const camera = CameraSystem.getInstance().getCamera() as { rotation?: { y: number } } | null;
      this._deathCamera.start(() => target, target, camera?.rotation?.y ?? 0);
      return;
    }

    if (this._roundEndCameraActive) {
      this._roundEndCameraActive = false;
      this.stopTeammateSpectate();
      if (!this._isPlayerDead) this._deathCamera.stop();
    }

    this.updateTeammateSpectate(match);
  }

  /**
   * While dead in a round mode, watch a living teammate.
   *
   * There is no respawn in Search & Destroy, so a dead player would otherwise
   * spend up to ninety seconds staring at their own corpse while the round they
   * still care about happens elsewhere. Only after the death camera has had
   * time to land, though — being yanked off your own death the instant it
   * happens reads as a bug, and the ragdoll is worth a moment.
   *
   * Sticks with one teammate until they die rather than re-picking the nearest
   * every frame, which would cut between players every time two of them crossed.
   */
  private updateTeammateSpectate(match: MatchStateManager): void {
    const spectating = this._isPlayerDead && match.round > 0 && match.phase === MatchPhase.Active;
    if (!spectating) {
      this.stopTeammateSpectate();
      // Release on every frame we are alive and not spectating, NOT only on the
      // frame the target is dropped.
      //
      // Those are not the same moment. Leaving a round drops the target while
      // the player is still dead (the phase leaves Active before the freeze
      // revives them), so the release was gated behind a target that had
      // already been cleared, and the camera stayed bound to whichever bot it
      // was following — through the freeze, through the respawn, and into the
      // next round, with the player alive and unable to see themselves move.
      if (!this._isPlayerDead) this._deathCamera.stop();
      return;
    }

    if (performance.now() - this._deathAtMs < SPECTATE_AFTER_DEATH_MS) return;

    const players = this.remoteRenderer?.getRenderedPlayers();
    if (!players || players.size === 0) return;

    // Still following someone alive? Leave it be.
    if (this._spectatingEntityId) {
      const current = players.get(this._spectatingEntityId);
      if (current && !current.dead) return;
    }

    const myTeam = match.playerTeams?.[clientKeyDisplayId(this.localPlayerId)];
    if (!myTeam) return;

    let chosen: string | null = null;
    for (const [entityId, player] of players) {
      // Your own hitbox is still in the renderer, just hidden — spectating it
      // would put the camera back on the corpse you were meant to leave.
      if (entityId === this.localPlayerId) continue;
      if (player.dead) continue;
      if (match.playerTeams?.[clientKeyDisplayId(entityId)] !== myTeam) continue;
      chosen = entityId;
      break;
    }
    // Everyone on your side is down; the round is about to end anyway, so stay
    // on the corpse rather than cutting to an enemy.
    if (!chosen || chosen === this._spectatingEntityId) return;

    this.watchTeammate(chosen);
  }

  /**
   * Put the camera behind one teammate's eyes.
   *
   * Hiding their model is not cosmetic — the camera sits INSIDE their head, so
   * left visible it is a skull filling the screen from the inside, which is
   * exactly what a first-person view of someone else looks like if you forget
   * this step. The demo viewer has always done it; the live path never did.
   */
  private watchTeammate(entityId: string): boolean {
    // Seeded from where they are right now — the same reading that chose them.
    // Refuse the handoff outright if there is nothing to seed with: a camera
    // that cannot produce a frame is not neutral, because the FPS controller
    // falls back to the forty-degree death tilt when nobody claims the view.
    const seed = this.spectateEyeSample(entityId) ?? this.drawnAt(entityId);
    if (!seed) return false;

    this._spectatingEntityId = entityId;
    this.remoteRenderer?.setHiddenEntity(entityId);
    this._eyeCamera.start(() => this.spectateEyeSample(entityId), seed);
    // Released only now the eye camera is primed and will claim every frame.
    this._deathCamera.stop();
    this.spectatorOverlay?.setSpectatingTarget(this.spectateeName(entityId));
    this.spectatorOverlay?.setMode("first-person");
    console.log(`[Game] Spectating teammate: ${entityId}`);
    return true;
  }

  /**
   * Fallback seed: where the renderer is drawing them, without view angles.
   *
   * Used when the latest snapshot has no entity for someone the renderer is
   * still drawing — a gap of a frame or two around PVS edges. Their facing is
   * unknown, so the camera keeps ours and picks theirs up on the next snapshot
   * rather than snapping to an arbitrary direction.
   */
  private drawnAt(entityId: string): import("./client/SpectateEyeCamera").SpectateEyeSample | null {
    const drawn = this.remoteRenderer?.getRenderedPlayers().get(entityId);
    if (!drawn) return null;
    const camera = CameraSystem.getInstance().getCamera() as { rotation?: { x: number; y: number } } | null;
    return {
      x: drawn.position.x,
      y: drawn.position.y,
      z: drawn.position.z,
      yaw: camera?.rotation?.y ?? 0,
      pitch: camera?.rotation?.x ?? 0,
    };
  }

  /** Drop the teammate view: camera released, and their model visible again. */
  private stopTeammateSpectate(): void {
    if (this._spectatingEntityId === null) return;
    this._spectatingEntityId = null;
    this._specCycleHeld = false;
    this._eyeCamera.stop();
    this.remoteRenderer?.setHiddenEntity(null);
    // The viewmodel came up to show THEIR gun. If we are still dead — the round
    // ended, or everyone on our side is down — it has to go away again, or a
    // borrowed weapon floats over the round-end camera. A respawn re-shows it
    // through the normal path.
    if (this._isPlayerDead) getWeaponViewManager().setVisible(false);
    // Back to whatever the overlay was doing before. A player who is alive
    // again wants no overlay at all; a true spectator gets their own mode set
    // by the chase-cam path.
    if (this.playerState !== "spectator") this.spectatorOverlay?.setMode("hidden");
  }

  /**
   * Where the watched player is and what they are looking at, this frame.
   *
   * Position and angles come from the SAME snapshot deliberately. Taking the
   * position from the renderer's interpolated copy and the angles from the
   * latest packet would put the head a frame ahead of the body — a small lead
   * that reads as the view sliding around independently of the player.
   */
  private spectateEyeSample(entityId: string): import("./client/SpectateEyeCamera").SpectateEyeSample | null {
    const entity = this._latestGameState?.entities.get(entityId);
    if (!entity) return null;
    const transform = entity.getComponent("transform") as
      | { position?: { x: number; y: number; z: number }; rotation?: { x: number; y: number } }
      | undefined;
    if (!transform?.position) return null;
    const movement = entity.getComponent("movementState") as { crouchViewOffset?: number } | undefined;
    return {
      x: transform.position.x,
      y: transform.position.y,
      z: transform.position.z,
      yaw: transform.rotation?.y ?? 0,
      pitch: transform.rotation?.x ?? 0,
      // Same sum the local FPS camera uses, so ducking under a rail looks the
      // same watched as it does played.
      eyeHeight: DEFAULT_VIEWHEIGHT + (movement?.crouchViewOffset ?? 0),
    };
  }

  /** Display name for whoever we are watching, for the HUD banner. */
  private spectateeName(entityId: string): string {
    const players = this._latestGameState?.players;
    if (players) {
      for (const player of players.values()) {
        if (player.entityId === entityId) return player.name || entityId;
      }
    }
    return entityId.replace("player_", "Player ");
  }

  /**
   * Step to the next living teammate while dead.
   *
   * Being pinned to whoever the auto-pick landed on is most of what makes
   * spectating feel broken: the round moves to the other site and you are still
   * watching someone hold an angle at the one you died on.
   */
  /** Step targets in whichever spectator is currently driving the view. */
  cycleSpectate(direction: 1 | -1): void {
    if (this.playerState === "spectator") {
      if (direction === 1) this.nextSpectateTarget();
      else this.prevSpectateTarget();
      return;
    }
    this.cycleTeammateSpectate(direction);
  }

  cycleTeammateSpectate(direction: 1 | -1): void {
    if (!this._spectatingEntityId) return;
    const candidates = this.spectatableTeammates();
    if (candidates.length < 2) return;
    const at = candidates.indexOf(this._spectatingEntityId);
    const next = candidates[(at + direction + candidates.length) % candidates.length];
    if (next && next !== this._spectatingEntityId) this.watchTeammate(next);
  }

  /** Living teammates currently rendered, in a stable order for cycling. */
  private spectatableTeammates(): string[] {
    const players = this.remoteRenderer?.getRenderedPlayers();
    if (!players) return [];
    const match = MatchStateManager.getInstance();
    const myTeam = match.playerTeams?.[clientKeyDisplayId(this.localPlayerId)];
    if (!myTeam) return [];

    const out: string[] = [];
    for (const [entityId, player] of players) {
      if (entityId === this.localPlayerId || player.dead) continue;
      if (match.playerTeams?.[clientKeyDisplayId(entityId)] !== myTeam) continue;
      out.push(entityId);
    }
    // Sorted, so ← and → stay opposites instead of following map insertion.
    return out.sort();
  }

  /** True while the round-end camera owns the view, so we know what to stop. */
  private _roundEndCameraActive = false;
  /** Teammate currently being watched while dead, or null. */
  private _spectatingEntityId: string | null = null;
  /** Fire/alt-fire held last tick, so cycling steps once per press. */
  private _specCycleHeld = false;
  /** Warn once per session if the spectate camera ever runs dry. */

  /**
   * Whose eyes the view is currently behind, or null when it is our own.
   *
   * Read by the event layer to decide who the HUD is describing. A spectated
   * player's health, ammo and weapon all arrive in the same snapshot as ours —
   * the server broadcasts combat_state and weapon_state for every player — so
   * this is a routing question, not a networking one.
   */
  get spectatingEntityId(): string | null {
    return this._spectatingEntityId;
  }
  /** When the local player last died, for the spectate hand-off delay. */
  private _deathAtMs = 0;
  private _wasDeadLastFrame = false;
  private _loadoutPicker: import("./client/hud/widgets/LoadoutPicker").FPSLoadoutPicker | null = null;
  /** Once chosen, the picker does not reappear on every rejoin this session. */
  private _loadoutChosen = false;
  /** Retries spent waiting for the server to name the gametype. */
  private _joinGametypeWaits = 0;
  /** Side selected for this game connection; never leaks into the next one. */
  private _preferredTeam: string | undefined;

  private constructor() {
    // Register as the engine's per-frame game hook so camera controllers can
    // tick the network + render remotes without importing this game (QA-WO7).
    setGameFrameHook(this);

    // Register all FPS actions + contexts with InputSystem
    registerFPSActions();

    // Dropped weapons are independent root meshes. A scene/map teardown can
    // dispose those meshes without clearing the renderer's entity registry,
    // leaving stale IDs that will never be recreated on the next map.
    EventBus.on("map:unloading", () => {
      this.droppedWeaponRenderer?.dispose();
      this.droppedWeaponRenderer = null;
      this.bombRenderer?.dispose();
      this.bombRenderer = null;
      this.bombSiteMarkers?.dispose();
      this.bombSiteMarkers = null;
      resetFPSMovementAudio();
    });

    // Tab-recovery: snap everything to clean state when returning from background
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.onTabReturn();
    });

    // Post-game winner showcase: spawn the winner's model (with weapon) in
    // front of the camera during PostGame; remove it when warmup begins.
    MatchStateManager.getInstance().onPhaseChange((newPhase, oldPhase) => {
      // Endgame music. This phase→music swap previously lived only in
      // NetworkGameHost, so local matches (which don't route through it) went
      // silent at match end — even though the showcase, triggered here
      // host-agnostically, still ran. Fire it here too; loadPlaylist dedupes by
      // name, so a network host also firing it is a harmless no-op.
      const audio = AudioManager.getInstance();
      if (newPhase === MatchPhase.PostGame) {
        void audio.loadPlaylist("data/endgame.playlist.json");
      } else if (oldPhase === MatchPhase.PostGame) {
        void audio.loadPlaylist("data/game.playlist.json");
      }

      import("./client/PostGameShowcase")
        .then(({ startPostGameShowcase, stopPostGameShowcase }) => {
          if (newPhase !== MatchPhase.PostGame) {
            stopPostGameShowcase();
            return;
          }
          const mgr = MatchStateManager.getInstance();
          const winnerPlayerId = mgr.resolveWinnerPlayerId();
          if (!winnerPlayerId) {
            console.log(`[PostGameShowcase] no showcase — winner=${JSON.stringify(mgr.winner)}`);
            return;
          }

          // Snapshot players are keyed "player_<id>" while match-state ids are
          // bare ("3") — normalize before the lookup.
          const winnerKey = ensureClientKey(winnerPlayerId);
          const entityId = this._latestGameState?.players.get(winnerKey)?.entityId ?? null;
          if (!entityId) {
            console.log(
              `[PostGameShowcase] no entity for winner ${winnerKey} (players: ${[...(this._latestGameState?.players.keys() ?? [])].join(", ")})`,
            );
            return;
          }

          // Winner's gun: local player → the view model's weapon; remote →
          // last weapon seen in snapshots. (localPlayerId uses the "player_<id>"
          // form, hence the normalized key.)
          const resolveWeapon = async (): Promise<string | null> => {
            if (winnerKey === this.localPlayerId) {
              const { getWeaponViewManager } = await import("../../engine/weapon/WeaponViewManager");
              return getWeaponViewManager().getDisplayedWeaponId?.() ?? null;
            }
            return this.remoteRenderer?.getKnownWeaponId(entityId) ?? null;
          };
          resolveWeapon()
            .then((weaponId) => startPostGameShowcase(this.remoteRenderer, entityId, weaponId))
            .catch((e) => log.warn("PostGameShowcase", "showcase failed:", e));
        })
        .catch((e) => log.warn("PostGameShowcase", "module load failed:", e));
    });
  }

  static getInstance(): Game {
    if (!Game.instance) {
      Game.instance = new Game();
    }
    return Game.instance;
  }

  /**
   * Tab-recovery: snap to clean state when returning from a background tab.
   * Browsers throttle rAF to ~1fps in hidden tabs, causing massive deltaTime
   * accumulation, stale interpolation buffers, and broken trails.
   */
  private onTabReturn(): void {
    if (!this.isRunning) return;
    console.log("[Game] Tab returned — resetting visual state");

    // 1. Clamp dt for next 3 frames (prevents catch-up stutter)
    this._tabReturnFrameSkips = 3;

    // 2. Clear all projectile visuals (trails, lights, meshes)
    //    Server will re-broadcast any that still exist in next snapshot
    try {
      getProjectileManager().clear();
    } catch {
      /* not initialized */
    }

    // 3. Flush projectile interpolation buffer (discard stale data)
    this.projectileBuffer.flush();

    // 4. Force local player to snap to next server position (no interpolation lag)
    this.v2Client?.forceTeleport();

    // 5. Revalidate textures/materials — GPU may have dropped them while hidden
    //    (async, runs in background — textures pop back in over 1-2 frames)
    this.revalidateAfterTabReturn();
  }

  /**
   * Revalidate GPU resources after tab return.
   * Separated from onTabReturn() because it's async.
   * Also installs renderer-agnostic context loss/restore handlers on first call.
   */
  private _contextLossHandlersInstalled = false;
  private async revalidateAfterTabReturn(): Promise<void> {
    try {
      const { CameraSystem } = await import("../../engine/camera/CameraSystem");
      const scene = CameraSystem.getInstance().getCamera()?.getScene();
      if (!scene) return;

      // Babylon forwards both WebGL context events and WebGPU device loss
      // through these engine observables and performs backend restoration.
      if (!this._contextLossHandlersInstalled) {
        const engine = scene.getEngine();
        engine.onContextLostObservable.add(() => {
          const backend = engine.isWebGPU ? "WebGPU" : "WebGL";
          console.error(`[Game] ${backend} context lost — GPU resources destroyed`);
        });
        engine.onContextRestoredObservable.add(() => {
          const backend = engine.isWebGPU ? "WebGPU" : "WebGL";
          console.log(`[Game] ${backend} context restored — revalidating materials`);
          void this.revalidateAfterTabReturn();
        });
        this._contextLossHandlersInstalled = true;
        console.log("[Game] Renderer context loss/restore handlers installed");
      }

      const { revalidateMaterials } = await import("../../engine/weapon/EffectPreloader");
      await revalidateMaterials(scene);
      console.log("[Game] Material revalidation complete");
    } catch (err) {
      console.warn("[Game] Material revalidation failed:", err);
    }
  }

  /**
   * Initialize local game (single-player mode)
   */
  async initializeLocal(config: FPSGameConfig = {}): Promise<void> {
    // Guard against multiple initializations
    if (this.isRunning) {
      console.warn("[Game] Already initialized, skipping");
      return;
    }

    const tickRate = config.tickRate ?? 20;
    const maxPlayers = config.maxPlayers ?? 16;

    // Create simulation config
    const simConfig = {
      tickRate,
      tickDuration: 1000 / tickRate,
      maxPlayers,
      gameRules: {},
    };

    // Create LocalGameHost with FPSSimulation
    this.gameHost = new LocalGameHost(simConfig, FPSSimulation);

    // Get reference to simulation (for spawn points, collision world, etc.)
    this.simulation = (this.gameHost as LocalGameHost).getSimulation<FPSSimulation>();

    this.localPlayerId = this.gameHost.localPlayerId;
    this.isNetworkMode = false;
    this.serverUrl = null;

    // Subscribe to state updates
    this.gameHost.onStateUpdate((state: GameState) => {
      this.onServerStateUpdate(state);
    });

    // Start the host
    this.gameHost.start?.();
    this.isRunning = true;
    await preloadFPSAudio();
  }

  /**
   * Initialize network game (multiplayer mode)
   * Connects to a dedicated server
   */
  async initializeNetwork(url: string, config: FPSGameConfig = {}): Promise<void> {
    // Guard against multiple initializations - shutdown first if already running
    if (this.isRunning) {
      this.shutdown();
    }

    // Take the lobby handoff, but do NOT consume it here.
    //
    // It used to be read and deleted in one step, which meant any second call —
    // a retry, a reconnect, the overlay connecting again — read nothing and
    // overwrote a perfectly good preference with `undefined`. The side then
    // reached the server as "no preference" and was auto-balanced, which is
    // indistinguishable from never having chosen one.
    //
    // Consumed in `joinGame` once it has actually been sent, which still stops
    // a later direct connect inheriting a side from an old lobby.
    this._preferredTeam = readLobbyTeam() ?? this._preferredTeam;
    console.log(`[Game] Lobby handoff team: ${this._preferredTeam ?? "none"}`);

    const tickRate = config.tickRate ?? 125; // Must match server tick rate (125Hz)
    const maxPlayers = config.maxPlayers ?? 16;

    // Create simulation config for client-side prediction
    const simConfig = {
      tickRate,
      tickDuration: 1000 / tickRate,
      maxPlayers,
      gameRules: {},
    };

    try {
      // Create transport (auto-selects WebTransport or WebSocket)
      const transport = await TransportFactory.create(url);

      // Create network game host with FPSSimulation for client-side prediction
      // Cast needed due to FPSInputCommand vs Command generic variance
      const networkHost = new NetworkGameHost(transport, simConfig, FPSSimulation as any);

      // Guard against duplicate Welcome messages
      let mapLoadStarted = false;

      // Subscribe to server info to load the correct map
      networkHost.onServerInfo(async (serverInfo) => {
        // Prevent duplicate map loading (Welcome can be received multiple times)
        if (mapLoadStarted) {
          return;
        }
        mapLoadStarted = true;

        console.log(`[Game] Server map: ${serverInfo.map}`);

        // Keep the loading screen down until the GAME is ready, not just the
        // map. Everything below — audio decode, collision world, trigger
        // volumes, viewmodel warmup — used to run with the curtain already up,
        // so the player watched the world finish assembling itself.
        //
        // Taken before the load so there is no window where the map can
        // complete first, and released in the `finally` below so a failure
        // cannot leave anyone staring at a loading screen.
        const { MapLoadingOverlay } = await import("../../engine/ui/MapLoadingOverlay");
        MapLoadingOverlay.hold("fps:postload");

        // Load the server's map via console command
        try {
          const { loadClientMap } = await import("../../engine/loader/map/ClientMapLoader");
          const result = await loadClientMap(serverInfo.map);

          // Check if map load failed
          if (typeof result === "string" && result.includes("Failed")) {
            console.error(`[Game] Map load failed, disconnecting...`);
            this.shutdown();
            return;
          }

          // Decode the compact Warsow combat bank while the lobby/map loading
          // flow is still active, so the first accepted shot has no fetch/decode stall.
          await preloadFPSAudio();

          // === CRITICAL: Set up FPS controller AFTER map loads ===
          // This prevents the race condition where scene empty/map command overrides the controller
          try {
            // Set up BSP collision for client prediction
            // This is critical for movement responsiveness (avoids "flying through walls" in prediction)
            const cm = getCollisionManager();
            if (cm.isInitialized()) {
              const collisionWorld = createBSPCollisionWorld();
              if (collisionWorld) {
                this.setCollisionWorld(collisionWorld);

                // Underwater tint/fog for whatever camera is active. Started
                // per map load because the scene is rebuilt each time and the
                // previous view has to be disposed with it, or the next map
                // inherits fog it never asked for.
                import("../../engine/camera/CameraSystem").then(({ CameraSystem: cs }) => {
                  const underwaterScene = cs.getInstance().getCamera()?.getScene();
                  if (underwaterScene) {
                    this.startUnderwaterView(underwaterScene);
                    this.setCollisionWorld(collisionWorld);
                  }
                });
              } else {
                console.warn(`[Game] BSP collision world could not be created - backend not available`);
              }

              // Trigger volumes (teleporters/jumppads) for client prediction —
              // the SAME shared TriggerTable extraction the server runs, so
              // pads and teleporters are predicted with zero reconciliation snap.
              const bsp = cm.getBsp();
              if (bsp && this.v2Client) {
                const { extractTriggerVolumes } = await import("../../shared/bsp/TriggerTable");
                this.v2Client.setTriggerVolumes(extractTriggerVolumes(bsp.entities, bsp.models));

                // Prewarm the generic teleport-ghost pool so the FIRST
                // teleport already has its afterimage.
                import("../../engine/camera/CameraSystem").then(({ CameraSystem: cs }) => {
                  const scene = cs.getInstance().getCamera()?.getScene();
                  if (scene) {
                    import("./client/TeleportEffect").then(({ TeleportEffect }) => {
                      TeleportEffect.getInstance().prewarm(scene);
                    });
                  }
                });

                // Rotate the local camera to the exit yaw when our own
                // prediction teleports (fresh inputs only, not replays), and
                // play the generic VFX: your OWN afterimage at the entry
                // (turn around and you're standing there) + speed-line bursts.
                this.v2Client.onTeleport((exitYaw, from, to, entryYaw) => {
                  import("../../engine/camera/CameraSystem").then(({ CameraSystem: cs }) => {
                    const controller = cs.getInstance().getController("fps");
                    if (controller && "setViewYaw" in controller) {
                      (controller as import("../../engine/camera/controllers/FPSController").FPSController).setViewYaw(
                        exitYaw,
                      );
                    }
                    const scene = cs.getInstance().getCamera()?.getScene();
                    if (scene) {
                      import("./client/TeleportEffect").then(({ TeleportEffect }) => {
                        TeleportEffect.getInstance().localTeleported(scene, from, to, entryYaw, exitYaw);
                      });
                    }
                  });
                });
              }
            } else {
              console.warn(`[Game] CollisionManager NOT initialized - client prediction will NOT have BSP collision!`);
            }

            const { CameraSystem } = await import("../../engine/camera/CameraSystem");
            const { FPSController } = await import("../../engine/camera/controllers/FPSController");
            const { FreeflyController } = await import("../../engine/camera/controllers/FreeflyController");
            const cameraSystem = CameraSystem.getInstance();

            // Register FPS controller (but don't activate — player starts as spectator)
            if (!cameraSystem.getController("fps")) {
              cameraSystem.registerController("fps", new FPSController());
            }

            // Register and activate freefly controller for spectator mode
            if (!cameraSystem.getController("freefly")) {
              cameraSystem.registerController("freefly", new FreeflyController());
            }
            // Start in freefly mode (spectator default)
            cameraSystem.setController("freefly");

            // WATCH mode: start auto-chase polling AFTER map loads
            // (must be here, not earlier — otherwise the freefly reset above overwrites the spectator camera)
            if (config.watchOnly) {
              const autoChaseInterval = setInterval(() => {
                if (this.spectatorCycling && this.spectatorCycling.getAliveCount() > 0) {
                  clearInterval(autoChaseInterval);
                  this.nextSpectateTarget();
                }
              }, 200);
              // Safety: stop polling after 30s
              setTimeout(() => clearInterval(autoChaseInterval), 30000);
            }

            // Auto-join if requested (lobby flow — skip spectator overlay)
            if (config.autoJoin) {
              console.log("[Game] Auto-joining game (lobby flow)");
              // Small delay to ensure everything is settled
              setTimeout(() => this.joinGame(), 200);
            }
          } catch (e) {
            console.warn(`[Game] Could not set up FPS controller after map load:`, e);
          }
        } catch (error) {
          console.error(`[Game] Failed to load map ${serverInfo.map}:`, error);
          console.log(`[Game] Disconnecting due to map load error...`);
          this.shutdown();
        } finally {
          // Whatever happened above, the curtain has to come up.
          MapLoadingOverlay.release("fps:postload");
        }
      });

      // Set up state BEFORE connect so the onServerInfo callback can use them
      this.gameHost = networkHost;
      this.isNetworkMode = true;
      this.serverUrl = url;
      this.isRunning = true;

      // Create V2NetworkClient BEFORE connecting, so it exists when onServerInfo callback
      // sets up collision world. This fixes the race condition where setCollisionWorld()
      // was called while v2Client was null.
      this.v2Client = new V2NetworkClient({ tickRate });

      // Tell NetworkGameHost to skip its prediction - V2NetworkClient handles it
      networkHost.setExternalPrediction(true);

      // Subscribe to state updates BEFORE connect so we don't miss snapshots
      // during the handshake. onServerStateUpdate() will use this.localPlayerId,
      // which gets updated to the server-assigned ID after connect resolves.
      this.gameHost.onStateUpdate((state: GameState) => {
        this.onServerStateUpdate(state);
      });

      // Listen for server messages (queue notifications, join rejections)
      networkHost.onServerMessage((msg) => {
        console.log(`[Game] Server message [${msg.type}]: ${msg.message}`);
        // If server rejected our join, clear pending state
        if (msg.type === "queue" || msg.type === "error") {
          this._joinPending = false;
          if (this._joinPendingTimeout) {
            clearTimeout(this._joinPendingTimeout);
            this._joinPendingTimeout = null;
          }
        }
      });

      // Load player profile and connect with display name
      const profile = PlayerProfile.load();
      console.log(`[Game] Connecting as "${profile.name}" (id: ${profile.id.substring(0, 8)}...)`);

      // Connect to server (this triggers onServerInfo callback which loads map and sets collision)
      await networkHost.connect(url, profile.name);

      // Update player ID after connect (server assigns it during handshake)
      this.localPlayerId = networkHost.localPlayerId;
      this.simulation = null; // No direct simulation access in network mode

      // Initialize FPSHud (Washiki HUD system)
      const fpsHud = FPSHud.getInstance();
      await fpsHud.init();
      fpsHud.start();

      // Initialize the dynamic canvas crosshair (spread + ADS-converge + hit flash).
      // Driven per-frame from renderRemotePlayers(); update() handles its own visibility.
      import("./client/Crosshair").then((m) => m.Crosshair.getInstance().init());

      // Initialize NetGraph overlay (cl_netgraph CVar)
      NetGraph.init();

      // ── Spectator Mode: show join overlay on connect ──────────
      this.playerState = "spectator";

      // The overlay is built either way. Auto-joining only means it starts
      // hidden: a player who came straight from the lobby still dies, and still
      // needs the "watching X" banner when the camera moves to a teammate.
      const { SpectatorOverlay } = await import("./client/SpectatorOverlay");
      this.spectatorOverlay = new SpectatorOverlay();
      this.spectatorOverlay.setMode("hidden");

      // The bar's ◄ ► buttons are wired unconditionally, and route to whichever
      // spectator is actually running: the chase-cam when watching as a true
      // spectator, the teammate view when watching because you are dead. They
      // used to live inside the branch below, so for anyone who came from the
      // lobby they were buttons that did nothing.
      this.spectatorOverlay.onNextPlayer(() => this.cycleSpectate(1));
      this.spectatorOverlay.onPrevPlayer(() => this.cycleSpectate(-1));

      if (!config.autoJoin) {
        if (config.watchOnly) {
          // WATCH mode: pure spectator, start in freefly until chase-cam target available
          this.spectatorOverlay.setMode("freefly");
        } else {
          // Normal connect: show join/spectate choice
          this.spectatorOverlay.setMode("join-overlay");
        }

        this.spectatorOverlay.onJoinGame((teamId) => {
          this.joinGame(teamId);
        });
        this.spectatorOverlay.onSpectate(() => {
          // Switch to freefly spectator (no entity, just camera)
          this.spectatorOverlay?.setMode("freefly");
          this.switchToFreeflyCamera();
        });
      } // end if (!config.autoJoin)

      // ── Initialize SpectatorCycling and SpectatorController ──
      const { SpectatorCycling } = await import("../../engine/camera/controllers/SpectatorCycling");
      const { SpectatorController } = await import("../../engine/camera/controllers/SpectatorController");
      this.spectatorCycling = new SpectatorCycling();
      this.spectatorController = new SpectatorController();

      // Register the spectator camera controller
      const camSys = CameraSystem.getInstance();
      camSys.registerController("spectator", this.spectatorController);

      // Set up target provider — reads entity position/rotation from latest GameState
      this.spectatorController.setTargetProvider((entityId: string) => {
        const state = this._latestGameState;
        if (!state) return null;
        const entity = state.entities.get(entityId);
        if (!entity) return null;
        const transform = entity.getComponent("transform") as
          | { position?: { x: number; y: number; z: number }; rotation?: { x: number; y: number; z: number } }
          | undefined;
        if (!transform?.position) return null;
        return {
          x: transform.position.x,
          y: transform.position.y,
          z: transform.position.z,
          yaw: transform.rotation?.y ?? 0,
          pitch: transform.rotation?.x ?? 0,
        };
      });

      // ── Spectator cycling keyboard handler (arrows + Space) ──
      this._specCycleKeyHandler = (e: KeyboardEvent) => {
        // Dead in a round mode is spectating too, even though the player state
        // still says "playing" — they have an entity, it is just a corpse.
        // Without this the arrows did nothing for the one case that lasts a
        // whole minute, and you watched whoever the auto-pick happened to land
        // on until they died.
        if (this.playerState !== "spectator") {
          if (!this._spectatingEntityId) return;
          if (e.code === "ArrowRight") {
            e.preventDefault();
            this.cycleTeammateSpectate(1);
          } else if (e.code === "ArrowLeft") {
            e.preventDefault();
            this.cycleTeammateSpectate(-1);
          }
          return;
        }
        if (e.code === "ArrowRight") {
          e.preventDefault();
          this.nextSpectateTarget();
        } else if (e.code === "ArrowLeft") {
          e.preventDefault();
          this.prevSpectateTarget();
        } else if (e.code === "Space" || e.code === "Backspace") {
          // Return to freefly from chase-cam
          if (this.spectatorCycling?.getTargetEntityId()) {
            e.preventDefault();
            this.exitChaseCam();
          }
        }
      };
      document.addEventListener("keydown", this._specCycleKeyHandler);

      // ── Mouse1 (left click) handler: chase-cam ──
      // Matches the freefly cue label ("MOUSE1 Chase Player"). Enter chase from
      // freefly, or advance to the next player while already chasing; ←/→ cycle
      // and Space/Backspace returns to freefly. Ignored until the pointer is
      // locked so the click that engages mouselook doesn't jump straight into a
      // chase. Middle-click is reserved for "fly down" (crouch), so it is NOT a
      // chase alias here.
      this._specMouseHandler = (e: MouseEvent) => {
        if (this.playerState !== "spectator") return;
        if (e.button !== 0) return;
        // Only once the pointer is locked (freefly mouselook active).
        if (!document.pointerLockElement) return;
        e.preventDefault();
        this.nextSpectateTarget();
      };
      document.addEventListener("mousedown", this._specMouseHandler);

      // ── J key shortcut to join game from spectator mode ──
      // Uses InputSystem's raw key state (this runs in an event handler, not per-frame)
      this._joinKeyHandler = (_e: KeyboardEvent) => {
        const input = InputSystem.getInstance();
        if (input.isKeyDown("KeyJ") && this.playerState === "spectator") {
          this.joinGame();
        }
      };
      document.addEventListener("keydown", this._joinKeyHandler);

      // ── Tab key: hold-to-show scoreboard (Quake style) ──
      this._scoreboardKeyHandler = (e: KeyboardEvent) => {
        if (e.code === "Tab") {
          e.preventDefault();
          const hud = FPSHud.getInstance();
          hud.scoreboard?.show();
        }
      };
      this._scoreboardKeyUpHandler = (e: KeyboardEvent) => {
        if (e.code === "Tab") {
          e.preventDefault();
          const hud = FPSHud.getInstance();
          hud.scoreboard?.hide();
        }
      };
      document.addEventListener("keydown", this._scoreboardKeyHandler);
      document.addEventListener("keyup", this._scoreboardKeyUpHandler);
    } catch (error) {
      console.error(`[Game] Failed to connect to ${url}:`, error);
      throw error;
    }
  }

  /**
   * Check if running in network mode
   */
  isConnectedToServer(): boolean {
    return this.isNetworkMode && this.isRunning;
  }

  /**
   * Check if local player is currently dead (for death camera)
   */
  isPlayerDead(): boolean {
    return this._isPlayerDead;
  }

  /**
   * Get current weapon ID (for crosshair lookup)
   */
  getCurrentWeaponId(): string {
    return this._lastServerWeapon || "blade";
  }

  /**
   * Get current server URL (if connected)
   */
  getServerUrl(): string | null {
    return this.serverUrl;
  }

  /**
   * Check if currently spectating
   */
  isSpectating(): boolean {
    return this.playerState === "spectator";
  }

  /**
   * Get current player state
   */
  getPlayerState(): "spectator" | "playing" {
    return this.playerState;
  }

  // ========================================================================
  // Spectator Mode
  // ========================================================================

  /**
   * joinGame — request to transition from spectator to playing.
   * Sends JoinGame to server. Actual transition happens server-confirmed
   * when our entity appears in the snapshot (see completeJoinGame).
   */
  /**
   * Ask for a loadout before joining, in modes that have one.
   *
   * Blocking on purpose. In Search & Destroy the kit decides what you can do
   * for a whole round with no respawn to correct it, so being dropped in
   * holding a default nobody chose is worse than a moment spent choosing. The
   * picker only appears where it means something: the server's gametype name
   * identifies S&D even during warmup, when the objective intentionally is not
   * published yet. Duel and FFA still join straight through.
   */
  async joinGame(teamId?: string): Promise<void> {
    // Explicit UI selection wins over the lobby handoff and is remembered for
    // keyboard rejoins on this connection. It is also flagged as a PICK: the
    // server balances a side a player chose in-game, and delivers a side the
    // lobby assigned untouched.
    if (teamId) {
      this._preferredTeam = teamId;
      this._teamWasPicked = true;
    }

    // Do not decide anything before the server has said what mode this is.
    //
    // The lobby's auto-join fires 200 ms after the map loads, which can beat
    // the first snapshot — and a joinGame that runs before `match_state`
    // arrives sees no objective, skips the picker, and drops the player into a
    // Search & Destroy round holding a kit they never chose, for the whole
    // round, with no respawn to correct it.
    const match = MatchStateManager.getInstance();
    if (this.isNetworkMode && !match.gametypeName && this._joinGametypeWaits < MAX_JOIN_GAMETYPE_WAITS) {
      this._joinGametypeWaits++;
      setTimeout(() => void this.joinGame(), JOIN_GAMETYPE_WAIT_MS);
      return;
    }

    const needsLoadout = match.requiresLoadoutSelection && !this._loadoutChosen;
    if (needsLoadout && this.playerState !== "playing" && !this._joinPending) {
      const { FPSLoadoutPicker } = await import("./client/hud/widgets/LoadoutPicker");
      this._loadoutPicker ??= new FPSLoadoutPicker();
      if (this._loadoutPicker.isOpen) return;

      // Released so the player can actually click; completeJoinGame takes it
      // back when the round starts.
      document.exitPointerLock?.();
      this._loadoutPicker.open((choice) => {
        this._loadoutChosen = true;
        this.sendLoadout(choice.primary, choice.secondary);
        void this.joinGame();
      });
      return;
    }

    if (this.playerState === "playing") {
      console.log("[Game] joinGame() — already playing, skipping");
      return;
    }
    if (this._joinPending) {
      console.log("[Game] joinGame() — join already pending, skipping");
      return;
    }
    if (!this.gameHost || !this.isNetworkMode) {
      console.log("[Game] joinGame() — no gameHost or not network mode");
      return;
    }
    console.log("[Game] joinGame() — sending join request to server");

    const networkHost = this.gameHost as import("../../engine/network/client/hosts/NetworkGameHost").NetworkGameHost;

    // Tell server we want to join — server decides if we can
    // Ask for the side chosen in the lobby. The server normalizes alpha/bravo
    // to its own team ids and falls back to balancing if this is absent.
    console.log(
      `[Game] joinGame() — requesting team: ${this._preferredTeam ?? "auto-balance"}${this._teamWasPicked ? " (picked in-game)" : " (from lobby)"}`,
    );
    networkHost.sendJoinGame(this._preferredTeam, this._teamWasPicked);
    // Used, so the handoff is spent — a later direct connect in this tab must
    // not inherit it. The in-memory preference survives for keyboard rejoins.
    try {
      sessionStorage.removeItem("shag.lobby_team");
    } catch {
      // Storage is optional; the in-memory preference still works.
    }
    this._joinPending = true;

    // Timeout: revert if server doesn't respond within 5 seconds
    this._joinPendingTimeout = setTimeout(() => {
      if (this._joinPending) {
        console.log("[Game] joinGame() — timed out waiting for server confirmation");
        this._joinPending = false;
      }
    }, 5000);
  }

  /**
   * completeJoinGame — called when server confirmed our join
   * (our entity appeared in snapshot). Switches camera and state.
   */
  private async completeJoinGame(): Promise<void> {
    this._joinPending = false;
    if (this._joinPendingTimeout) {
      clearTimeout(this._joinPendingTimeout);
      this._joinPendingTimeout = null;
    }

    console.log("[Game] completeJoinGame() — server confirmed, transitioning to playing");

    // Clear any active chase-cam state before switching
    this.spectatorCycling?.clearTarget();
    this.spectatorController?.clearSpectateTarget();
    // Whoever we were watching must be drawn again now we are playing, or they
    // stay invisible for the rest of the match to the one person who spectated
    // them.
    this.remoteRenderer?.setHiddenEntity(null);

    // Switch to FPS camera controller
    try {
      const { CameraSystem } = await import("../../engine/camera/CameraSystem");
      const { FPSController } = await import("../../engine/camera/controllers/FPSController");
      const cameraSystem = CameraSystem.getInstance();

      if (!cameraSystem.getController("fps")) {
        cameraSystem.registerController("fps", new FPSController());
      }
      cameraSystem.setController("fps");

      // Enable network mode on FPS controller
      const controller = cameraSystem.getActiveController();
      if (controller && controller.type === "fps" && typeof (controller as any).enableNetworkMode === "function") {
        (controller as any).enableNetworkMode();
      }
    } catch (e) {
      console.warn("[Game] Could not switch to FPS camera:", e);
    }

    // Update state
    this.playerState = "playing";
    this.spectatorOverlay?.setMode("hidden");

    // Initialize weapon view manager with the now-active FPS camera
    try {
      const { CameraSystem } = await import("../../engine/camera/CameraSystem");
      const { getWeaponViewManager } = await import("../../engine/weapon/WeaponViewManager");
      const { getProjectileManager } = await import("../../engine/weapon/ProjectileManager");
      const { initializeEntityDefs } = await import("../../shared/entities");
      const { FreeCamera } = await import("@babylonjs/core/Cameras/freeCamera");

      const camera = CameraSystem.getInstance().getCamera();
      const scene = camera?.getScene();

      if (scene && camera instanceof FreeCamera) {
        initializeEntityDefs();
        const wvm = getWeaponViewManager();
        wvm.init(scene, camera);
        console.log("[Game] completeJoinGame() — WVM initialized");
        wvm.loadWeapon(this._lastServerWeapon || "blade").then((success) => {
          console.log(`[Game] completeJoinGame() — initial weapon loadWeapon result: ${success}`);
        });

        // Preload projectile models (independent of weapon load)
        const projMgr = getProjectileManager();
        Promise.all([
          projMgr.preloadModel("plasma_bolt"),
          projMgr.preloadModel("grenade"),
          projMgr.preloadModel("rocket"),
          projMgr.preloadModel("blade_blast"),
        ]).catch((err) => console.warn("[Game] Projectile preload error:", err));
      }
    } catch (e) {
      console.warn("[Game] Failed to init weapon view:", e);
    }

    // Request pointer lock for FPS controls
    const canvas = document.querySelector("canvas");
    if (canvas) {
      canvas.requestPointerLock();
    }

    console.log("[Game] Joined game (server-confirmed)");
  }

  /**
   * Send an in-game chat message (server sanitizes/rate-limits and
   * rebroadcasts as a `chat` snapshot event). Called by the HUD chat widget.
   */
  sendChat(text: string): void {
    if (!this.gameHost || !this.isNetworkMode) {
      console.warn(`[Chat] send dropped — gameHost=${!!this.gameHost} networkMode=${this.isNetworkMode}`);
      return;
    }
    console.log(`[Chat] send → server: "${text}"`);
    const networkHost = this.gameHost as import("../../engine/network/client/hosts/NetworkGameHost").NetworkGameHost;
    networkHost.sendChat(text);
  }

  /**
   * Choose the spawn kit for modes that have one (S&D).
   *
   * Returns false when there is no server to tell. The choice is the server's
   * to apply — it lands at the start of the next round, never this one.
   */
  sendLoadout(primary: string, secondary: string): boolean {
    if (!this.gameHost || !this.isNetworkMode) return false;
    const networkHost = this.gameHost as import("../../engine/network/client/hosts/NetworkGameHost").NetworkGameHost;
    networkHost.sendLoadout(primary, secondary);
    return true;
  }

  /**
   * goSpectator — transition from playing to spectator.
   * Sends Spectate to server, switches camera to freefly, shows overlay.
   */
  async goSpectator(): Promise<void> {
    if (this.playerState === "spectator") return;
    if (!this.gameHost || !this.isNetworkMode) return;

    const networkHost = this.gameHost as import("../../engine/network/client/hosts/NetworkGameHost").NetworkGameHost;

    // Tell server to remove our entity
    networkHost.sendSpectate();

    // Switch to freefly camera
    this.switchToFreeflyCamera();

    // Update state
    this.playerState = "spectator";
    this.spectatorOverlay?.setMode("freefly");

    // Hide weapon view model
    import("../../engine/weapon/WeaponViewManager").then((m) => {
      m.getWeaponViewManager().setVisible(false);
    });

    // Hide speedometer (prevent overlap with spectator overlay)
    const speedEl = document.getElementById("fps-speed-display");
    if (speedEl) speedEl.remove();
    // Reset static refs so a fresh widget is created on rejoin
    (await import("../../engine/camera/controllers/FPSController")).FPSController.resetSpeedDisplay?.();

    // Release pointer lock
    document.exitPointerLock();

    console.log("[Game] Now spectating");
  }

  /**
   * Chase-cam: start following a specific player entity.
   */
  spectatePlayer(entityId: string): void {
    if (!this.spectatorController || !this.spectatorCycling) return;
    this.spectatorCycling.setTarget(entityId);
    this.spectatorController.setSpectateTarget(entityId);
    // The camera goes to their eyes, which is INSIDE their head — leaving the
    // model on fills the screen with the inside of a skull. The demo viewer has
    // hidden the followed player since it shipped; this path never did, which
    // is why live chase-cam looked like a rendering fault rather than a view.
    this.remoteRenderer?.setHiddenEntity(entityId);
    this.spectatorOverlay?.setMode("first-person");
    this.spectatorOverlay?.setSpectatingTarget(this.spectatorCycling.getPlayerName(entityId));
    CameraSystem.getInstance().setController("spectator");
    console.log(`[Game] Now spectating player: ${entityId}`);
  }

  /**
   * Chase-cam: cycle to next alive player.
   */
  nextSpectateTarget(): void {
    if (!this.spectatorCycling) return;
    const next = this.spectatorCycling.next();
    if (next) {
      this.spectatePlayer(next);
    }
  }

  /**
   * Chase-cam: cycle to previous alive player.
   */
  prevSpectateTarget(): void {
    if (!this.spectatorCycling) return;
    const prev = this.spectatorCycling.prev();
    if (prev) {
      this.spectatePlayer(prev);
    }
  }

  /**
   * Exit chase-cam: return to freefly spectator mode.
   */
  exitChaseCam(): void {
    this.spectatorCycling?.clearTarget();
    this.spectatorController?.clearSpectateTarget();
    // Whoever we were riding becomes a normal player again.
    this.remoteRenderer?.setHiddenEntity(null);
    this.spectatorOverlay?.setMode("freefly");
    this.switchToFreeflyCamera();
    console.log("[Game] Returned to freefly spectator");
  }

  /**
   * Switch the active camera to freefly controller (for spectator mode).
   */
  private async switchToFreeflyCamera(): Promise<void> {
    try {
      const { CameraSystem } = await import("../../engine/camera/CameraSystem");
      const { FreeflyController } = await import("../../engine/camera/controllers/FreeflyController");
      const cameraSystem = CameraSystem.getInstance();

      if (!cameraSystem.getController("freefly")) {
        cameraSystem.registerController("freefly", new FreeflyController());
      }
      cameraSystem.setController("freefly");

      console.log("[Game] Switched to freefly camera");
    } catch (e) {
      console.warn("[Game] Could not switch to freefly camera:", e);
    }
  }

  /**
   * Spawn local player in simulation
   * @param spawnPosition Optional spawn position (uses random spawn point if not provided)
   */
  spawnLocalPlayer(spawnPosition?: { x: number; y: number; z: number }): void {
    if (!this.simulation) {
      console.error("[Game] Cannot spawn - not initialized");
      return;
    }

    // Spawn player in simulation
    const entity = this.simulation.spawnPlayer(this.localPlayerId);

    // Override spawn position if provided
    if (spawnPosition) {
      const transform = entity.getComponent<TransformComponent>("transform");
      if (transform) {
        transform.position = { ...spawnPosition };
      }
    }
  }

  /**
   * Send player input to simulation
   * Call this each frame from FPSController
   */
  sendInput(input: PlayerInputState): void {
    if (!this.gameHost || !this.isRunning) {
      return;
    }

    // Spectators don't send input at all
    if (this.playerState === "spectator") {
      return;
    }

    // Whenever the server is holding everyone still — the round freeze, the
    // round-end result, the post-game screen — strip the same input locally so
    // prediction agrees with it. Look-around stays free, which is what the
    // freeze is for.
    //
    // The client predicts its own movement, so a freeze it does not know about
    // is one it walks straight through: you drift a step, the next snapshot
    // puts you back on your spawn, and the speed effects fire on the way. Only
    // the post-game case was mirrored here; the round freeze at the top of
    // every single round was not.
    if (MatchStateManager.getInstance().isMovementFrozen()) {
      input.forward = false;
      input.backward = false;
      input.left = false;
      input.right = false;
      input.jump = false;
      input.crouch = false;
      input.sprint = false;
      input.fire = false;
      input.altFire = false;
      input.reload = false;
      input.use = false;
      input.weaponSlot = 0; // no weapon switching either
    }

    // While dead, check for respawn input and strip ALL gameplay input.
    // Respawn is triggered via a dedicated RequestSpawn reliable message.
    if (this._isPlayerDead) {
      if (this._spectatingEntityId) {
        // While chasing someone, +attack steps to the next player instead of
        // asking to respawn. In a round mode there is nothing to respawn into
        // until the freeze, so the button is free — and it is the one every
        // player already reaches for.
        //
        // Edge-triggered against the previous tick: input runs at 125Hz, so a
        // held button would otherwise strobe through the whole team.
        const cycleNext = input.fire;
        const cyclePrev = input.altFire;
        if (cycleNext && !this._specCycleHeld) this.cycleTeammateSpectate(1);
        else if (cyclePrev && !this._specCycleHeld) this.cycleTeammateSpectate(-1);
        this._specCycleHeld = cycleNext || cyclePrev;
      } else if (!this._respawnRequested && Date.now() >= this._respawnCooldownEnd) {
        // Send RequestSpawn if cooldown expired and fire/jump pressed
        if (input.fire || input.jump) {
          this.sendRequestSpawn();
          this._respawnRequested = true;
        }
      }

      // Strip ALL input — no corpse movement, no fire processing
      input.forward = false;
      input.backward = false;
      input.left = false;
      input.right = false;
      input.jump = false;
      input.crouch = false;
      input.sprint = false;
      input.fire = false;
      input.altFire = false;
      input.reload = false;
    }

    // Convert input state to button flags
    let buttons = 0;
    if (input.forward) buttons |= InputButtons.FORWARD;
    if (input.backward) buttons |= InputButtons.BACK;
    if (input.left) buttons |= InputButtons.LEFT;
    if (input.right) buttons |= InputButtons.RIGHT;
    if (input.jump) buttons |= InputButtons.JUMP;
    if (input.crouch) buttons |= InputButtons.CROUCH;
    if (input.sprint) buttons |= InputButtons.SPRINT;
    if (input.fire) buttons |= InputButtons.FIRE;
    if (input.altFire) buttons |= InputButtons.ALT_FIRE;
    if (input.reload) buttons |= InputButtons.RELOAD;
    if (input.use) buttons |= InputButtons.USE;

    // Build world-space direction from buttons using Babylon.js LEFT-HANDED coordinate system
    // In left-handed Y rotation: forward = (sin(yaw), 0, cos(yaw)), right = (cos(yaw), 0, -sin(yaw))
    // This matches what camera.getDirection(Forward/Right) returns in the local code.
    const cosYaw = Math.cos(input.yaw);
    const sinYaw = Math.sin(input.yaw);

    // Forward direction in Babylon left-handed
    const forwardX = sinYaw;
    const forwardZ = cosYaw;
    // Right direction in Babylon left-handed (90° clockwise from forward)
    const rightX = cosYaw;
    const rightZ = -sinYaw;

    // Build world direction from local input
    let dirX = 0;
    let dirZ = 0;
    if (input.forward) {
      dirX += forwardX;
      dirZ += forwardZ;
    }
    if (input.backward) {
      dirX -= forwardX;
      dirZ -= forwardZ;
    }
    if (input.left) {
      dirX -= rightX;
      dirZ -= rightZ;
    }
    if (input.right) {
      dirX += rightX;
      dirZ += rightZ;
    }

    // Normalize the final direction
    const dirLen = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (dirLen > 0) {
      dirX /= dirLen;
      dirZ /= dirLen;
    }

    // Create input command
    const cmd: FPSInputCommand = {
      type: "fps_input",
      playerId: this.localPlayerId,
      tick: this.gameHost.currentTick,
      seq: this.commandSeq++,
      direction: { x: dirX, y: 0, z: dirZ },
      pitch: input.pitch,
      yaw: input.yaw,
      buttons,
      weaponSlot: input.weaponSlot || 0,
      serialize: () => new Uint8Array(), // TODO: Implement for network
    };

    // === V2 CLIENT: Process input for instant local prediction ===
    if (this.v2Client && this.isNetworkMode) {
      this.v2Client.processInput({
        direction: { x: dirX, y: 0, z: dirZ },
        pitch: input.pitch,
        yaw: input.yaw,
        buttons,
        clientTick: this.gameHost.currentTick,
      });
    }

    // Send to host (runs simulation tick)
    this.gameHost.sendCommand(cmd);
    NetGraph.recordCommandSent();
  }

  /**
   * Subscribe to player state updates
   * Returns unsubscribe function
   */
  onPlayerStateUpdate(callback: (state: PlayerStateUpdate) => void): () => void {
    this.onStateUpdateCallbacks.push(callback);
    return () => {
      const index = this.onStateUpdateCallbacks.indexOf(callback);
      if (index >= 0) {
        this.onStateUpdateCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Process buffered server snapshots (called from frame loop BEFORE input processing)
   *
   * This ensures reconciliation happens at a deterministic point in the frame,
   * preventing mid-frame camera position discontinuities that cause jitter.
   */
  processSnapshots(): void {
    if (!this.v2Client || !this.isNetworkMode) return;

    // Process buffered snapshots in V2NetworkClient
    const processed = this.v2Client.processBufferedSnapshots();
    if (!processed) return;

    // Fire callbacks with reconciled state
    const v2State = this.v2Client.getState();
    // Use client-predicted movement state for visual effects (crouchslide, walljump, etc.)
    // These come from the local FPSMovementProfile.simulate() - same code as server,
    // zero bandwidth cost, zero latency for visual feedback.
    const ms = this.v2Client.getMovementState();
    const update: PlayerStateUpdate = {
      position: v2State.position,
      velocity: v2State.velocity,
      grounded: v2State.grounded,
      tick: this.pendingTick,
      isSliding: ms.isSliding,
      isCrouching: ms.isCrouching,
      crouchViewOffset: ms.crouchViewOffset,
      wallJumpState: ms.wallJumpState as any,
      ledgeGrabState: ms.ledgeGrabState as any,
      actualHorizSpeed: ms.actualHorizSpeed,
      slidePhase: ms.slidePhase,
      ledgeGrabPhase: ms.ledgeGrabPhase,
    };

    for (const callback of this.onStateUpdateCallbacks) {
      callback(update);
    }
  }

  /**
   * Render remote player models using interpolated positions from the snapshot buffer.
   * Call once per frame AFTER processSnapshots() for smooth remote player movement.
   */
  renderRemotePlayers(): void {
    if (this.remoteRenderer) {
      this.remoteRenderer.render();
    }

    // Your own splash, from prediction rather than from a snapshot. The remote
    // path in RemotePlayerRenderer covers everyone else; the local player is
    // predicted, so taking their level from the wire would land their own
    // splash a round trip after they felt the water.
    this.emitLocalLiquidCrossing();

    // Render server-driven projectiles with interpolated positions (Q3-style)
    this.renderServerProjectiles();

    // Update particle/effect systems that need per-frame ticking
    let dtSec = (EngineStore.LastCreatedEngine?.getDeltaTime() ?? 16) / 1000;
    // Tab-recovery: clamp dt to prevent catch-up stutter
    if (this._tabReturnFrameSkips > 0) {
      dtSec = 0.016;
      this._tabReturnFrameSkips--;
    }

    // Update gib physics (gravity, bouncing, tumble, fade)
    if (!this._gibSystem && !this._gibSystemLoading) {
      // Eagerly init on first frame so it's ready for death events
      this._gibSystemLoading = true;
      import("./client/GibSystem")
        .then((m) => {
          const gibs = m.GibSystem.getInstance();
          const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
          if (gameScene) {
            gibs.init(gameScene); // init() handles scene changes gracefully
          }
          if (gibs["scene"]) {
            this._gibSystem = gibs;
            console.log(`[GibSystem] Initialized, flushing ${this._pendingGibSpawns.length} pending spawns`);
            // Flush any gib spawns that queued while loading
            for (const pending of this._pendingGibSpawns) {
              gibs.spawn(pending.x, pending.y, pending.z, pending.vx, pending.vy, pending.vz);
            }
            this._pendingGibSpawns = [];
          } else {
            // Scene not ready yet — allow retry on next frame
            console.log(`[GibSystem] Scene not ready, will retry next frame`);
            this._gibSystemLoading = false;
          }
        })
        .catch((e) => {
          console.error("[GibSystem] Failed to load GibSystem module:", e);
          this._gibSystemLoading = false;
        });
    } else if (this._gibSystem) {
      this._gibSystem.update(dtSec);
    }

    // The S&D bomb. Lazily built once there is a scene, and a no-op in every
    // other mode — it hides itself when the objective snapshot has no bomb.
    if (!this.bombRenderer) {
      const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
      if (gameScene) this.bombRenderer = new BombRenderer(gameScene, () => this.remoteRenderer);
    }
    this.bombRenderer?.update(dtSec);
    if (!this.bombSiteMarkers) {
      const markerScene = CameraSystem.getInstance().getCamera()?.getScene();
      if (markerScene) this.bombSiteMarkers = new BombSiteMarkers(markerScene);
    }
    this.bombSiteMarkers?.update(dtSec);

    // Beep and announcer, driven by the same objective snapshot and the same
    // server-computed interval as the blinking light, so they stay one signal.
    const match = MatchStateManager.getInstance();
    // playerTeams is keyed by the raw display id, not the "player_N" client key.
    const localTeam = match.playerTeams?.[clientKeyDisplayId(this.localPlayerId)] ?? undefined;
    const attacking = match.isAttacking(localTeam);
    this.bombAudio.update(match.bomb, dtSec, attacking);

    // Round transitions are MATCH phases, not bomb phases — nothing about the
    // bomb changes when a freeze begins, so the announcer needs telling here.
    // Edge-detected in the same place the side is resolved, because the line is
    // side-specific and reading the two apart risks announcing the wrong job.
    if (match.phase !== this._lastAnnouncedPhase) {
      this.bombAudio.onMatchPhase(match.phase, this._lastAnnouncedPhase, attacking);
      this._lastAnnouncedPhase = match.phase;
    }
    // The spoken 3-2-1 and the last call, both of which need the match clock
    // rather than the bomb's.
    this.bombAudio.updateRound(match.phase, match.timeRemaining, match.bomb, attacking);

    // Update ragdoll physics (Havok-driven skeleton ragdolls)
    if (!this._ragdollSystem && !this._ragdollSystemLoading) {
      this._ragdollSystemLoading = true;
      import("./client/RagdollSystem")
        .then((m) => {
          const ragdolls = m.RagdollSystem.getInstance();
          const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
          if (gameScene) {
            ragdolls.init(gameScene);
            // Wire gib explosion callback (Warsow-style ragdoll cleanup)
            if (this._gibSystem) {
              ragdolls.setGibCallback((x: number, y: number, z: number, vx: number, vy: number, vz: number) => {
                this._gibSystem?.spawn(x, y, z, vx, vy, vz);
              });
            }
            this._ragdollSystem = ragdolls;
            console.log("[RagdollSystem] Initialized");
          } else {
            console.log("[RagdollSystem] Scene not ready, will retry");
            this._ragdollSystemLoading = false;
          }
        })
        .catch((e) => {
          console.error("[RagdollSystem] Failed to load:", e);
          this._ragdollSystemLoading = false;
        });
    } else if (this._ragdollSystem) {
      this._ragdollSystem.update(dtSec);
    }

    // Update floating damage numbers (float upward, fade out)
    if (this._damageNumbers) {
      this._damageNumbers.update(dtSec);
    } else {
      import("./client/DamageNumbers").then((m) => {
        const dn = m.DamageNumbers.getInstance();
        if (dn["scene"]) this._damageNumbers = dn;
      });
    }

    // Update damage overlay (directional red triangles + vignette)
    if (this._damageOverlay) {
      this._damageOverlay.update(dtSec);
    } else {
      import("../../engine/ui/hud/DamageOverlay").then((m) => {
        this._damageOverlay = m.DamageOverlay.getInstance();
      });
    }

    // Update cartoon hit effects (Warsow-style POW! sprites)
    if (!this._cartoonHit && !this._cartoonHitLoading) {
      this._cartoonHitLoading = true;
      import("./client/CartoonHitEffect")
        .then((m) => {
          const ch = m.CartoonHitEffect.getInstance();
          const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
          if (gameScene) {
            ch.init(gameScene);
            this._cartoonHit = ch;
            console.log("[CartoonHitEffect] Initialized");
          } else {
            this._cartoonHitLoading = false;
          }
        })
        .catch((e) => {
          console.error("[CartoonHitEffect] Failed to load:", e);
          this._cartoonHitLoading = false;
        });
    } else if (this._cartoonHit) {
      this._cartoonHit.update(dtSec);
    }

    // Update charge glow lights (pulsing red glow for remote players charging blade)
    if (this.chargingPlayers.size > 0) {
      const now = performance.now() / 1000;
      // Pulse: intensity oscillates between 4 and 12
      const pulse = 8 + 4 * Math.sin(now * 8);
      for (const [, light] of this.chargingGlows) {
        light.intensity = pulse;
      }
    }

    // Render network diagnostics overlay (if cl_netgraph > 0)
    NetGraph.render();

    // Drive the dynamic crosshair: COD-style spread that widens with movement and
    // converges to center when ADS'ing, plus a red-X override when out of ammo.
    const hud = HUDState.getInstance();
    const weaponId = this.getCurrentWeaponId();
    const crosshairCfg = WEAPONS[weaponId]?.crosshair ?? null;
    const adsProgress = getWeaponViewManager().getAdsProgress();
    const horizSpeed = this.v2Client?.getMovementState().actualHorizSpeed ?? 0;
    const ammoStatus = getAmmoStatus(weaponId, hud.ammo[weaponId]);
    Crosshair.getInstance().update(
      adsProgress,
      horizSpeed,
      crosshairCfg,
      this._isPlayerDead,
      this.playerState === "playing",
      ammoStatus.outOfAmmo,
    );
  }

  /**
   * Per-frame interpolated rendering of server-driven projectiles.
   * Samples the SnapshotBuffer for each active projectile entity,
   * giving smooth lerp between two snapshots (same as remote players).
   */
  private renderServerProjectiles(): void {
    const projMgr = getProjectileManager();
    for (const entityId of this.activeServerProjectiles) {
      const interp = this.projectileBuffer.sample(entityId);
      if (!interp) continue;
      projMgr.updateServerPosition(
        entityId,
        new Vector3(interp.x, interp.y, interp.z),
        new Vector3(interp.vx, interp.vy, interp.vz),
      );

      // A rocket into a pool used to land in silence: water is NONSOLID, so
      // nothing impacts it and no event fires. This loop already has the
      // per-frame position, which is all a crossing needs.
      this.liquidInteractions?.notifyProjectile(
        entityId,
        { x: interp.x, y: interp.y, z: interp.z },
        Math.hypot(interp.vx, interp.vy, interp.vz),
      );
    }
  }

  /**
   * Get V2Client's current predicted movement state.
   * Unlike onPlayerStateUpdate (which fires only on snapshot frames, BEFORE the tick loop),
   * this returns the CURRENT state AFTER the tick loop, in sync with getLocalPlayerPosition().
   * Essential for keeping view bob, animations, and camera effects aligned with camera position.
   */
  getCurrentMovementState(): PlayerStateUpdate | null {
    if (!this.v2Client) return null;
    const v2State = this.v2Client.getState();
    const ms = this.v2Client.getMovementState();
    return {
      position: v2State.position,
      velocity: v2State.velocity,
      grounded: v2State.grounded,
      tick: 0, // Not used for view effects
      isSliding: ms.isSliding,
      isCrouching: ms.isCrouching,
      crouchViewOffset: ms.crouchViewOffset,
      wallJumpState: ms.wallJumpState as any,
      ledgeGrabState: ms.ledgeGrabState as any,
      actualHorizSpeed: ms.actualHorizSpeed,
      slidePhase: ms.slidePhase,
      ledgeGrabPhase: ms.ledgeGrabPhase,
    };
  }

  /**
   * Get current local player position from simulation
   * Uses interpolation for smooth rendering between snapshots
   */
  getLocalPlayerPosition(): { x: number; y: number; z: number } | null {
    if (!this.gameHost) {
      return null;
    }

    // === V2 CLIENT: Use predicted position for instant, accurate rendering ===
    // When V2NetworkClient is active, it owns the authoritative client position.
    // NetworkGameHost.localState is NOT updated (predictLocally is skipped).
    if (this.v2Client && this.isNetworkMode) {
      // Wait for first server snapshot - position is (0,0,0) until then
      if (!this.v2Client.hasValidPosition()) {
        return null; // Camera will wait for valid position
      }
      // Decay the visual smoothing offset each frame (absorbs reconciliation jitter)
      const engine = EngineStore.LastCreatedEngine;
      let dt = engine ? engine.getDeltaTime() / 1000 : 0.016;
      // Tab-recovery: clamp dt for visual offset decay too
      if (this._tabReturnFrameSkips > 0) dt = 0.016;
      this.v2Client.decayVisualOffset(dt);
      // Use visually smoothed position for camera rendering
      const pos = this.v2Client.getVisualPosition();
      return { x: pos.x, y: pos.y, z: pos.z };
    }

    const state = this.gameHost.getLocalState();
    const player = state.players.get(this.localPlayerId);
    if (!player) {
      if (Math.random() < 0.01) {
        console.log(`[Game] getLocalPlayerPosition: no player for ${this.localPlayerId}`);
      }
      return null;
    }

    // For NetworkGameHost (legacy path without V2Client), use interpolated entity
    const networkHost = this.gameHost as any;
    if (typeof networkHost.getInterpolatedEntity === "function") {
      const interpolatedEntity = networkHost.getInterpolatedEntity(player.entityId);
      if (interpolatedEntity) {
        const transform = interpolatedEntity.getComponent("transform") as any;
        if (transform?.position) {
          return {
            x: transform.position.x,
            y: transform.position.y,
            z: transform.position.z,
          };
        }
      }
    }

    // For LocalGameHost, use interpolated position
    const localHost = this.gameHost as LocalGameHost;
    if (localHost.getInterpolatedPosition) {
      const interpPos = localHost.getInterpolatedPosition(player.entityId);
      if (interpPos) return interpPos;
    }

    // Fallback to discrete position
    const entity = state.entities.get(player.entityId);
    if (!entity) {
      return null;
    }

    const transform = entity.getComponent<TransformComponent>("transform");
    if (!transform) {
      return null;
    }

    return { ...transform.position };
  }

  /**
   * Get current tick
   */
  getCurrentTick(): number {
    return this.gameHost?.currentTick ?? 0;
  }

  /**
   * Check if running
   */
  isGameRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get local player ID
   */
  getLocalPlayerId(): string {
    return this.localPlayerId;
  }

  /**
   * Get current ping to server in ms (-1 if not connected or local)
   */
  getPing(): number {
    if (!this.isNetworkMode || !this.gameHost) return -1;
    const state = this.gameHost.getLocalState();
    if (!state) return -1;
    const localPlayer = state.players.get(this.localPlayerId);
    return localPlayer?.ping ?? -1;
  }

  /**
   * Send ready signal to server (for warmup phase)
   */
  sendReady(): void {
    if (!this.isNetworkMode || !this.gameHost) {
      console.log("[Game] Cannot send ready — not connected");
      return;
    }

    const data = MessageCodec.encodeReady();
    // Send via the NetworkGameHost's transport
    const networkHost = this.gameHost as any;
    if (networkHost.transport && typeof networkHost.transport.send === "function") {
      networkHost.transport.send(data, true); // Reliable
      MatchStateManager.getInstance().setReady(true);
      console.log("[Game] Sent ready signal to server");
    }
  }

  /**
   * Send respawn request to server (after death cooldown)
   */
  private sendRequestSpawn(): void {
    if (!this.isNetworkMode || !this.gameHost) return;

    const data = MessageCodec.encodeRequestSpawn();
    const networkHost = this.gameHost as any;
    if (networkHost.transport && typeof networkHost.transport.send === "function") {
      networkHost.transport.send(data, true); // Reliable
      console.log("[Game] Sent RequestSpawn to server");
    }
  }

  /**
   * Shutdown game
   */
  shutdown(): void {
    if (this._joinPendingTimeout) {
      clearTimeout(this._joinPendingTimeout);
      this._joinPendingTimeout = null;
    }
    this._joinPending = false;
    this._joinCompleting = false;
    this._joinGametypeWaits = 0;
    this._preferredTeam = undefined;
    this._teamWasPicked = false;
    this._loadoutChosen = false;
    this._loadoutPicker?.destroy();
    this._loadoutPicker = null;

    if (this.gameHost) {
      // Disconnect if in network mode
      if (this.isNetworkMode && "disconnect" in this.gameHost) {
        (this.gameHost as any).disconnect();
      }
      this.gameHost.stop?.();
      this.gameHost = null;
    }
    this.simulation = null;
    this.isRunning = false;
    this.isNetworkMode = false;
    this.serverUrl = null;
    this.commandSeq = 1; // Must match InputHistory.nextSeq (starts at 1)
    this.onStateUpdateCallbacks = [];
    this._latestGameState = null;
    this.spectatorCycling?.reset();
    this.spectatorCycling = null;
    this.spectatorController?.dispose();
    this.spectatorController = null;
    this.droppedWeaponRenderer?.dispose();
    this.droppedWeaponRenderer = null;
    this.bombRenderer?.dispose();
    this.bombRenderer = null;
    this.bombSiteMarkers?.dispose();
    this.bombSiteMarkers = null;
    resetFPSMovementAudio();

    // Cleanup event listeners
    if (this._joinKeyHandler) {
      document.removeEventListener("keydown", this._joinKeyHandler);
      this._joinKeyHandler = null;
    }
    if (this._scoreboardKeyHandler) {
      document.removeEventListener("keydown", this._scoreboardKeyHandler);
      this._scoreboardKeyHandler = null;
    }
    if (this._scoreboardKeyUpHandler) {
      document.removeEventListener("keyup", this._scoreboardKeyUpHandler);
      this._scoreboardKeyUpHandler = null;
    }
    if (this._specCycleKeyHandler) {
      document.removeEventListener("keydown", this._specCycleKeyHandler);
      this._specCycleKeyHandler = null;
    }
    if (this._specMouseHandler) {
      document.removeEventListener("mousedown", this._specMouseHandler);
      this._specMouseHandler = null;
    }

    // Cleanup match state and HUD

    FPSHud.getInstance().destroy();
    Crosshair.getInstance().dispose();
    MatchStateManager.destroy();
    HUDState.destroy();

    console.log("[Game] Shutdown complete");
  } // ========================================================================
  // Event Context
  // ========================================================================

  /** Lazily provide the event context (avoids creating a new object each snapshot) */
  private _eventCtx: GameEventContext | null = null;

  private getEventContext(): GameEventContext {
    if (!this._eventCtx) {
      this._eventCtx = {
        get localPlayerId() {
          return Game.getInstance().localPlayerId;
        },
        set localPlayerId(v) {
          Game.getInstance().localPlayerId = v;
        },
        isNetworkMode: this.isNetworkMode,
        gameHost: this.gameHost,
        v2Client: this.v2Client,
        forgetLocalLiquid: () => {
          Game.getInstance().forgetLocalLiquid();
        },
        resetLocalAir: () => {
          Game.getInstance().resetLocalAir();
        },
        forgetProjectileLiquid: (entityId: string) => {
          Game.getInstance().forgetProjectileLiquid(entityId);
        },
        get remoteRenderer() {
          return Game.getInstance().remoteRenderer;
        },
        set remoteRenderer(v) {
          Game.getInstance().remoteRenderer = v;
        },
        get droppedWeaponRenderer() {
          return Game.getInstance().droppedWeaponRenderer;
        },
        set droppedWeaponRenderer(v) {
          Game.getInstance().droppedWeaponRenderer = v;
        },
        _lastServerWeapon: this._lastServerWeapon,
        enemyWeapons: this.enemyWeapons,
        _localCharging: this._localCharging,
        chargingPlayers: this.chargingPlayers,
        chargingGlows: this.chargingGlows,
        serverProjectileDefIds: this.serverProjectileDefIds,
        activeServerProjectiles: this.activeServerProjectiles,
        projectileBuffer: this.projectileBuffer,
        get _isPlayerDead() {
          return Game.getInstance()._isPlayerDead;
        },
        set _isPlayerDead(v) {
          Game.getInstance()._isPlayerDead = v;
        },
        get _respawnRequested() {
          return Game.getInstance()._respawnRequested;
        },
        set _respawnRequested(v) {
          Game.getInstance()._respawnRequested = v;
        },
        get _respawnCooldownEnd() {
          return Game.getInstance()._respawnCooldownEnd;
        },
        set _respawnCooldownEnd(v) {
          Game.getInstance()._respawnCooldownEnd = v;
        },
        _gibSystem: this._gibSystem,
        _pendingGibSpawns: this._pendingGibSpawns,
        _ragdollSystem: this._ragdollSystem,
        _cartoonHit: this._cartoonHit,
        _deathCamera: this._deathCamera,
        get spectatingEntityId() {
          return Game.getInstance()._spectatingEntityId;
        },
        onStateUpdateCallbacks: this.onStateUpdateCallbacks,
        get pendingTick() {
          return Game.getInstance().pendingTick;
        },
        set pendingTick(v) {
          Game.getInstance().pendingTick = v;
        },
        get _tabReturnFrameSkips() {
          return Game.getInstance()._tabReturnFrameSkips;
        },
        set _tabReturnFrameSkips(v) {
          Game.getInstance()._tabReturnFrameSkips = v;
        },
        _stateUpdateCount: 0,
        sendRequestSpawn: () => this.sendRequestSpawn(),
      };
    }
    // Update refs that may change
    this._eventCtx.gameHost = this.gameHost;
    this._eventCtx.v2Client = this.v2Client;
    this._eventCtx.isNetworkMode = this.isNetworkMode;
    this._eventCtx._gibSystem = this._gibSystem;
    this._eventCtx._ragdollSystem = this._ragdollSystem;
    this._eventCtx._cartoonHit = this._cartoonHit;
    return this._eventCtx;
  }

  /**
   * Handle state update from simulation — delegates to GameEvents module
   */
  private onServerStateUpdate(state: GameState): void {
    // Store latest state for spectator target provider
    this._latestGameState = state;

    // Update spectator cycling list (if spectating)
    if (this.playerState === "spectator" && this.spectatorCycling) {
      this.spectatorCycling.updateFromGameState(state);

      // Update SpectatorOverlay with target player name
      const targetId = this.spectatorCycling.getTargetEntityId();
      if (targetId && this.spectatorOverlay) {
        this.spectatorOverlay.setSpectatingTarget(this.spectatorCycling.getTargetName());
      }
    }

    // Detect server-confirmed join: our entity appeared in snapshot.
    //
    // Deliberately NOT gated on `_joinPending`. That flag is cleared by a five
    // second timeout, and the server can legitimately take longer than that to
    // put us in a round: a Search & Destroy join lands mid-round as a dead
    // entity that the next freeze revives, and a join refused for a missing
    // loadout has to be retried after the choice arrives. Once the flag lapsed,
    // this check stopped running for the rest of the session — so the server
    // could spawn us, hand us our kit and full health, and the client would sit
    // in freefly watching a bot, with no path back. The entity being in the
    // snapshot while we are not playing IS the confirmation, whenever it shows
    // up, so the condition is the state itself rather than a race against it.
    if (this.playerState !== "playing" && !this._joinCompleting && this.localPlayerId) {
      const myPlayer = state.players.get(this.localPlayerId);
      if (myPlayer && myPlayer.entityId && state.entities.has(myPlayer.entityId)) {
        console.log(`[Game] Server confirmed join — entity ${myPlayer.entityId} found in snapshot`);
        // `completeJoinGame` is async and takes several frames; without this
        // every frame in between would start another one.
        this._joinCompleting = true;
        void this.completeJoinGame().finally(() => {
          this._joinCompleting = false;
        });
      }
    }

    // Lazy-init remote renderer if not yet created
    if (!this.remoteRenderer) {
      const cam = CameraSystem.getInstance().getCamera();
      const gameScene = cam?.getScene();
      if (gameScene) {
        this.remoteRenderer = new RemotePlayerRenderer(gameScene);
        this.remoteRenderer.setEnemyWeapons(this.enemyWeapons);
      }
    }
    handleServerStateUpdate(this.getEventContext(), state);
  }

  /**
   * Set spawn points (from map entities)
   */
  setSpawnPoints(points: Array<{ x: number; y: number; z: number }>): void {
    if (this.simulation) {
      this.simulation.setSpawnPoints(points);
    }
  }

  /**
   * Set collision world (from loaded BSP)
   * This sets collision on BOTH the local simulation AND the network prediction simulation
   */
  setCollisionWorld(
    collision: import("../../engine/network/systems/collision/CollisionWorld").CollisionWorld | null,
  ): void {
    // Set on local simulation (for local mode)
    if (this.simulation) {
      this.simulation.setCollisionWorld(collision);
      console.log("[Game] Collision world set on local simulation");
    }

    // Also set on NetworkGameHost's prediction simulation (for network mode)
    const networkHost = this.gameHost as any;
    if (networkHost && typeof networkHost.setCollisionWorld === "function") {
      networkHost.setCollisionWorld(collision);
      console.log("[Game] Collision world set on network prediction simulation");
    }

    // Set on V2NetworkClient for Q3-style prediction (network mode)
    if (this.v2Client) {
      this.v2Client.setCollisionWorld(collision);
      console.log("[Game] Collision world set on V2NetworkClient");
    }

    // Underwater presentation asks the same collision world what the CAMERA is
    // standing in, which is not always what the player is standing in.
    this.underwaterView?.setCollisionWorld(collision);
    // The interaction system asks the same world where the waterline is, and
    // how far a ring may spread before it runs out of pool.
    this.liquidInteractions?.setCollisionWorld(collision);
  }

  /** Tint, fog and view warp while the camera itself is under a surface. */
  private underwaterView: UnderwaterView | null = null;

  /**
   * Begin driving underwater presentation for this scene.
   *
   * Separate from construction because the scene is rebuilt on every map load
   * and the previous view must be disposed with it — otherwise the next map
   * inherits a fog state it never asked for.
   */
  public startUnderwaterView(scene: import("@babylonjs/core/scene").Scene): void {
    this.underwaterView?.dispose();
    this.underwaterView = new UnderwaterView(scene);
    this.underwaterView.onSubmersion = (amount) => {
      getWeaponViewManager().submersionAmount = amount;
    };
    this.underwaterView.start();

    this.liquidInteractions?.dispose();
    this.liquidInteractions = new LiquidInteractionSystem(scene);
    // The remote renderer already sees every player's water level each frame,
    // so it is the cheapest place to notice a crossing.
    if (this.remoteRenderer) this.remoteRenderer.liquidInteractions = this.liquidInteractions;

    this.airTracker = new LocalAirTracker();
    this.airTracker.onStartedDrowning = playDrownGasp;
    this.airTracker.onDrownTick = playDrownTick;
  }

  /** Splashes and ripples where bodies cross a surface. Owned per map. */
  private liquidInteractions: LiquidInteractionSystem | null = null;

  /** Local air, mirrored for the HUD and the gasp. Presentation only. */
  private airTracker: LocalAirTracker | null = null;

  /** Drop a despawned projectile from liquid-crossing tracking. */
  public forgetProjectileLiquid(entityId: string): void {
    this.liquidInteractions?.forgetProjectile(entityId);
  }

  /** Re-baseline the local body after a respawn or teleport. */
  public forgetLocalLiquid(): void {
    this.liquidInteractions?.forget("local");
  }

  /**
   * Refill the local air mirror on respawn.
   *
   * Without it a player who drowned comes back with the empty lungs they died
   * with, and the HUD says so for a moment before the server disagrees.
   */
  public resetLocalAir(): void {
    this.airTracker?.reset();
  }

  /** Local air remaining, 0-1. For the HUD; not authoritative. */
  public get localAirFraction(): number {
    return this.airTracker?.air ?? 1;
  }

  /** True once the lungs are empty. Drives the HUD's alarm state. */
  public get localDrowning(): boolean {
    return this.airTracker?.drowning ?? false;
  }

  /**
   * Fire a splash on demand, for the `water splash` console command.
   *
   * Goes through the same path a real crossing does rather than reaching into
   * the ring pool, so what you inspect is what players see. The speed is a
   * plausible dive rather than a maximum: a debug effect tuned by its loudest
   * possible case teaches the wrong thing about the ordinary one.
   */
  public debugSplash(position: { x: number; y: number; z: number }): void {
    const id = `debug-splash-${performance.now()}`;
    this.liquidInteractions?.notify(id, 0, "water", position, -400, true);
    this.liquidInteractions?.notify(id, 2, "water", position, -400, true);
    this.liquidInteractions?.forget(id);
  }

  /**
   * Your own splash, and your own air.
   *
   * Both read the PREDICTED water level rather than the snapshot's: the local
   * player's own body is simulated here, so taking it from the wire would land
   * their splash and their gasp a round trip after they felt the water.
   */
  private emitLocalLiquidCrossing(): void {
    if (!this.v2Client) return;

    const state = this.v2Client.getState();
    const movement = this.v2Client.getMovementState();

    this.liquidInteractions?.notify("local", movement.waterLevel, "water", state.position, state.velocity.y, true);

    const dt = Math.min(0.1, (EngineStore.LastCreatedEngine?.getDeltaTime() ?? 16) / 1000);
    this.airTracker?.update(movement.waterLevel, dt);
  }

  /** How submerged the camera is, 0-1. Read by the viewmodel to float the gun. */
  public get cameraSubmersion(): number {
    return this.underwaterView?.submersionAmount ?? 0;
  }
}
