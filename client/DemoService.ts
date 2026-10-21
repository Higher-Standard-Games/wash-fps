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

import { Ray } from "@babylonjs/core/Culling/ray";
import type { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { AudioManager } from "../../../engine/AudioManager";
import { CameraSystem } from "../../../engine/camera/CameraSystem";
import { devLog } from "../../../engine/core/DevLog";
import { EventBus } from "../../../engine/core/EventBus";
import { disposeClusteredLight } from "../../../engine/lighting/DynamicLightCluster";
import { SnapshotBuffer } from "../../../engine/network/client/SnapshotBuffer";
import { InputButtons } from "../../../engine/network/components/InputComponent";
import type { GameState } from "../../../engine/network/core/GameState";
import { mapTitle } from "../../../engine/ui/MapTitles";
import { getExplosionEffect } from "../../../engine/weapon/ExplosionEffect";
import { getHitscanEffects } from "../../../engine/weapon/HitscanEffects";
import { getProjectileManager } from "../../../engine/weapon/ProjectileManager";
import { WeaponViewManager } from "../../../engine/weapon/WeaponViewManager";
import type { LobbyClient } from "../../../lobby/LobbyClient";
import type { DemoInfo } from "../../../lobby/types";
import { SHOT_CONTENT_MASK } from "../../../shared/collision/CollisionWorld";
import { DemoAnalyzer } from "../../../shared/demo/DemoAnalyzer";
import type { RecordedInput } from "../../../shared/demo/DemoInputs";
import { DemoReader } from "../../../shared/demo/DemoReader";
import { isClientKey, toClientKey } from "../ClientEntityKey";
import { CinematicDemoPlayer, type ReelWorld, shotCard } from "./CinematicDemoPlayer";
import { Crosshair } from "./Crosshair";
import { DamageNumbers } from "./DamageNumbers";
import { demoLoadCancelled, downloadDemo } from "./DemoDownload";
import { DemoEventTimeline } from "./DemoEventTimeline";
import { resolveFPSDemoMap } from "./DemoMapAliases";
import { DemoOverlayController } from "./DemoOverlayController";
import { type DemoKeyAction, demoKeyAction, fragSeekTick } from "./DemoPlaybackKeys";
import { watchedEyePose } from "./DemoPovState";
import type { DemoDeath, DemoViewer, DemoViewerInfo } from "./DemoViewer";
import type { DemoTimelineEvent, DemoViewerHUD } from "./DemoViewerHUD";
import { DroppedWeaponRenderer } from "./DroppedWeaponRenderer";
import { FollowedViewWeapon } from "./FollowedViewWeapon";
import { preloadFPSAudio } from "./FPSAudio";
import type { FPSHud } from "./FPSHud";
import { resetFPSMovementAudio } from "./FPSMovementAudio";
import { FPSReloadAudio } from "./FPSReloadAudio";
import { type GameEventContext, handleServerStateUpdate, type ProjectileSyncState } from "./GameEvents";
import { GibSystem } from "./GibSystem";
import { currentClip, HUDState } from "./HUDState";
import { MatchStateManager } from "./MatchStateManager";
import { RagdollSystem } from "./RagdollSystem";
import type { RemotePlayerRenderer } from "./RemotePlayerRenderer";
import { PlayerWeaponStates, storeSnapshotState } from "./SnapshotStateStore";

/** How long a reel holds on black under its title card before the first shot. */
const REEL_TITLE_MS = 2800;

/** Music while watching, and on leaving: a match's, then the menus'. */
const GAME_PLAYLIST = "data/game.playlist.json";
const MENU_PLAYLIST = "data/menu.playlist.json";

/** How far before a frag a click on the timeline lands, to see it coming. */
const TIMELINE_LEAD_SECONDS = 3;

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
  private readonly demoEventTimeline = new DemoEventTimeline();
  private readonly demoReloadAudio = new FPSReloadAudio();
  private readonly demoOverlays = new DemoOverlayController();
  private playbackRaf: number | null = null;
  private lastFrameTimeMs: number = 0;
  private latestState: GameState | null = null;
  private demoGibs: GibSystem | null = null;
  /** Bodies that fall as they did, on the playhead: paused with it, slowed with it. */
  private demoRagdolls: RagdollSystem | null = null;
  /**
   * The scene playback steps physics for, and whether its own stepping was on
   * before: the demo hands Havok the playhead's time instead of the frame's.
   */
  private physicsScene: { scene: Scene; wasEnabled: boolean } | null = null;
  private demoDamageNumbers: DamageNumbers | null = null;
  private droppedWeaponRenderer: DroppedWeaponRenderer | null = null;
  private readonly chargingPlayers = new Set<string>();
  private readonly chargingGlows = new Map<string, PointLight>();
  private lastEffectTick: number | null = null;
  /** The playback keys' listener, while playback has its controls up. */
  private playbackKeys: AbortController | null = null;
  /** The demo's playhead in seconds, as the shared effects age by it. */
  private demoEffectSeconds = 0;
  private readonly demoEffectClock = (): number => this.demoEffectSeconds;

  // Demo spectator state
  private _followedEntityId: string | null = null;
  /** The demo's deaths, once scanned, for the timeline's lane. */
  private _timelineDeaths: DemoDeath[] = [];
  private _timelineScan: AbortController | null = null;
  /** Players holding alt fire (aiming down sights) over the frame on screen. */
  private _aimingEntities = new Set<string>();
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
  /** entityId → currentWeapon, fed to RemotePlayerRenderer for 3rd-person weapon models */
  private _enemyWeapons: Map<string, string> = new Map();

  /** In-flight server projectile visuals (rockets/plasma/grenades mid-air) */
  /** The game's HUD over normal playback, watching; null otherwise. */
  private gameHud: FPSHud | null = null;
  private gameHudVisible = true;
  /** Where leaving playback goes: back to the page that started it. */
  private exitHandler: (() => void) | null = null;
  /** The game's event context over playback's own systems; built with them. */
  private eventCtx: GameEventContext | null = null;
  /** Every player's weapon, as the game keeps it. */
  private readonly demoWeapons = new PlayerWeaponStates();

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
  private loadGeneration = 0;
  private loadController: AbortController | null = null;

  /** A newer source/stop owns loading; fully playing demos keep running meanwhile. */
  private beginLoad(): { generation: number; controller: AbortController } {
    this.cancelPendingLoad();
    const controller = new AbortController();
    this.loadController = controller;
    return { generation: this.loadGeneration, controller };
  }

  /** Cancel file loading or startup without touching a live game's view. */
  cancelPendingLoad(): void {
    this.loadController?.abort(demoLoadCancelled());
    this.loadController = null;
    this.loadGeneration++;
    this.startGeneration++;
  }

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
  async fetchAndLoad(filename: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    if (options.signal?.aborted) throw demoLoadCancelled();
    const request = this.beginLoad();
    const cancel = () => request.controller.abort(demoLoadCancelled());
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
      const data = await downloadDemo(`${DemoService.demoBaseUrl()}/${filename}`, request.controller.signal);
      return await this._loadData(
        data,
        filename,
        () => request.generation === this.loadGeneration && !request.controller.signal.aborted,
      );
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      if (this.loadController === request.controller) this.loadController = null;
    }
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
    const request = this.beginLoad();
    try {
      return await this._loadData(
        data,
        label,
        () => request.generation === this.loadGeneration && !request.controller.signal.aborted,
      );
    } finally {
      if (this.loadController === request.controller) this.loadController = null;
    }
  }

  private async _loadData(data: Uint8Array, label: string, ownsLoad: () => boolean): Promise<string> {
    if (!ownsLoad()) throw demoLoadCancelled();
    const reader = await DemoReader.fromFile(data);
    if (!ownsLoad()) throw demoLoadCancelled();

    // Validate HERE (file-load time) rather than at playback start — starting
    // playback tears down any live session before DemoViewer.load() would
    // reject a legacy header, kicking the player out of a match for nothing.
    const probe = reader.readHeader();
    if (!probe.tickRate || probe.tickRate <= 0) {
      throw new Error(`${label}: legacy demo (no tickRate in header) — re-record with a current server.`);
    }

    const header = reader.readHeader();
    const index = reader.readIndex();
    const durationSec = Math.round(index.durationMs / 1000);
    const mm = Math.floor(durationSec / 60);
    const ss = String(durationSec % 60).padStart(2, "0");
    // Commit only a completely validated, still-owned recording.
    this.loadedDemoData = data;
    this.loadedDemoReader = reader;
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
    const data = this.loadedDemoData;
    const reader = this.loadedDemoReader;
    const start = ++this.startGeneration;
    return this.runStart(start, viewer, async () => {
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
      await this.ensureDemoMapLoaded(reader);
      if (start !== this.startGeneration) return;

      // 4. Wire the frame callback → renderer/HUD, then play.
      this.activeDemoViewer = viewer;
      await this.ensureRuntimeWiring(viewer, "normal", !options.manual);
      if (this.abandonStart(start, viewer)) return;
      await viewer.load(data);
      if (this.abandonStart(start, viewer)) return;
      viewer.play();
      if (!options.manual) {
        this.startPlaybackLoop();
        this.scanTimelineEvents(viewer);
      }
    });
  }

  /** Find the demo's frags and deaths in the background, then mark them. */
  private scanTimelineEvents(viewer: DemoViewer): void {
    this._timelineScan?.abort();
    const scan = new AbortController();
    this._timelineScan = scan;
    this._timelineDeaths = [];
    void viewer.scanDeaths(scan.signal).then((deaths) => {
      if (!deaths || scan.signal.aborted || this.activeDemoViewer !== viewer) return;
      this._timelineDeaths = deaths;
      this.paintTimelineEvents();
    });
  }

  /**
   * Colour the timeline's frags and deaths from the followed player's side:
   * their frags, their deaths, everyone else's frags. A click seeks to a few
   * seconds before one, to see it coming.
   */
  private paintTimelineEvents(): void {
    const viewer = this.activeDemoViewer;
    if (!this.demoHud || !viewer) return;
    const followed = this._followedEntityId;
    const tickRate = viewer.getInfo().header?.tickRate ?? 60;
    const events: DemoTimelineEvent[] = this._timelineDeaths.map((death) => {
      const kind =
        followed && death.killerId === followed ? "frag" : followed && death.victimId === followed ? "death" : "other";
      return {
        progress: death.progress,
        seekTo: viewer.progressOfTick(death.tick - TIMELINE_LEAD_SECONDS * tickRate),
        kind,
        label: death.killerName ? `${death.killerName} fragged ${death.victimName}` : `${death.victimName} died`,
      };
    });
    this.demoHud.setEvents(events);
  }

  // ── Cinematic playback ─────────────────────────────────────────────────────

  /**
   * Start cinematic highlight reel.
   * viewer + cameraSystem are injected so callers control the rendering context.
   */
  async loadAndPlayCinematic(viewer: DemoViewer, cameraSystem: CameraSystem, durationMinutes: number): Promise<void> {
    if (!this.loadedDemoData) throw new Error("No demo loaded. Use `demo <filename>` first.");
    const data = this.loadedDemoData;
    const reader = this.loadedDemoReader;
    const start = ++this.startGeneration;
    return this.runStart(start, viewer, async () => {
      // 1. Own the scene: stop any live game + any prior demo playback.
      await this.teardownLiveSession();
      if (start !== this.startGeneration) return;
      this.stopForPlaybackTransition();

      // 2. Register demo controllers + take a deterministic camera before load.
      await this.ensureCinematicControllers(cameraSystem);
      if (start !== this.startGeneration) return;
      this.beginDemoCamera(cameraSystem);

      // 3. Render the recorded map locally (no server).
      await this.ensureDemoMapLoaded(reader);
      if (start !== this.startGeneration) return;

      // 4. Wire the frame callback, then start the cinematic player.
      this.activeDemoViewer = viewer;
      await this.ensureRuntimeWiring(viewer, "reel");
      if (this.abandonStart(start, viewer)) return;
      const player = new CinematicDemoPlayer(viewer, cameraSystem, this.reelWorld(), { titleHoldMs: REEL_TITLE_MS });
      this.activeCinematicPlayer = player;
      player.onSegmentChange((segment) => {
        this.demoHud?.showCard(shotCard(segment, player.getReelInfo().totalScenes));
      });
      player.onStateChange((state) => {
        if (state === "ended") this.demoHud?.setEndCard(player.getSummary());
        this.demoHud?.setReelEnded(state === "ended");
      });
      this.demoHud?.onReplay(() => player.replay());
      await player.loadAndPlay(data, durationMinutes);
      if (this.abandonStart(start, viewer)) return;
      const header = viewer.getInfo().header;
      this.demoHud?.setTitle(player.getTitle(header ? mapTitle(header.map) : undefined));
      this.demoHud?.setReel(player.getShotStarts());
      this.startPlaybackLoop();
    });
  }

  /**
   * What a reel reads from the scene: where each player is drawn, and where a
   * line meets solid map. What a shot passes through (water, fog, clip
   * brushes) a camera sees through too.
   */
  private reelWorld(): ReelWorld {
    return {
      positionOf: (entityId) => {
        const sample = this.remoteRenderer?.getDemoEntitySample(entityId);
        return sample ? { x: sample.x, y: sample.y, z: sample.z } : null;
      },
      blockedAt: (from, to) => {
        const scene = CameraSystem.getInstance().getCamera()?.getScene();
        if (!scene) return null;
        const origin = new Vector3(from.x, from.y, from.z);
        const along = new Vector3(to.x - from.x, to.y - from.y, to.z - from.z);
        const length = along.length();
        if (length < 1) return null;
        const hit = scene.pickWithRay(
          new Ray(origin, along.scale(1 / length), length),
          (mesh) =>
            mesh.isPickable &&
            mesh.name.startsWith("bsp_") &&
            ((mesh.metadata?.contentFlags ?? 0) & SHOT_CONTENT_MASK) !== 0,
        );
        return hit?.hit && hit.pickedPoint
          ? { x: hit.pickedPoint.x, y: hit.pickedPoint.y, z: hit.pickedPoint.z }
          : null;
      },
    };
  }

  private async runStart(start: number, viewer: DemoViewer, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      // An obsolete map/wiring failure must not reopen the menu over a newer game.
      if (start !== this.startGeneration) return;
      if (this.activeDemoViewer === viewer) this.stopPlayback();
      throw error;
    }
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
    this.cancelPendingLoad();
    if (this.hasActivePlayback()) this.stopAll();
    else this.startGeneration++;
  }

  /** Stop playback, including a demo start still loading. */
  stopAll(): void {
    this.cancelPendingLoad();
    this.stopPlayback();
  }

  private stopPlayback(): void {
    this.playbackKeys?.abort();
    this.playbackKeys = null;
    this.stopPlaybackLoop();
    this._timelineScan?.abort();
    this._timelineScan = null;
    this._timelineDeaths = [];
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
    this._stopGameHud();
    this.demoHud?.dispose();
    this.demoHud = null;
    this.demoEventTimeline.clear();
    this.demoReloadAudio.reset();
    this.demoGibs?.dispose();
    this.demoRagdolls?.dispose();
    this.demoRagdolls = null;
    if (this.physicsScene) this.physicsScene.scene.physicsEnabled = this.physicsScene.wasEnabled;
    this.physicsScene = null;
    this.demoGibs = null;
    this.demoDamageNumbers?.dispose();
    this.demoDamageNumbers = null;
    this.droppedWeaponRenderer?.dispose();
    this.droppedWeaponRenderer = null;
    this._clearDemoCharge();
    this.lastEffectTick = null;

    this.latestState = null;
    this._followedEntityId = null;
    this._followed.follow(null);
    this._enemyWeapons.clear();
    this._clearDemoProjectiles();
    clearDemoWorldEffects();
    getHitscanEffects().setPresentationClock(null);

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
  private async ensureDemoMapLoaded(reader: DemoReader | null): Promise<void> {
    const header = reader?.readHeader();
    if (!header?.map) return;

    const mapName = resolveFPSDemoMap(header.map);
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
        devLog("[DemoService] Shutting down live game session before demo playback");
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
   *
   * The followed player's body is hidden only behind their eyes. Any other
   * camera, such as a reel's fly-by, sees them from outside, so it draws them.
   */
  private watchCameraController(): void {
    this._unsubCameraChange?.();
    this._unsubCameraChange = EventBus.on<{ type: string }>("camera:controller_changed", ({ type }) => {
      this.applyGameHud();
      if (type === "spectator") {
        if (this._followedEntityId) {
          this.remoteRenderer?.setHiddenEntity(this._followedEntityId);
          this._attachWeaponViewToSpectatorCam();
        }
        return;
      }
      this.remoteRenderer?.setHiddenEntity(null);
      this._demoWvm?.dispose();
      this._demoWvm = null;
    });
  }

  private async ensureRuntimeWiring(viewer: DemoViewer, mode: "normal" | "reel", withHud = true): Promise<void> {
    const camera = CameraSystem.getInstance().getCamera();
    const scene = camera?.getScene();
    if (!scene) {
      throw new Error("No active scene available for demo playback.");
    }
    // A match's music, as in a lobby game; a timedemo (no HUD) measures in silence
    if (withHud) void AudioManager.getInstance().loadPlaylist(GAME_PLAYLIST);

    this.watchCameraController();

    const { RemotePlayerRenderer } = await import("./RemotePlayerRenderer");
    this.remoteRenderer = new RemotePlayerRenderer(scene);
    this.remoteRenderer.enableDemoPlayback();
    this.remoteRenderer.setFollowedMuzzle(() => this._followed.beamMuzzle());
    // Feed 3rd-person weapon models. In live play GameEvents populates this map;
    // in demo playback we own it and fill it from weapon_state events per frame.
    this.remoteRenderer.setEnemyWeapons(this._enemyWeapons);

    // Initialize the shared effect systems against the demo scene so replayed
    // weapon_fire / projectile_impact / weapon_chain events render (these guard
    // on a scene being set and no-op otherwise).
    getHitscanEffects().init(scene);
    // Beams, rails and flashes age on the demo's clock: in a reel's slow motion
    // a lightning beam's updates arrive slowed down too, and on the wall clock
    // it faded out between them
    getHitscanEffects().setPresentationClock(this.demoEffectClock);
    getExplosionEffect().init(scene);
    getProjectileManager().init(scene);
    await preloadFPSAudio();
    resetFPSMovementAudio();
    this.demoGibs = GibSystem.create(scene);
    this.demoRagdolls = RagdollSystem.create(scene);
    // A body that lies long enough bursts, as it does in the game
    this.demoRagdolls.setGibCallback((x, y, z, vx, vy, vz) => this.demoGibs?.spawn(x, y, z, vx, vy, vz));
    this.physicsScene = { scene, wasEnabled: scene.physicsEnabled };
    this.demoDamageNumbers = DamageNumbers.create(scene);
    // Demo playback uses snapshot transforms directly: no wall-clock Havok toss
    // continues while paused, and seek landing reconstructs the exact item set.
    this.droppedWeaponRenderer = new DroppedWeaponRenderer(scene, true);

    this.eventCtx = this._createEventContext();

    viewer.onFrame((state, _tick, inputs) => {
      this.noteAiming(state, inputs);
      this.latestState = state;
      const playback = viewer.getInfo();
      this._syncDemoPresentationClock(playback);
      this._pushPlaybackClock(playback);
      this.remoteRenderer?.pushDemoSnapshot(state, "");
      this.refreshHudPlayerList();
      this._presentFrame(state, this.demoEventTimeline.canPresentOneShots());
      this.demoEventTimeline.finishPresentationFrame();
    });

    if (!withHud || typeof document === "undefined") return;
    // A demo opens on the player's screen; a reel opens in movie mode, the
    // game HUD off and the controls down to a strip.
    this.gameHudVisible = mode === "normal";
    await this._startGameHud();
    const { DemoViewerHUD } = await import("./DemoViewerHUD");
    this.demoHud = new DemoViewerHUD();
    this.demoHud.setReel(mode === "reel" ? [] : null);
    this.demoHud.setMinimized(mode === "reel");
    this.demoOverlays.setNormalHud(this.demoHud);
    this.demoOverlays.bindKeyboard(document);
    this.demoHud.onExit(() => this.exit());
    this.demoHud.onPrev(() => this.activeCinematicPlayer?.prevSegment());
    this.demoHud.onNext(() => this.activeCinematicPlayer?.nextSegment());
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
      // Drop in-flight projectiles before the jump — their spawn events are
      // one-shots that a seek skips, and their positions/buffer are now stale.
      this._clearDemoProjectiles();
      // A reel's timeline is its shots: a point on it is the shot there.
      if (this.activeCinematicPlayer) this.activeCinematicPlayer.skipToProgress(progress);
      else this.activeDemoViewer?.seekToProgress(progress);
      // Collapse the interpolation buffer so models snap to the seeked position
      // instead of interpolating across the discontinuous tick jump.
      this.remoteRenderer?.flushInterpolation();
    });
    this.demoHud.onPlayerSelect((entityId) => {
      this._selectSpectateTarget(entityId);
    });
    this.demoHud.onHudToggle(() => this.setGameHudVisible(!this.gameHudVisible));
    this.demoHud.setGameHudVisible(this.gameHudVisible);
    this.bindPlaybackKeys(document);
  }

  /** The playback keyboard (see DemoPlaybackKeys), until playback stops. */
  private bindPlaybackKeys(target: Document): void {
    this.playbackKeys?.abort();
    this.playbackKeys = new AbortController();
    target.addEventListener(
      "keydown",
      (event) => {
        if (event.repeat && !event.code.startsWith("Arrow") && event.code !== "Comma" && event.code !== "Period")
          return;
        const el = event.target as HTMLElement | null;
        if (el?.closest?.("input, textarea, select, [contenteditable='true'], #console, .console")) return;
        const action = demoKeyAction(event, {
          reel: this.activeCinematicPlayer !== null,
          freeCamera:
            CameraSystem.getInstance().getActiveController()?.type === "freefly" && !this.activeCinematicPlayer,
        });
        if (!action) return;
        event.preventDefault();
        this.runKeyAction(action);
      },
      { signal: this.playbackKeys.signal },
    );
  }

  private runKeyAction(action: DemoKeyAction): void {
    const viewer = this.activeDemoViewer;
    const reel = this.activeCinematicPlayer;
    switch (action.type) {
      case "toggle_pause":
        if (reel) reel.togglePlayPause();
        else viewer?.togglePlayPause();
        return;
      case "shot":
        if (action.step > 0) reel?.nextSegment();
        else reel?.prevSegment();
        return;
      case "seek": {
        if (!viewer) return;
        const info = viewer.getInfo();
        const tickRate = info.header?.tickRate ?? 60;
        this.seekDemo(() => viewer.seekToTick(Math.max(0, info.playheadTick + action.seconds * tickRate)));
        return;
      }
      case "frame": {
        if (!viewer) return;
        viewer.pause();
        const frame = viewer.getInfo().currentFrame + action.step;
        this.seekDemo(() => viewer.seekToFrame(frame));
        return;
      }
      case "speed":
        viewer?.stepSpeed(action.step);
        return;
      case "frag": {
        if (!viewer) return;
        const info = viewer.getInfo();
        const frags = this._timelineDeaths.filter((death) => death.killerId !== null).map((death) => death.tick);
        const tick = fragSeekTick(frags, info.playheadTick, action.step, info.header?.tickRate ?? 60);
        if (tick !== null) this.seekDemo(() => viewer.seekToTick(tick));
        return;
      }
      case "player": {
        const order = this.playerOrder();
        if (order.length === 0) return;
        const at = this._followedEntityId ? order.indexOf(this._followedEntityId) : -1;
        this._selectSpectateTarget(order[(at + action.step + order.length) % order.length]);
        return;
      }
      case "player_at": {
        const entityId = this.playerOrder()[action.index];
        if (entityId) this._selectSpectateTarget(entityId);
        return;
      }
    }
  }

  /** A jump in a whole demo, as the seek bar makes it: no stale shots or smeared models. */
  private seekDemo(seek: () => void): void {
    this._clearDemoProjectiles();
    seek();
    this.remoteRenderer?.flushInterpolation();
  }

  /** The players in the frame on screen, in the player list's order. */
  private playerOrder(): string[] {
    return this.hudPlayerRows().map((row) => row.entityId);
  }

  private hudPlayerRows(): Array<{ entityId: string; name: string }> {
    if (!this.latestState) return [];
    const playersByEntity = new Map<string, string>();
    for (const player of this.latestState.players.values()) {
      playersByEntity.set(player.entityId, player.name || player.entityId);
    }
    const rows: Array<{ entityId: string; name: string }> = [];
    for (const [entityId] of this.latestState.entities) {
      if (isClientKey(entityId)) rows.push({ entityId, name: playersByEntity.get(entityId) ?? entityId });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
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
    this.remoteRenderer?.setPerspectiveEntity(entityId);
    this.paintTimelineEvents();
    this._attachWeaponViewToSpectatorCam();
    // Their gun, HUD and place in the player list come from frames, and a
    // paused demo delivers none: present the frame on screen for them, or the
    // previous player's stay up until playback resumes (D7).
    if (this.latestState) {
      this._presentFrame(this.latestState, false);
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
    // The gun on screen is the demo's own weapon view: give its counter the
    // number the HUD shows, as the live HUD does for the live one.
    this._demoWvm?.setAmmoCount(currentClip(HUDState.getInstance()));
    applyCamera?.();
    this.remoteRenderer?.render();
    this._renderDemoProjectiles();
    this._updateCrosshair();
    if (this.activeCinematicPlayer) {
      const reel = this.activeCinematicPlayer.getReelInfo();
      this.demoHud?.updateReel({
        state: reel.state,
        progress: reel.reelProgress,
        elapsedMs: reel.reelElapsedMs,
        totalMs: reel.reelTotalMs,
        segment: reel.currentScene,
        segments: reel.totalScenes,
        isReplay: reel.isReplay,
        speed: reel.currentSpeed,
      });
      this.demoHud?.setTitleVisible(this.activeCinematicPlayer.isShowingTitle());
      const veil = this.activeCinematicPlayer.getVeil();
      this.demoHud?.setVeil(veil.color, veil.opacity);
    } else {
      this.demoHud?.update(playback);
    }
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
      this.remoteRenderer?.setPerspectiveEntity(null);
      this.paintTimelineEvents();
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

    const cameraSystem = CameraSystem.getInstance();
    const spectator = cameraSystem.getController("spectator") as {
      getTargetEntityId?: () => string | null;
      setSpectateTarget?: (id: string) => void;
    } | null;
    let currentTarget = spectator?.getTargetEntityId?.() ?? null;

    const rows = this.hudPlayerRows().map((row) => ({ ...row, isTarget: currentTarget === row.entityId }));
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

    // The recorded player's screen: the sample they are drawn with, through
    // the same pose live spectating builds. DemoEntityTimeline already
    // interpolates it on the playhead, so a paused demo holds still.
    const spectatorProvider = (entityId: string) => {
      const sample = this.remoteRenderer?.getDemoEntitySample(entityId);
      if (!sample) return null;
      const pov = this._followed.presentation;
      return watchedEyePose(sample, pov?.entityId === entityId ? pov : null);
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
   * The game's own HUD, watching: what the followed player saw on screen.
   * Fed by the same HUD state the game feeds it, through `_presentFrame`.
   */
  private async _startGameHud(): Promise<void> {
    const { FPSHud } = await import("./FPSHud");
    const hud = FPSHud.getInstance();
    await hud.init({ watchOnly: true });
    hud.start();
    this.gameHud = hud;
    Crosshair.getInstance().init();
    this.setGameHudVisible(this.gameHudVisible);
  }

  private _stopGameHud(): void {
    if (!this.gameHud) return;
    this.gameHud.destroy();
    this.gameHud = null;
    Crosshair.getInstance().dispose();
    // The match and HUD state were the demo's; nothing of it outlives playback
    HUDState.destroy();
    MatchStateManager.getInstance().reset();
  }

  /** Switch the game HUD and crosshair over playback on or off. */
  setGameHudVisible(visible: boolean): void {
    this.gameHudVisible = visible;
    this.demoHud?.setGameHudVisible(visible);
    this.applyGameHud();
  }

  /**
   * The HUD is a player's screen, so it shows only from behind their eyes:
   * switched on, and the camera is the first-person one. A reel's fly-by
   * shots go without it whatever the switch says.
   */
  private applyGameHud(): void {
    const firstPerson = this.isFirstPerson();
    if (this.gameHudVisible && firstPerson) this.gameHud?.show();
    else this.gameHud?.hide();
    this.demoHud?.setGameHudAvailable(firstPerson);
  }

  private isFirstPerson(): boolean {
    return CameraSystem.getInstance().getActiveController()?.type === "spectator";
  }

  /**
   * Where leaving playback goes, set by whoever starts it: the Demos page
   * takes its viewer back. Cleared once used or replaced.
   */
  setExitHandler(handler: (() => void) | null): void {
    this.exitHandler = handler;
  }

  /** Leave playback: stop it, and go back to where it was started from. */
  exit(): void {
    const handler = this.exitHandler;
    this.exitHandler = null;
    this.stopAll();
    // Back in the menus: their music again, as on leaving a lobby game
    void AudioManager.getInstance().loadPlaylist(MENU_PLAYLIST);
    handler?.();
  }

  isGameHudVisible(): boolean {
    return this.gameHudVisible;
  }

  /** The crosshair the followed player had: their weapon's, spread by their speed. */
  private _updateCrosshair(): void {
    if (!this.gameHud) return;
    const followed = this._followedEntityId;
    const hud = HUDState.getInstance();
    const sample = followed ? this.remoteRenderer?.getDemoEntitySample(followed) : null;
    const hidden = !this.gameHudVisible || !this.isFirstPerson() || !followed || this._isDemoEntityDead(followed);
    Crosshair.getInstance().updateFromHUD(0, sample ? Math.hypot(sample.vx, sample.vz) : 0, hud, hidden, true, true);
  }

  /**
   * A recorded frame through the game's own snapshot path, with the followed
   * player as the one being watched: the same events, sounds, effects and HUD
   * as live play. Without one-off moments the state still applies — a seek's
   * landing frame, or the frame on screen shown for a newly followed player.
   */
  private _presentFrame(state: GameState, oneShots: boolean): void {
    storeSnapshotState(state, {
      weapons: this.demoWeapons,
      enemyWeapons: this._enemyWeapons,
      localEntityId: undefined,
    });
    const ctx = this.eventCtx;
    if (!ctx) return;
    ctx.spectatingEntityId = this._followedEntityId;
    ctx.presentOneShots = oneShots;
    handleServerStateUpdate(ctx, state);
  }

  /**
   * The game's event context, over demo playback's own systems: its renderer,
   * its followed viewmodel, gibs and hit numbers on the demo clock, and its
   * projectile bookkeeping. Nobody is the local player.
   */
  private _createEventContext(): GameEventContext {
    const projectiles = this._projectiles;
    return {
      localPlayerId: "",
      isNetworkMode: false,
      gameHost: null,
      playback: "demo",
      presentOneShots: true,
      reloadAudio: this.demoReloadAudio,
      damageNumbers: this.demoDamageNumbers ?? undefined,
      v2Client: null,
      remoteRenderer: this.remoteRenderer,
      droppedWeaponRenderer: this.droppedWeaponRenderer,
      _lastServerWeapon: undefined,
      enemyWeapons: this._enemyWeapons,
      _localCharging: false,
      chargingPlayers: this.chargingPlayers,
      chargingGlows: this.chargingGlows,
      serverProjectileDefIds: projectiles.defIds,
      activeServerProjectiles: projectiles.active,
      projectileSeenTicks: projectiles.seenTicks,
      projectileBuffer: projectiles.buffer,
      _isPlayerDead: false,
      isWatcher: true,
      spectatingEntityId: this._followedEntityId,
      followedWeapon: this._followed,
      _respawnRequested: false,
      _respawnCooldownEnd: 0,
      _gibSystem: this.demoGibs,
      _pendingGibSpawns: [],
      _ragdollSystem: this.demoRagdolls,
      _cartoonHit: null,
      _deathCamera: null,
      onStateUpdateCallbacks: [],
      pendingTick: 0,
      _tabReturnFrameSkips: 0,
      _stateUpdateCount: 0,
      sendRequestSpawn: () => {},
    };
  }

  private _syncDemoPresentationClock(playback: DemoViewerInfo): boolean {
    const tickRate = playback.header?.tickRate ?? 60;
    const discontinuous = this.demoEventTimeline.setClock(playback.playheadTick, tickRate, playback.discontinuityId);
    this.demoEffectSeconds = playback.playheadTick / (tickRate > 0 ? tickRate : 60);

    if (discontinuous) {
      this.demoReloadAudio.reset();
      resetFPSMovementAudio();
      clearDemoWorldEffects();
      this.demoGibs?.clear();
      this.demoRagdolls?.disposeAll();
      this.demoDamageNumbers?.clear();
      this._clearDemoCharge();
      this._clearDemoProjectiles();
      this.lastEffectTick = playback.playheadTick;
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
        this.demoRagdolls?.update(demoDeltaSeconds);
        this.stepDemoPhysics(demoDeltaSeconds);
        this.demoDamageNumbers?.update(demoDeltaSeconds);
      }
      this.lastEffectTick = playback.playheadTick;
    }

    return discontinuous;
  }

  /**
   * Step Havok by the playhead's time. The scene would step it by the frame's
   * — a ragdoll kept falling while paused and fell at full speed in slow
   * motion — so its own stepping stays off for the length of playback (it is
   * set again each frame: enabling physics late, on the first ragdoll, turns
   * it back on).
   */
  private stepDemoPhysics(seconds: number): void {
    const held = this.physicsScene;
    if (!held?.scene.getPhysicsEngine()) return;
    held.scene.physicsEnabled = false;
    held.scene._advancePhysicsEngineStep(seconds * 1000);
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

  private _clearDemoCharge(): void {
    for (const glow of this.chargingGlows.values()) disposeClusteredLight(glow);
    this.chargingGlows.clear();
    this.chargingPlayers.clear();
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

  /**
   * Reconstruct followed-player camera and viewmodel motion from the canonical
   * demo playhead. Cinematic chase paths can change the spectator target
   * directly, so synchronize service ownership before sampling.
   */
  /**
   * Who is aiming down sights, from the commands recorded over this frame.
   * A command names its player; the frame's roster names their entity.
   */
  private noteAiming(state: GameState, inputs: readonly RecordedInput[]): void {
    this._aimingEntities.clear();
    for (const input of inputs) {
      if (!(input.buttons & InputButtons.ALT_FIRE)) continue;
      const entityId = state.players.get(toClientKey(input.playerId))?.entityId;
      if (entityId) this._aimingEntities.add(entityId);
    }
  }

  private _updateDemoPov(playback: DemoViewerInfo): void {
    const spectator = CameraSystem.getInstance().getController("spectator") as {
      getTargetEntityId?: () => string | null;
    } | null;
    const cameraTarget = spectator?.getTargetEntityId?.() ?? null;
    if (cameraTarget && cameraTarget !== this._followedEntityId) {
      this._selectSpectateTarget(cameraTarget);
    }

    if (!this._followedEntityId || !this.remoteRenderer) return;
    this._followed.setAiming(this._aimingEntities.has(this._followedEntityId));
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
