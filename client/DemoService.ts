/**
 * DemoService — Shared state for demo playback
 *
 * Singleton that bridges console commands, lobby UI, and the playback engine.
 * Holds the currently loaded demo, cached demolist, and active player instances.
 *
 * Lifecycle:
 *   1. LobbyPanel (or setup code) calls DemoService.getInstance().setLobbyClient(client)
 *   2. `demo <n>` → fetchAndLoad(filename)
 *   3. `demoplay` → loadAndPlayNormal(viewer)
 *   4. `demoplay cinematic <min>` → loadAndPlayCinematic(viewer, cameraSystem, minutes)
 */

import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CameraSystem } from "../../../engine/camera/CameraSystem";
import { EventBus } from "../../../engine/core/EventBus";
import { addToDynamicLightCluster, disposeClusteredLight } from "../../../engine/lighting/DynamicLightCluster";
import { SnapshotBuffer } from "../../../engine/network/client/SnapshotBuffer";
import type { GameState } from "../../../engine/network/core/GameState";
import type {
  DamageEvent,
  DeathEvent,
  ProjectileImpactEvent,
  VoltaicBeamEvent,
  WeaponFireEvent,
} from "../../../engine/network/core/SnapshotEvent";
import {
  BLADE_EXPLOSION,
  GRENADE_EXPLOSION,
  getExplosionEffect,
  PLASMA_EXPLOSION,
  ROCKET_EXPLOSION,
} from "../../../engine/weapon/ExplosionEffect";
import { getHitscanEffects } from "../../../engine/weapon/HitscanEffects";
import { getProjectileManager } from "../../../engine/weapon/ProjectileManager";
import { WeaponViewManager } from "../../../engine/weapon/WeaponViewManager";
import type { LobbyClient } from "../../../lobby/LobbyClient";
import type { DemoInfo } from "../../../lobby/types";
import { DemoAnalyzer } from "../../../shared/demo/DemoAnalyzer";
import { normalizeDemoMapName } from "../../../shared/demo/DemoMapName";
import { DemoReader } from "../../../shared/demo/DemoReader";
import { isClientKey } from "../ClientEntityKey";
import { FPSPickup } from "../world/FPSPickup";
import { CinematicDemoPlayer } from "./CinematicDemoPlayer";
import type { CinematicHUD } from "./CinematicHUD";
import { DamageNumbers } from "./DamageNumbers";
import { DemoEventOverlay } from "./DemoEventOverlay";
import { DemoEventTimeline } from "./DemoEventTimeline";
import { DemoOverlayController, type DemoOverlayMode } from "./DemoOverlayController";
import type { DemoViewer, DemoViewerInfo } from "./DemoViewer";
import type { DemoViewerHUD } from "./DemoViewerHUD";
import { type DroppedWeaponInfo, DroppedWeaponRenderer } from "./DroppedWeaponRenderer";
import { FollowedViewWeapon } from "./FollowedViewWeapon";
import { preloadFPSAudio } from "./FPSAudio";
import {
  playDamageConfirmationSound,
  playKillEcho,
  playPlayerDeathSound,
  playPlayerPainSound,
  playProjectileImpactSound,
  playWeaponFireSound,
} from "./FPSCombatAudio";
import { processFPSMovementAudio, resetFPSMovementAudio } from "./FPSMovementAudio";
import { playPickupSound } from "./FPSPickupAudio";
import {
  handleRemoteWeaponFire,
  handleVoltaicBeam,
  type ProjectileSyncState,
  processProjectileEntities,
  WEAPON_EFFECT_COLORS,
} from "./GameEvents";
import { GibSystem } from "./GibSystem";
import type { RemotePlayerRenderer } from "./RemotePlayerRenderer";

export class DemoService {
  private static _instance: DemoService | null = null;

  // ── Shared state ───────────────────────────────────────────────────────────

  /** Cached demolist from the last `demolist` call */
  cachedDemoList: DemoInfo[] = [];

  /** Raw bytes of the currently loaded demo */
  loadedDemoData: Uint8Array | null = null;

  /** Parsed reader for the currently loaded demo */
  loadedDemoReader: DemoReader | null = null;

  /** Active normal-mode playback viewer */
  activeDemoViewer: DemoViewer | null = null;

  /** Active cinematic player (wraps a DemoViewer) */
  activeCinematicPlayer: CinematicDemoPlayer | null = null;

  private lobbyClient: LobbyClient | null = null;
  private remoteRenderer: RemotePlayerRenderer | null = null;
  private demoHud: DemoViewerHUD | null = null;
  private cinematicHud: CinematicHUD | null = null;
  private demoEventOverlay: DemoEventOverlay | null = null;
  private readonly demoEventTimeline = new DemoEventTimeline();
  private readonly demoOverlays = new DemoOverlayController();
  private playbackRaf: number | null = null;
  private lastFrameTimeMs: number = 0;
  private latestState: GameState | null = null;
  private demoGibs: GibSystem | null = null;
  private demoDamageNumbers: DamageNumbers | null = null;
  private droppedWeaponRenderer: DroppedWeaponRenderer | null = null;
  private readonly chargingPlayers = new Set<string>();
  private readonly chargingGlows = new Map<string, PointLight>();
  private lastEffectTick: number | null = null;
  /** Tick of the last _syncPersistentDemoState run — same tick = same recorded
   *  state, so the O(entities) rebuild is skipped (delivery bursts re-call it). */
  private lastPersistentSyncTick: number | null = null;

  // Demo spectator state
  private _followedEntityId: string | null = null;
  /**
   * Demo playback's OWN viewmodel instance, bound to the spectator camera
   * (QA-8). Never the live getInstance() — sharing one WeaponViewManager
   * between live play and demo playback is how `demoplay stop` destroyed the
   * live viewmodel. Created on first spectate, disposed in stopAll().
   */
  private _demoWvm: WeaponViewManager | null = null;
  private _unsubCameraChange: (() => void) | null = null;
  /** What the followed player's weapon does; the same code live spectating runs. */
  private readonly _followed = new FollowedViewWeapon(() => this._demoWvm);
  private _isSeeking = false;
  /** entityId → currentWeapon, fed to RemotePlayerRenderer for 3rd-person weapon models */
  private _enemyWeapons: Map<string, string> = new Map();

  // Followed-player HUD stats (health/armor/weapon/ammo)
  private _specHealth = 0;
  private _specArmor = 0;
  private _specWeapon = "";
  private _specAmmo = "";

  /** In-flight server projectile visuals (rockets/plasma/grenades mid-air) */
  private _projectiles: ProjectileSyncState = {
    active: new Set<string>(),
    defIds: new Map<string, string>(),
    seenTicks: new Map<string, number>(),
    buffer: new SnapshotBuffer(),
  };

  /**
   * Counts demo starts. A start that finds a newer one begun while it awaited
   * (teardown, controllers, the map load) gives way to it: both used to run
   * side by side, because nothing was marked active until the map had loaded.
   * stopAll() counts too, so a stop during loading wins over the load.
   */
  private startGeneration = 0;

  private constructor() {}

  static getInstance(): DemoService {
    if (!DemoService._instance) {
      DemoService._instance = new DemoService();
    }
    return DemoService._instance;
  }

  // ── LobbyClient registration ───────────────────────────────────────────────

  /**
   * Register the active LobbyClient so console commands can request demolists.
   * Called by LobbyPanel after connecting.
   */
  setLobbyClient(client: LobbyClient): void {
    this.lobbyClient = client;
  }

  getLobbyClient(): LobbyClient | null {
    return this.lobbyClient;
  }

  hasActivePlayback(): boolean {
    return this.activeDemoViewer !== null;
  }

  setDemoOverlayVisible(visible: boolean): boolean {
    return this.demoOverlays.setVisible(visible);
  }

  toggleDemoOverlay(): boolean {
    return this.demoOverlays.toggle();
  }

  isDemoOverlayVisible(): boolean {
    return this.demoOverlays.isVisible();
  }

  // ── Demo fetching ──────────────────────────────────────────────────────────

  /**
   * Fetch a demo file from the lobby server's static file store and load it.
   * Returns a short summary string for console output.
   */
  async fetchAndLoad(filename: string): Promise<string> {
    const response = await fetch(`${DemoService.demoBaseUrl()}/${filename}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${filename}`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    return this._loadData(data, filename);
  }

  /**
   * Base URL demos are fetched from. Defaults to the dev/Vite static path
   * (`/data/demos`); override with `VITE_DEMO_BASE_URL` for lobby/prod hosting.
   */
  static demoBaseUrl(): string {
    const base = import.meta.env.VITE_DEMO_BASE_URL || "/data/demos";
    return base.replace(/\/+$/, "");
  }

  /**
   * Load raw demo bytes (e.g. from a file picker or pre-fetched buffer).
   */
  async loadRaw(data: Uint8Array, label = "demo"): Promise<string> {
    return this._loadData(data, label);
  }

  private async _loadData(data: Uint8Array, label: string): Promise<string> {
    const reader = await DemoReader.fromFile(data);

    // Validate HERE (file-load time) rather than at playback start — starting
    // playback tears down any live session before DemoViewer.load() would
    // reject a legacy header, kicking the player out of a match for nothing.
    const probe = reader.readHeader();
    if (!probe.tickRate || probe.tickRate <= 0) {
      throw new Error(`${label}: legacy demo (no tickRate in header) — re-record with a current server.`);
    }

    this.loadedDemoData = data;
    this.loadedDemoReader = reader;

    const header = reader.readHeader();
    const index = reader.readIndex();
    const durationSec = Math.round(index.durationMs / 1000);
    const mm = Math.floor(durationSec / 60);
    const ss = String(durationSec % 60).padStart(2, "0");
    return `Loaded: ${label} — ${header.map} · ${header.gametype} · ${mm}:${ss}`;
  }

  // ── Normal playback ────────────────────────────────────────────────────────

  /**
   * Start normal demo playback using a provided DemoViewer.
   * The caller is responsible for wiring the viewer's onFrame callback
   * to the game renderer.
   */
  async loadAndPlayNormal(viewer: DemoViewer, options: { manual?: boolean } = {}): Promise<void> {
    if (!this.loadedDemoData) throw new Error("No demo loaded. Use `demo <filename>` first.");
    const start = ++this.startGeneration;

    // 1. Own the scene: stop any live game + any prior demo playback.
    await this.teardownLiveSession();
    if (start !== this.startGeneration) return;
    this.stopForPlaybackTransition();

    // 2. Register demo controllers + take a deterministic camera before load.
    const cameraSystem = CameraSystem.getInstance();
    await this.ensureCinematicControllers(cameraSystem);
    if (start !== this.startGeneration) return;
    this.beginDemoCamera(cameraSystem);

    // 3. Render the recorded map locally (no server).
    await this.ensureDemoMapLoaded();
    if (start !== this.startGeneration) return;

    // 4. Wire the frame callback → renderer/HUD, then play.
    this.activeDemoViewer = viewer;
    await this.ensureRuntimeWiring(viewer, "normal", !options.manual);
    if (this.abandonStart(start, viewer)) return;
    await viewer.load(this.loadedDemoData);
    if (this.abandonStart(start, viewer)) return;
    viewer.play();
    if (!options.manual) this.startPlaybackLoop();
  }

  // ── Cinematic playback ─────────────────────────────────────────────────────

  /**
   * Start cinematic highlight reel.
   * viewer + cameraSystem are injected so callers control the rendering context.
   */
  async loadAndPlayCinematic(viewer: DemoViewer, cameraSystem: CameraSystem, durationMinutes: number): Promise<void> {
    if (!this.loadedDemoData) throw new Error("No demo loaded. Use `demo <filename>` first.");
    const start = ++this.startGeneration;

    // 1. Own the scene: stop any live game + any prior demo playback.
    await this.teardownLiveSession();
    if (start !== this.startGeneration) return;
    this.stopForPlaybackTransition();

    // 2. Register demo controllers + take a deterministic camera before load.
    await this.ensureCinematicControllers(cameraSystem);
    if (start !== this.startGeneration) return;
    this.beginDemoCamera(cameraSystem);

    // 3. Render the recorded map locally (no server).
    await this.ensureDemoMapLoaded();
    if (start !== this.startGeneration) return;

    // 4. Wire the frame callback, then start the cinematic player.
    this.activeDemoViewer = viewer;
    await this.ensureRuntimeWiring(viewer, "cinematic");
    if (this.abandonStart(start, viewer)) return;
    const player = new CinematicDemoPlayer(viewer, cameraSystem);
    this.activeCinematicPlayer = player;
    await this.ensureCinematicHud(player);
    if (this.abandonStart(start, viewer)) return;
    await player.loadAndPlay(this.loadedDemoData, durationMinutes);
    if (this.abandonStart(start, viewer)) return;
    this.startPlaybackLoop();
  }

  /**
   * True when a stop or a newer start superseded this one while it was wiring
   * up. What it wired so far is torn down unless the newer start already took
   * over the playback slots (D9).
   */
  private abandonStart(start: number, viewer: DemoViewer): boolean {
    if (start === this.startGeneration) return false;
    if (this.activeDemoViewer === viewer) this.stopPlayback();
    return true;
  }

  // ── Analysis ──────────────────────────────────────────────────────────────

  /**
   * Run DemoAnalyzer on the loaded demo and return a formatted text table.
   * Pure analysis — does not start playback.
   */
  async analyzeLoadedDemo(): Promise<string> {
    if (!this.loadedDemoData || !this.loadedDemoReader) {
      throw new Error("No demo loaded. Use `demo <filename>` first.");
    }

    const reader = this.loadedDemoReader;
    const header = reader.readHeader();
    const index = reader.readIndex();
    const frames = reader.readAllFrames();
    const analysis = new DemoAnalyzer().analyze(frames, header, index.durationMs);

    const { highlights } = analysis;
    if (highlights.length === 0) {
      return "No highlights found in this demo.";
    }

    const durationSec = Math.round(index.durationMs / 1000);
    const mm = Math.floor(durationSec / 60);
    const ss = String(durationSec % 60).padStart(2, "0");

    const lines: string[] = [
      `HIGHLIGHT ANALYSIS — ${header.map} (${mm}:${ss})`,
      `Found ${highlights.length} highlights`,
      "",
      `#    TICK   SCORE  TYPE              PLAYER             TAGS`,
      "─".repeat(72),
    ];

    highlights.slice(0, 20).forEach((h, i) => {
      const num = String(i + 1).padStart(3);
      const tick = String(h.peakTick).padStart(6);
      const score = h.score.toFixed(1).padStart(6);
      const type = h.type.padEnd(17);
      const name = h.primaryPlayerName.padEnd(18);
      const tags = h.tags.join(", ") || "—";
      lines.push(`${num}  ${tick}  ${score}  ${type}  ${name}  ${tags}`);
    });

    if (highlights.length > 20) {
      lines.push(`  … and ${highlights.length - 20} more`);
    }

    return lines.join("\n");
  }

  // ── Stop ──────────────────────────────────────────────────────────────────

  /**
   * A live game is starting in this page: stop a demo playing, and cancel one
   * still loading. With nothing playing, the camera is left alone.
   */
  stopForLiveGame(): void {
    if (this.hasActivePlayback()) this.stopAll();
    else this.startGeneration++;
  }

  /** Stop playback, including a demo start still loading. */
  stopAll(): void {
    this.startGeneration++;
    this.stopPlayback();
  }

  private stopPlayback(): void {
    this.stopPlaybackLoop();
    this._unsubCameraChange?.();
    this._unsubCameraChange = null;

    const cameraSystem = CameraSystem.getInstance();
    const spectator = cameraSystem.getController("spectator") as
      | {
          clearSpectateTarget?: () => void;
          clearTargetProvider?: () => void;
        }
      | undefined;
    this.remoteRenderer?.setHiddenEntity(null);
    spectator?.clearSpectateTarget?.();
    spectator?.clearTargetProvider?.();
    if (cameraSystem.getActiveController()?.type === "spectator" && cameraSystem.getController("freefly")) {
      cameraSystem.setController("freefly");
    }

    this.activeCinematicPlayer?.dispose();
    this.activeCinematicPlayer = null;

    this.activeDemoViewer?.pause();
    this.activeDemoViewer?.dispose();
    this.activeDemoViewer = null;

    this.remoteRenderer?.dispose();
    this.remoteRenderer = null;

    this.demoOverlays.reset();
    this.demoHud?.dispose();
    this.demoHud = null;
    this.cinematicHud?.dispose();
    this.cinematicHud = null;
    this.demoEventOverlay?.destroy();
    this.demoEventOverlay = null;
    this.demoEventTimeline.clear();
    this.demoGibs?.dispose();
    this.demoGibs = null;
    this.demoDamageNumbers?.dispose();
    this.demoDamageNumbers = null;
    this.droppedWeaponRenderer?.dispose();
    this.droppedWeaponRenderer = null;
    this._clearDemoCharge();
    this.lastEffectTick = null;
    this.lastPersistentSyncTick = null;

    this.latestState = null;
    this._followedEntityId = null;
    this._followed.follow(null);
    this._isSeeking = false;
    this._enemyWeapons.clear();
    this._clearDemoProjectiles();
    clearDemoWorldEffects();
    this._specHealth = 0;
    this._specArmor = 0;
    this._specWeapon = "";
    this._specAmmo = "";

    this._demoWvm?.dispose();
    this._demoWvm = null;
    // In-game playback shared scene.activeCameras with the demo instance —
    // let the live viewmodel (a separate instance, untouched by the demo)
    // re-assert its own camera pair. No-op on the standalone demo page.
    const liveWvm = WeaponViewManager.getInstance();
    if (liveWvm.isReady) liveWvm.reassertCameras();
  }

  private stopForPlaybackTransition(): void {
    const overlaysVisible = this.demoOverlays.isVisible();
    this.stopPlayback();
    this.demoOverlays.setVisible(overlaysVisible);
  }

  /**
   * Render the recorded map LOCALLY — geometry + worldspawn lighting only,
   * with no server and no gameplay.
   *
   * This deliberately does NOT use the `map` console command: that command
   * delegates to the gameplay launcher, which spawns a live dev server via the
   * lobby and joins it as a player. A demo just needs the world rendered so the
   * replayed frames have somewhere to be drawn.
   */
  private async ensureDemoMapLoaded(): Promise<void> {
    const header = this.loadedDemoReader?.readHeader();
    if (!header?.map) return;

    const mapName = normalizeDemoMapName(header.map);
    if (!mapName) {
      throw new Error(`Demo has no usable map name (recorded: "${header.map}").`);
    }

    const { loadClientMap } = await import("../../../engine/loader/map/ClientMapLoader");
    const result = await loadClientMap(mapName);
    if (/failed to load map|no scene available|camerasystem not available/i.test(result)) {
      throw new Error(`Demo map load failed for "${mapName}": ${result}`);
    }
  }

  /**
   * Shut down any live game/network session before demo playback so live
   * snapshots and the live FPS camera don't fight the replay in the same scene.
   */
  private async teardownLiveSession(): Promise<void> {
    try {
      const { Game } = await import("../Game");
      const game = Game.getInstance();
      if (game.isConnectedToServer()) {
        console.log("[DemoService] Shutting down live game session before demo playback");
        game.shutdown();
      }
    } catch (err) {
      console.warn("[DemoService] teardownLiveSession failed (non-fatal):", err);
    }
  }

  /**
   * Deterministic camera handoff: make freefly the active controller before the
   * map loads (so the map-load teleport frames a real camera at spawn instead of
   * leaving a stale FPS/live controller in place). Once the first frame arrives,
   * refreshHudPlayerList auto-switches to spectator on the first player.
   */
  private beginDemoCamera(cameraSystem: CameraSystem): void {
    if (!cameraSystem.getController("freefly")) return;
    const active = cameraSystem.getActiveController() as { type?: string } | null;
    if (active?.type === "freefly" || active?.type === "spectator") return;
    cameraSystem.setController("freefly");
  }

  /**
   * The demo view model draws through scene.activeCameras, which overrides
   * scene.activeCamera: left in place when a cinematic cut to a flyby, the
   * screen froze on the chase camera with the gun on top (D1). It lives only
   * while the spectator camera does.
   */
  private watchCameraController(): void {
    this._unsubCameraChange?.();
    this._unsubCameraChange = EventBus.on<{ type: string }>("camera:controller_changed", ({ type }) => {
      if (type === "spectator") {
        if (this._followedEntityId) this._attachWeaponViewToSpectatorCam();
        return;
      }
      this._demoWvm?.dispose();
      this._demoWvm = null;
    });
  }

  private async ensureRuntimeWiring(viewer: DemoViewer, overlayMode: DemoOverlayMode, withHud = true): Promise<void> {
    const camera = CameraSystem.getInstance().getCamera();
    const scene = camera?.getScene();
    if (!scene) {
      throw new Error("No active scene available for demo playback.");
    }

    this.watchCameraController();

    const { RemotePlayerRenderer } = await import("./RemotePlayerRenderer");
    this.remoteRenderer = new RemotePlayerRenderer(scene);
    this.remoteRenderer.enableDemoPlayback();
    // Feed 3rd-person weapon models. In live play GameEvents populates this map;
    // in demo playback we own it and fill it from weapon_state events per frame.
    this.remoteRenderer.setEnemyWeapons(this._enemyWeapons);

    // Initialize the shared effect systems against the demo scene so replayed
    // weapon_fire / projectile_impact / weapon_chain events render (these guard
    // on a scene being set and no-op otherwise).
    getHitscanEffects().init(scene);
    getExplosionEffect().init(scene);
    getProjectileManager().init(scene);
    await preloadFPSAudio();
    resetFPSMovementAudio();
    this.demoGibs = GibSystem.create(scene);
    this.demoDamageNumbers = DamageNumbers.create(scene);
    // Demo playback uses snapshot transforms directly: no wall-clock Havok toss
    // continues while paused, and seek landing reconstructs the exact item set.
    this.droppedWeaponRenderer = new DroppedWeaponRenderer(scene, true);

    viewer.onFrame((state) => {
      this.latestState = state;
      this._updateEnemyWeapons(state);
      const playback = viewer.getInfo();
      const discontinuous = this._syncDemoPresentationClock(playback);
      this._pushPlaybackClock(playback);
      this.remoteRenderer?.pushDemoSnapshot(state, "");
      this.refreshHudPlayerList();
      this._updateDemoLifeState(state);
      this._updateDemoWeapon(state, discontinuous);
      this._updateDemoHud(state);
      // Persistent bookkeeping must run UNCONDITIONALLY — projectile defIds
      // are announced once (projectile_spawn is a one-tick edge); if that tick
      // is a suppressed seek-landing frame, the projectile would fly modelless
      // for its entire flight. One-shot *presentation* stays gated below.
      for (const event of state.events) {
        if (event.type === "projectile_spawn") {
          const e = event as unknown as { entityId?: string; defId?: string };
          if (e.entityId && e.defId) this._projectiles.defIds.set(e.entityId, e.defId);
        }
      }
      if (this.demoEventTimeline.canPresentOneShots()) {
        this._updateDemoRecoil(state);
        this._processDemoEffects(state);
        processFPSMovementAudio(state, this._followedEntityId ?? undefined);
      }
      this._syncPersistentDemoState(state);
      // Spawn/despawn in-flight projectile visuals + buffer them for interpolation.
      // (runs after _processDemoEffects so projectile_spawn defIds are set first)
      this._projectiles.muzzleForShot = (position, velocity) => this._followed.muzzleFor(position, velocity);
      processProjectileEntities(state, this._projectiles);
      this.demoEventTimeline.finishPresentationFrame();
    });

    if (!withHud || typeof document === "undefined") return;
    const { DemoViewerHUD } = await import("./DemoViewerHUD");
    this.demoHud = new DemoViewerHUD();
    this.demoEventOverlay = new DemoEventOverlay(this.demoEventTimeline);
    this.demoOverlays.setChat(this.demoEventOverlay);
    this.demoOverlays.setMode(overlayMode);
    this.demoOverlays.setNormalHud(this.demoHud);
    this.demoOverlays.bindKeyboard(document);
    this.demoHud.onPlayPause(() => {
      if (this.activeCinematicPlayer) {
        this.activeCinematicPlayer.togglePlayPause();
      } else {
        this.activeDemoViewer?.togglePlayPause();
      }
    });
    this.demoHud.onSpeedChange(() => {
      this.activeDemoViewer?.cycleSpeed();
    });
    this.demoHud.onSeek((progress) => {
      this._isSeeking = true;
      // Drop in-flight projectiles before the jump — their spawn events are
      // one-shots that a seek skips, and their positions/buffer are now stale.
      this._clearDemoProjectiles();
      this.activeDemoViewer?.seekToProgress(progress);
      // Collapse the interpolation buffer so models snap to the seeked position
      // instead of interpolating across the discontinuous tick jump.
      this.remoteRenderer?.flushInterpolation();
      this._isSeeking = false;
    });
    this.demoHud.onPlayerSelect((entityId) => {
      this._selectSpectateTarget(entityId);
    });
  }

  private async ensureCinematicHud(player: CinematicDemoPlayer): Promise<void> {
    if (typeof document === "undefined") return;
    const { CinematicHUD } = await import("./CinematicHUD");
    this.cinematicHud = new CinematicHUD();
    this.demoOverlays.setCinematicHud(this.cinematicHud);
    player.onSegmentChange((segment) => {
      this.cinematicHud?.showSegmentInfo(segment, player.getReelInfo().totalSegments);
    });
  }

  /**
   * Follow a player entity in POV: point the spectator camera at it, hide its own
   * model, and (re)attach the first-person weapon viewmodel to the spectator cam.
   * Shared by manual player-list clicks and the first-frame auto-select.
   */
  private _selectSpectateTarget(entityId: string): void {
    if (!entityId) return;
    const cam = CameraSystem.getInstance();
    const spectator = cam.getController("spectator") as {
      setSpectateTarget?: (id: string) => void;
      getTargetEntityId?: () => string | null;
      type?: string;
    } | null;
    spectator?.setSpectateTarget?.(entityId);
    // Only trigger full attach/detach if not already in spectator mode
    if ((cam.getActiveController() as { type?: string } | null)?.type !== "spectator") {
      cam.setController("spectator");
    }
    this._followedEntityId = entityId;
    this._followed.follow(entityId, this._isDemoEntityDead(entityId));
    this.remoteRenderer?.setHiddenEntity(entityId);
    this._attachWeaponViewToSpectatorCam();
    // Their gun, stats and place in the player list come from frames, and a
    // paused demo delivers none: present them from the frame on screen, or the
    // previous player's stay up until playback resumes (D7).
    this._specHealth = 0;
    this._specArmor = 0;
    this._specWeapon = "";
    this._specAmmo = "";
    if (this.latestState) {
      this._updateDemoWeapon(this.latestState, true);
      this._updateDemoHud(this.latestState);
      // The list picks a target itself when the camera has none; only once the
      // camera holds this one can it not come back here.
      if (spectator?.getTargetEntityId?.() === entityId) this.refreshHudPlayerList();
    }
  }

  private startPlaybackLoop(): void {
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;
    this.stopPlaybackLoop();
    this.lastFrameTimeMs = performance.now();

    const tick = (now: number): void => {
      if (!this.activeDemoViewer) {
        this.playbackRaf = null;
        return;
      }

      const deltaMs = Math.max(0, now - this.lastFrameTimeMs);
      this.lastFrameTimeMs = now;

      this.updatePlaybackFrame(deltaMs);

      this.playbackRaf = window.requestAnimationFrame(tick);
    };

    this.playbackRaf = window.requestAnimationFrame(tick);
  }

  /** Shared frame body; a manual timedemo owns ordering inside the scene loop. */
  updatePlaybackFrame(deltaMs: number, applyCamera?: () => void): void {
    if (!this.activeDemoViewer) return;
    this.activeDemoViewer.update(deltaMs);
    this.activeCinematicPlayer?.update(deltaMs);
    const playback = this.activeDemoViewer.getInfo();
    this._syncDemoPresentationClock(playback);
    this._pushPlaybackClock(playback);
    const nextFrame = this.activeDemoViewer.getNextFrame();
    if (nextFrame) this.remoteRenderer?.pushDemoSnapshot(nextFrame.state, "", true);
    this._updateDemoPov(playback);
    applyCamera?.();
    this.remoteRenderer?.render();
    this._renderDemoProjectiles();
    this.demoEventOverlay?.render();
    this.demoHud?.update(playback);
    if (this.activeCinematicPlayer) this.cinematicHud?.updateProgress(this.activeCinematicPlayer.getReelInfo());
  }

  /** Timedemo camera changes retain normal POV weapon/recoil/hidden-body behavior. */
  setPlaybackSpectatorTarget(entityId: string | null): void {
    if (entityId === this._followedEntityId) return;
    if (entityId) {
      this._selectSpectateTarget(entityId);
      if (this.activeDemoViewer) this._updateDemoPov(this.activeDemoViewer.getInfo());
    } else {
      this._followedEntityId = null;
      this._followed.follow(null);
      this.remoteRenderer?.setHiddenEntity(null);
      const cam = CameraSystem.getInstance();
      const spectator = cam.getController("spectator") as { clearSpectateTarget?(): void } | undefined;
      spectator?.clearSpectateTarget?.();
      cam.setController("freefly");
    }
  }

  getPlaybackState(): GameState | null {
    return this.latestState;
  }

  async waitForPlaybackModels(): Promise<void> {
    await this.remoteRenderer?.waitForModels();
  }

  getPlaybackModelStats() {
    const stats = this.remoteRenderer?.getPlaybackModelStats() ?? { alivePlayers: 0, loadedBodies: 0 };
    if (!this.latestState) return stats;
    const dead = new Set(
      this.latestState.events
        .filter((event) => event.type === "combat_state" && (event as { dead?: boolean }).dead)
        .map((event) => event.entityId),
    );
    const alivePlayers = [...this.latestState.entities.keys()].filter((id) => isClientKey(id) && !dead.has(id)).length;
    return { alivePlayers, loadedBodies: stats.loadedBodies };
  }

  isPlaybackWeaponLoaded(): boolean {
    return this._demoWvm?.isWeaponModelLoaded ?? false;
  }

  private stopPlaybackLoop(): void {
    if (typeof window === "undefined" || this.playbackRaf === null) return;
    window.cancelAnimationFrame(this.playbackRaf);
    this.playbackRaf = null;
  }

  private refreshHudPlayerList(): void {
    if (!this.demoHud || !this.latestState) return;

    const playersByEntity = new Map<string, string>();
    for (const player of this.latestState.players.values()) {
      playersByEntity.set(player.entityId, player.name || player.entityId);
    }

    const cameraSystem = CameraSystem.getInstance();
    const spectator = cameraSystem.getController("spectator") as {
      getTargetEntityId?: () => string | null;
      setSpectateTarget?: (id: string) => void;
    } | null;
    let currentTarget = spectator?.getTargetEntityId?.() ?? null;

    const rows: Array<{ entityId: string; name: string; isTarget: boolean }> = [];
    for (const [entityId] of this.latestState.entities) {
      if (!isClientKey(entityId)) continue;
      rows.push({
        entityId,
        name: playersByEntity.get(entityId) ?? entityId,
        isTarget: currentTarget === entityId,
      });
    }

    rows.sort((a, b) => a.name.localeCompare(b.name));
    if (!currentTarget && rows.length > 0) {
      const first = rows[0].entityId;
      this._selectSpectateTarget(first);
      currentTarget = first;
      for (const row of rows) {
        row.isTarget = row.entityId === currentTarget;
      }
    }
    this.demoHud.setPlayerList(rows);
  }

  private async ensureCinematicControllers(cameraSystem: CameraSystem): Promise<void> {
    if (!cameraSystem.getController("freefly")) {
      const { FreeflyController } = await import("../../../engine/camera/controllers/FreeflyController");
      cameraSystem.registerController("freefly", new FreeflyController());
    }

    const spectatorProvider = (entityId: string) => {
      const state = this.latestState;
      if (!state) return null;
      const entity = state.entities.get(entityId);
      const transform = entity?.getComponent("transform") as
        | {
            position?: { x: number; y: number; z: number };
            rotation?: { x?: number; y?: number };
          }
        | undefined;
      if (!transform?.position) return null;

      const sampled = this.remoteRenderer?.getDemoEntitySample(entityId);
      const pose = this._followed.presentation;
      const pov = pose?.entityId === entityId ? pose : null;

      return {
        x: sampled?.x ?? transform.position.x,
        y: sampled?.y ?? transform.position.y,
        z: sampled?.z ?? transform.position.z,
        yaw: sampled?.yaw ?? transform.rotation?.y ?? 0,
        pitch: transform.rotation?.x ?? 0,
        eyeHeight: pov?.eyeHeight,
        bobRight: pov?.cameraBobRight,
        bobUp: pov?.cameraBobUp,
        pitchOffsetDegrees: pov?.cameraPitchDegrees,
        rollDegrees: pov?.cameraRollDegrees,
        // DemoEntityTimeline already supplies the interpolated base pose. Extra
        // render-time smoothing would add lag and keep moving while paused.
        snapToTarget: !!sampled,
      };
    };

    if (!cameraSystem.getController("spectator")) {
      const { SpectatorController } = await import("../../../engine/camera/controllers/SpectatorController");
      const spectator = new SpectatorController();
      spectator.setTargetProvider(spectatorProvider);
      cameraSystem.registerController("spectator", spectator);
      return;
    }

    const existingSpectator = cameraSystem.getController("spectator") as {
      setTargetProvider?: (provider: (entityId: string) => unknown) => void;
    } | null;
    existingSpectator?.setTargetProvider?.(spectatorProvider);
  }

  // ── Weapon viewmodel helpers (demo spectator mode) ────────────────────────

  /**
   * Ensure the demo's OWN WeaponViewManager instance exists, bound to the
   * spectator camera, so the POV weapon renders. This never touches the live
   * instance (QA-8): the demo viewmodel is constructed fresh against the
   * spectator camera and disposed wholesale when playback stops.
   */
  private _attachWeaponViewToSpectatorCam(): void {
    const cam = CameraSystem.getInstance();
    const spectatorCtrl = cam.getController("spectator") as {
      getCamera?: () => import("@babylonjs/core/Cameras/freeCamera").FreeCamera | null;
    } | null;
    const spectatorCam = spectatorCtrl?.getCamera?.();
    if (!spectatorCam) return;
    if (!this._demoWvm) {
      const scene = spectatorCam.getScene();
      if (!scene) return;
      this._demoWvm = new WeaponViewManager();
      this._demoWvm.init(scene, spectatorCam);
    }
    this._demoWvm.setVisible(!this._followed.isDead);
  }

  private _isDemoEntityDead(entityId: string): boolean {
    for (const event of this.latestState?.events ?? []) {
      if (event.type === "combat_state" && event.entityId === entityId) {
        return !!(event as { dead?: boolean }).dead;
      }
    }
    return false;
  }

  /**
   * combat_state is emitted on every full demo frame, so it is the persistent
   * source of truth for death/respawn reconstruction after seeks.
   */
  private _updateDemoLifeState(state: GameState): void {
    for (const event of state.events) {
      if (event.type !== "combat_state" || !event.entityId) continue;
      const dead = !!(event as { dead?: boolean }).dead;
      if (dead) {
        this.remoteRenderer?.markDead(event.entityId);
      } else {
        this.remoteRenderer?.markAlive(event.entityId);
      }
      if (event.entityId !== this._followedEntityId) continue;
      this._followed.setDead(dead);
    }
  }

  /**
   * Feed the demo HUD the followed player's live stats (health/armor/weapon/ammo)
   * from the per-frame combat_state + weapon_state events.
   */
  private _updateDemoHud(state: GameState): void {
    if (!this.demoHud) return;
    if (!this._followedEntityId) {
      this.demoHud.setSpectatorStats(null);
      return;
    }
    for (const event of state.events) {
      if (event.entityId !== this._followedEntityId) continue;
      if (event.type === "combat_state") {
        this._specHealth = (event as { health?: number }).health ?? this._specHealth;
        this._specArmor = (event as { armor?: number }).armor ?? this._specArmor;
      } else if (event.type === "weapon_state") {
        const we = event as { currentWeapon?: string; ammo?: Record<string, unknown> };
        this._specWeapon = we.currentWeapon ?? this._specWeapon;
        this._specAmmo = this._formatAmmo(we.ammo?.[this._specWeapon]);
      }
    }
    let name = this._followedEntityId;
    for (const player of state.players.values()) {
      if (player.entityId === this._followedEntityId) {
        name = player.name || this._followedEntityId;
        break;
      }
    }
    this.demoHud.setSpectatorStats({
      name,
      health: this._specHealth,
      armor: this._specArmor,
      weapon: this._specWeapon,
      ammo: this._specAmmo,
    });
  }

  /**
   * Replay this frame's combat events as visuals: weapon fire (hitscan tracers /
   * beams / pellets / blade slash), chain lightning, and projectile impacts.
   * Reuses the same effect singletons + fire handler as live play.
   */
  private _processDemoEffects(state: GameState): void {
    for (const event of state.events) {
      if (event.type === "chat") {
        // Replay recorded chat at its original tick (chat lands in demos via
        // the shared snapshot instance — see docs/research/ingame-chat.md).
        const e = event as unknown as { senderName?: string; team?: string; text?: string };
        const prefix = e.team === "spectator" ? "[SPEC] " : "";
        this._addDemoEvent("chat", `${prefix}${e.senderName || "unknown"}: ${String(e.text ?? "")}`, 8000);
      } else if (event.type === "weapon_fire") {
        playWeaponFireSound(event as WeaponFireEvent, event.entityId === this._followedEntityId);
        handleRemoteWeaponFire(event as WeaponFireEvent, this.remoteRenderer);
      } else if (event.type === "voltaic_beam") {
        handleVoltaicBeam(
          event as VoltaicBeamEvent,
          false,
          this.remoteRenderer?.getKnownWeaponId(event.entityId) ?? undefined,
        );
      } else if (event.type === "death") {
        playPlayerDeathSound(event as DeathEvent, event.entityId === this._followedEntityId);
        if (event.killerId === this._followedEntityId && event.entityId !== this._followedEntityId) playKillEcho();
        // Immediate edge for older demos; persistent combat_state above remains
        // authoritative for seeks and respawns.
        if (event.entityId) {
          this.remoteRenderer?.markDead(event.entityId);
          if (event.entityId === this._followedEntityId) this._followed.setDead(true);
        }
        const victim = this._resolveDemoPlayerName(event.entityId, state);
        const killer = this._resolveDemoPlayerName(event.killerId, state);
        if (killer && victim && event.killerId !== event.entityId) {
          this._addDemoEvent("kill", `${killer} eliminated ${victim}`, 5000);
        }
        if (Number.isFinite(event.x) && Number.isFinite(event.y) && Number.isFinite(event.z)) {
          this.demoGibs?.spawn(event.x, event.y, event.z, event.velX || 0, event.velY || 0, event.velZ || 0);
        }
      } else if (event.type === "damage") {
        playPlayerPainSound(event as DamageEvent, event.entityId === this._followedEntityId);
        if (
          event.attackerId === this._followedEntityId &&
          event.damage > 0 &&
          Number.isFinite(event.x) &&
          Number.isFinite(event.y) &&
          Number.isFinite(event.z)
        ) {
          playDamageConfirmationSound(event as DamageEvent);
          this.demoDamageNumbers?.spawn(event.x, event.y, event.z, event.damage, event.hitLocation);
        }
        if (event.entityId === this._followedEntityId && event.damage > 0) {
          this._addDemoEvent("damage", `-${Math.round(event.damage)}`, 700);
        }
      } else if (event.type === "award") {
        const awardType = String(event.awardType || "")
          .replace(/_/g, " ")
          .toUpperCase();
        const playerName = String(event.playerName || this._resolveDemoPlayerName(event.playerId, state) || "PLAYER");
        if (awardType !== "FRAG") {
          this._addDemoEvent("award", `${playerName}: ${awardType}`, 5000);
        }
        if (this._isAwardForFollowedPlayer(event, state)) {
          const target = event.targetName ? ` - ${event.targetName}` : "";
          this._addDemoEvent("banner", `${awardType}${target}`, 3000);
        }
      } else if (event.type === "weapon_charge") {
        if (event.charging && event.entityId) {
          this.chargingPlayers.add(event.entityId);
        } else if (event.entityId) {
          this.chargingPlayers.delete(event.entityId);
          const chargeGlow = this.chargingGlows.get(event.entityId);
          if (chargeGlow) disposeClusteredLight(chargeGlow);
          this.chargingGlows.delete(event.entityId);
        }
      } else if (event.type === "weapon_drop") {
        if (event.entityId) {
          this.droppedWeaponRenderer?.stashVelocity(
            event.entityId,
            new Vector3(event.velX || 0, event.velY || 0, event.velZ || 0),
          );
        }
      } else if (event.type === "pickup_notify" && event.entityId === this._followedEntityId) {
        const label = String(event.label || "PICKUP");
        playPickupSound(label);
        this._addDemoEvent("pickup", label, 1800);
      } else if (event.type === "projectile_spawn") {
        const e = event as unknown as { entityId?: string; defId?: string };
        if (e.entityId && e.defId) this._projectiles.defIds.set(e.entityId, e.defId);
      } else if (event.type === "weapon_chain") {
        const fx = getHitscanEffects();
        const pts = ((event as { points?: Array<{ x: number; y: number; z: number }> }).points ?? []).map(
          (p) => new Vector3(p.x, p.y, p.z),
        );
        const rgb = WEAPON_EFFECT_COLORS.voltaic;
        const color = new Color3(rgb[0], rgb[1], rgb[2]);
        for (let i = 0; i < pts.length - 1; i++) {
          fx.fireLightningArc(pts[i], pts[i + 1], color);
        }
      } else if (event.type === "projectile_impact") {
        const e = event as unknown as {
          x: number;
          y: number;
          z: number;
          normalX: number;
          normalY: number;
          normalZ: number;
          defId: string;
        };
        const pos = new Vector3(e.x, e.y, e.z);
        playProjectileImpactSound(event as ProjectileImpactEvent);
        const normal = new Vector3(e.normalX, e.normalY, e.normalZ);
        const config =
          e.defId === "grenade" || e.defId === "glauncher"
            ? GRENADE_EXPLOSION
            : e.defId === "plasma_bolt" || e.defId === "plasmagun"
              ? PLASMA_EXPLOSION
              : e.defId === "blade_blast"
                ? BLADE_EXPLOSION
                : ROCKET_EXPLOSION;
        getExplosionEffect().spawn(pos, config, normal);
      }
    }
  }

  private _syncDemoPresentationClock(playback: DemoViewerInfo): boolean {
    const tickRate = playback.header?.tickRate ?? 60;
    const discontinuous = this.demoEventTimeline.setClock(playback.playheadTick, tickRate, playback.discontinuityId);

    if (discontinuous) {
      resetFPSMovementAudio();
      clearDemoWorldEffects();
      this.demoGibs?.clear();
      this.demoDamageNumbers?.clear();
      this._clearDemoCharge();
      this._clearDemoProjectiles();
      this.lastEffectTick = playback.playheadTick;
      // The clears above wiped presentation the persistent sync rebuilds —
      // force it to run even if the landing frame has the same tick.
      this.lastPersistentSyncTick = null;
    } else {
      const deltaTicks =
        playback.state === "playing" && this.lastEffectTick !== null
          ? Math.max(0, playback.playheadTick - this.lastEffectTick)
          : 0;
      // Clamp: after a browser stall the playhead can jump seconds at once
      // (frame DELIVERY is capped, the clock is not) — one giant Euler step
      // would teleport gibs through the floor. Cap the visual-effects step.
      const demoDeltaSeconds = Math.min(0.25, deltaTicks / (tickRate > 0 ? tickRate : 60));
      if (demoDeltaSeconds > 0) {
        this.demoGibs?.update(demoDeltaSeconds);
        this.demoDamageNumbers?.update(demoDeltaSeconds);
      }
      this.lastEffectTick = playback.playheadTick;
    }

    return discontinuous;
  }

  /** Push the playback clock to the renderer — the single site for this tuple
   *  (previously duplicated in the delivery callback and the render loop). */
  private _pushPlaybackClock(playback: DemoViewerInfo): void {
    this.remoteRenderer?.setDemoPlaybackState(
      playback.playheadTick,
      playback.playbackSpeed,
      playback.state !== "playing",
      playback.discontinuityId,
      playback.header?.tickRate ?? 60,
    );
  }

  /** Rebuild presentation whose source of truth exists in every delivered state. */
  private _syncPersistentDemoState(state: GameState): void {
    if (state.tick === this.lastPersistentSyncTick) return; // same recorded state
    this.lastPersistentSyncTick = state.tick;

    FPSPickup.reconcileActiveSet(state.pickupActiveMask);

    const itemEntities = new Map<string, DroppedWeaponInfo>();
    for (const [id, entity] of state.entities) {
      if (!id.startsWith("item_")) continue;
      const transform = entity.getComponent("transform") as
        | { position?: { x: number; y: number; z: number } }
        | undefined;
      const weaponMeta = entity.getComponent("weaponMeta") as { weaponId?: string; settled?: boolean } | undefined;
      if (!transform?.position) continue;
      itemEntities.set(id, {
        x: transform.position.x,
        y: transform.position.y,
        z: transform.position.z,
        weaponId: weaponMeta?.weaponId,
        settled: weaponMeta?.settled ?? false,
      });
    }
    this.droppedWeaponRenderer?.syncServerEntities(itemEntities);
    this._updateDemoChargeGlows(state);
  }

  private _updateDemoChargeGlows(state: GameState): void {
    for (const [entityId, glow] of this.chargingGlows) {
      if (!this.chargingPlayers.has(entityId) || !state.entities.has(entityId)) {
        disposeClusteredLight(glow);
        this.chargingGlows.delete(entityId);
      }
    }

    const scene = CameraSystem.getInstance().getCamera()?.getScene();
    if (!scene) return;
    let slots = 0;
    for (const entityId of this.chargingPlayers) {
      const entity = state.entities.get(entityId);
      const transform = entity?.getComponent("transform") as
        | { position?: { x: number; y: number; z: number } }
        | undefined;
      const position = transform?.position;
      // Cluster-rendered (WS1) — the slot cap is a sanity budget, not a shader limit.
      if (!position || slots++ >= 6) {
        const overflow = this.chargingGlows.get(entityId);
        if (overflow) disposeClusteredLight(overflow);
        this.chargingGlows.delete(entityId);
        continue;
      }
      let glow = this.chargingGlows.get(entityId);
      if (!glow) {
        glow = new PointLight(`demo_charge_glow_${entityId}`, Vector3.Zero(), scene);
        glow.diffuse = new Color3(1, 0.15, 0.05);
        glow.specular = new Color3(1, 0.1, 0);
        glow.range = 60;
        glow.intensity = 8;
        addToDynamicLightCluster(scene, glow);
        this.chargingGlows.set(entityId, glow);
      }
      glow.position.set(position.x, position.y + 30, position.z);
    }
  }

  private _clearDemoCharge(): void {
    for (const glow of this.chargingGlows.values()) disposeClusteredLight(glow);
    this.chargingGlows.clear();
    this.chargingPlayers.clear();
  }

  private _addDemoEvent(kind: Parameters<DemoEventTimeline["push"]>[0], text: string, durationMs: number): void {
    if (this.demoEventOverlay) {
      this.demoEventOverlay.add(kind, text, durationMs);
    } else {
      this.demoEventTimeline.push(kind, text, durationMs);
    }
  }

  private _resolveDemoPlayerName(entityId: unknown, state: GameState): string {
    if (typeof entityId !== "string" || !entityId) return "";
    for (const player of state.players.values()) {
      if (player.entityId === entityId) return player.name || entityId;
    }
    return entityId.replace(/^player_/, "player ");
  }

  private _isAwardForFollowedPlayer(event: Record<string, unknown>, state: GameState): boolean {
    if (!this._followedEntityId) return false;
    if (event.playerId === this._followedEntityId) return true;
    const followedName = this._resolveDemoPlayerName(this._followedEntityId, state);
    return typeof event.playerName === "string" && event.playerName === followedName;
  }

  /**
   * Sample interpolated positions for active in-flight projectiles and push them
   * to the ProjectileManager visuals, whose own per-frame tick animates them
   * and draws their trails.
   */
  private _renderDemoProjectiles(): void {
    if (this._projectiles.active.size === 0) return;
    const projMgr = getProjectileManager();
    for (const id of this._projectiles.active) {
      const interp = this._projectiles.buffer.sample(id);
      if (!interp) continue;
      projMgr.updateServerPosition(
        id,
        new Vector3(interp.x, interp.y, interp.z),
        new Vector3(interp.vx, interp.vy, interp.vz),
      );
    }
  }

  /** Despawn all demo projectile visuals and reset their sync state. */
  private _clearDemoProjectiles(): void {
    const projMgr = getProjectileManager();
    for (const id of this._projectiles.active) {
      projMgr.despawnByEntityId(id);
    }
    this._projectiles.active.clear();
    this._projectiles.defIds.clear();
    this._projectiles.seenTicks.clear();
    this._projectiles.buffer.reset();
  }

  /** Format a weapon's ammo value ({clip,reserve} or number) for the HUD. */
  private _formatAmmo(ammo: unknown): string {
    if (ammo && typeof ammo === "object") {
      const a = ammo as { clip?: number; reserve?: number };
      if (a.clip !== undefined || a.reserve !== undefined) return `${a.clip ?? 0} / ${a.reserve ?? 0}`;
    }
    if (typeof ammo === "number") return String(ammo);
    return "";
  }

  /**
   * Populate the entityId → currentWeapon map from per-frame weapon_state events
   * so RemotePlayerRenderer can attach the correct 3rd-person weapon model.
   */
  private _updateEnemyWeapons(state: GameState): void {
    for (const event of state.events) {
      if (event.type !== "weapon_state") continue;
      const weapon = (event as { entityId?: string; currentWeapon?: string }).currentWeapon;
      const entityId = (event as { entityId?: string }).entityId;
      if (entityId && weapon) this._enemyWeapons.set(entityId, weapon);
    }
  }

  /**
   * Put the followed player's weapon in the viewmodel: a cut during seeks,
   * the switch animation during normal play.
   */
  private _updateDemoWeapon(state: GameState, discontinuous = false): void {
    if (!this._followedEntityId) return;
    for (const event of state.events) {
      if (event.type !== "weapon_state") continue;
      if (event.entityId !== this._followedEntityId) continue;
      this._followed.showWeapon(event.currentWeapon as string, this._isSeeking || discontinuous);
      return;
    }
  }

  /** Flash and kick the viewmodel on weapon_fire events for the followed player. */
  private _updateDemoRecoil(state: GameState): void {
    if (!this._followedEntityId) return;
    for (const event of state.events) {
      if (event.type !== "weapon_fire") continue;
      if (event.entityId !== this._followedEntityId) continue;
      this._followed.fired();
    }
  }

  /**
   * Reconstruct followed-player camera and viewmodel motion from the canonical
   * demo playhead. Cinematic chase paths can change the spectator target
   * directly, so synchronize service ownership before sampling.
   */
  private _updateDemoPov(playback: DemoViewerInfo): void {
    const spectator = CameraSystem.getInstance().getController("spectator") as {
      getTargetEntityId?: () => string | null;
    } | null;
    const cameraTarget = spectator?.getTargetEntityId?.() ?? null;
    if (cameraTarget && cameraTarget !== this._followedEntityId) {
      this._selectSpectateTarget(cameraTarget);
    }

    if (!this._followedEntityId || !this.remoteRenderer) return;
    const sample = this.remoteRenderer.getDemoEntitySample(this._followedEntityId);
    if (!sample) return;

    this._followed.updateMotion(sample, {
      playheadTick: playback.playheadTick,
      tickRate: playback.header?.tickRate ?? 60,
      paused: playback.state !== "playing",
      discontinuityId: playback.discontinuityId,
    });
  }

  // ── Demo list helpers ──────────────────────────────────────────────────────

  /**
   * Request demo list via LobbyClient, wait for the response.
   * Times out after 5 seconds.
   */
  requestDemoList(filter?: string): Promise<DemoInfo[]> {
    const client = this.lobbyClient;
    if (!client) {
      return Promise.reject(new Error("Not connected to lobby. Use 'connect' first."));
    }

    return new Promise<DemoInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error("Timeout waiting for demo list from lobby server."));
      }, 5000);

      const unsub = client.once("demos:list_response", (msg: { demos: DemoInfo[] }) => {
        clearTimeout(timer);
        let demos = msg.demos ?? [];
        if (filter) {
          const f = filter.toLowerCase();
          demos = demos.filter(
            (d) => d.map.toLowerCase().includes(f) || d.players.some((p) => p.toLowerCase().includes(f)),
          );
        }
        this.cachedDemoList = demos;
        resolve(demos);
      });

      client.requestDemoList(64);
    });
  }

  /**
   * Format a DemoInfo[] as a console table string.
   */
  static formatDemoTable(demos: DemoInfo[]): string {
    if (demos.length === 0) return "No demos found.";

    const lines: string[] = [
      `#    MAP              TYPE   PLAYERS                          DURATION  DATE`,
      "─".repeat(80),
    ];

    demos.forEach((d, i) => {
      const num = String(i + 1).padStart(3);
      const map = d.map.padEnd(16);
      const type = d.gametype.padEnd(6);
      const players = d.players.join(", ").slice(0, 32).padEnd(32);
      const durationSec = Math.round(d.durationMs / 1000);
      const mm = Math.floor(durationSec / 60);
      const ss = String(durationSec % 60).padStart(2, "0");
      const dur = `${mm}:${ss}`;
      const date = new Date(d.date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      lines.push(`${num}  ${map}  ${type}  ${players}  ${dur.padEnd(9)}  ${date}`);
    });

    return lines.join("\n");
  }
}

/**
 * Tracers, bullet holes and explosions are shared with live play and tick on
 * their own. A seek lands somewhere else in the demo and a stop leaves it, so
 * neither may keep the ones already on screen (D10).
 */
function clearDemoWorldEffects(): void {
  getHitscanEffects().clear();
  getExplosionEffect().clear();
}
