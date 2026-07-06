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

import { CameraSystem } from "../../../engine/camera/CameraSystem";
import type { GameState } from "../../../engine/network/core/GameState";
import { WeaponViewManager } from "../../../engine/weapon/WeaponViewManager";
import type { LobbyClient } from "../../../lobby/LobbyClient";
import type { DemoInfo } from "../../../lobby/types";
import { DemoAnalyzer } from "../../../shared/demo/DemoAnalyzer";
import { normalizeDemoMapName } from "../../../shared/demo/DemoMapName";
import { DemoReader } from "../../../shared/demo/DemoReader";
import { CinematicDemoPlayer } from "./CinematicDemoPlayer";
import type { DemoViewer } from "./DemoViewer";
import type { DemoViewerHUD } from "./DemoViewerHUD";
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
  private playbackRaf: number | null = null;
  private lastFrameTimeMs: number = 0;
  private latestState: GameState | null = null;

  // Demo spectator state
  private _followedEntityId: string | null = null;
  private _lastDemoWeapon: string | null = null;
  private _isSeeking = false;
  /** entityId → currentWeapon, fed to RemotePlayerRenderer for 3rd-person weapon models */
  private _enemyWeapons: Map<string, string> = new Map();

  // Followed-player HUD stats (health/armor/weapon/ammo)
  private _specHealth = 0;
  private _specArmor = 0;
  private _specWeapon = "";
  private _specAmmo = "";

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
  async loadAndPlayNormal(viewer: DemoViewer): Promise<void> {
    if (!this.loadedDemoData) throw new Error("No demo loaded. Use `demo <filename>` first.");

    // 1. Own the scene: stop any live game + any prior demo playback.
    await this.teardownLiveSession();
    this.stopAll();

    // 2. Register demo controllers + take a deterministic camera before load.
    const cameraSystem = CameraSystem.getInstance();
    await this.ensureCinematicControllers(cameraSystem);
    this.beginDemoCamera(cameraSystem);

    // 3. Render the recorded map locally (no server).
    await this.ensureDemoMapLoaded();

    // 4. Wire the frame callback → renderer/HUD, then play.
    this.activeDemoViewer = viewer;
    await this.ensureRuntimeWiring(viewer);
    await viewer.load(this.loadedDemoData);
    viewer.play();
    this.startPlaybackLoop();
  }

  // ── Cinematic playback ─────────────────────────────────────────────────────

  /**
   * Start cinematic highlight reel.
   * viewer + cameraSystem are injected so callers control the rendering context.
   */
  async loadAndPlayCinematic(viewer: DemoViewer, cameraSystem: CameraSystem, durationMinutes: number): Promise<void> {
    if (!this.loadedDemoData) throw new Error("No demo loaded. Use `demo <filename>` first.");

    // 1. Own the scene: stop any live game + any prior demo playback.
    await this.teardownLiveSession();
    this.stopAll();

    // 2. Register demo controllers + take a deterministic camera before load.
    await this.ensureCinematicControllers(cameraSystem);
    this.beginDemoCamera(cameraSystem);

    // 3. Render the recorded map locally (no server).
    await this.ensureDemoMapLoaded();

    // 4. Wire the frame callback, then start the cinematic player.
    this.activeDemoViewer = viewer;
    await this.ensureRuntimeWiring(viewer);
    const player = new CinematicDemoPlayer(viewer, cameraSystem);
    this.activeCinematicPlayer = player;
    await player.loadAndPlay(this.loadedDemoData, durationMinutes);
    this.startPlaybackLoop();
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

  stopAll(): void {
    this.stopPlaybackLoop();
    this.activeCinematicPlayer?.dispose();
    this.activeCinematicPlayer = null;

    this.activeDemoViewer?.pause();
    this.activeDemoViewer?.dispose();
    this.activeDemoViewer = null;

    this.remoteRenderer?.dispose();
    this.remoteRenderer = null;

    this.demoHud?.dispose();
    this.demoHud = null;

    this.latestState = null;
    this._followedEntityId = null;
    this._lastDemoWeapon = null;
    this._isSeeking = false;
    this._enemyWeapons.clear();
    this._specHealth = 0;
    this._specArmor = 0;
    this._specWeapon = "";
    this._specAmmo = "";

    const wvm = WeaponViewManager.getInstance();
    if (wvm.isInitialized()) {
      wvm.setVisible(false);
      wvm.restoreToFPSCamera();
    }
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

  private async ensureRuntimeWiring(viewer: DemoViewer): Promise<void> {
    const camera = CameraSystem.getInstance().getCamera();
    const scene = camera?.getScene();
    if (!scene) {
      throw new Error("No active scene available for demo playback.");
    }

    const { RemotePlayerRenderer } = await import("./RemotePlayerRenderer");
    this.remoteRenderer = new RemotePlayerRenderer(scene);
    // Feed 3rd-person weapon models. In live play GameEvents populates this map;
    // in demo playback we own it and fill it from weapon_state events per frame.
    this.remoteRenderer.setEnemyWeapons(this._enemyWeapons);

    viewer.onFrame((state) => {
      this.latestState = state;
      this._updateEnemyWeapons(state);
      this.remoteRenderer?.pushSnapshot(state, "");
      this.refreshHudPlayerList();
      this._updateDemoWeapon(state);
      this._updateDemoRecoil(state);
      this._updateDemoHud(state);
    });

    if (typeof document === "undefined") return;
    const { DemoViewerHUD } = await import("./DemoViewerHUD");
    this.demoHud = new DemoViewerHUD();
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
      type?: string;
    } | null;
    spectator?.setSpectateTarget?.(entityId);
    // Only trigger full attach/detach if not already in spectator mode
    if ((cam.getActiveController() as { type?: string } | null)?.type !== "spectator") {
      cam.setController("spectator");
    }
    this._followedEntityId = entityId;
    this._lastDemoWeapon = null;
    this.remoteRenderer?.setHiddenEntity(entityId);
    this._attachWeaponViewToSpectatorCam();
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

      this.activeDemoViewer.update(deltaMs);
      this.activeCinematicPlayer?.update(deltaMs);
      this.remoteRenderer?.render();
      this.demoHud?.update(this.activeDemoViewer.getInfo());

      this.playbackRaf = window.requestAnimationFrame(tick);
    };

    this.playbackRaf = window.requestAnimationFrame(tick);
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
      if (!entityId.startsWith("player_")) continue;
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

      return {
        x: transform.position.x,
        y: transform.position.y,
        z: transform.position.z,
        yaw: transform.rotation?.y ?? 0,
        pitch: transform.rotation?.x ?? 0,
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
   * Attach WeaponViewManager to the spectator camera so the POV weapon renders.
   * Cold-start demos (no prior live FPS session) have an uninitialized WVM — we
   * initialize it against the spectator camera + scene here so the viewmodel
   * shows even when the demo is the first thing loaded this session.
   */
  private _attachWeaponViewToSpectatorCam(): void {
    const cam = CameraSystem.getInstance();
    const spectatorCtrl = cam.getController("spectator") as {
      getCamera?: () => import("@babylonjs/core/Cameras/freeCamera").FreeCamera | null;
    } | null;
    const spectatorCam = spectatorCtrl?.getCamera?.();
    if (!spectatorCam) return;
    const wvm = WeaponViewManager.getInstance();
    if (!wvm.isInitialized()) {
      const scene = spectatorCam.getScene();
      if (scene) wvm.init(scene, spectatorCam);
    }
    if (!wvm.isInitialized()) return;
    wvm.attachToCamera(spectatorCam);
    wvm.setVisible(true);
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
   * Check for weapon changes on the followed entity and load/switch the viewmodel.
   * Uses instant loadWeapon during seeks, animated switchWeaponAnimated during normal play.
   */
  private _updateDemoWeapon(state: GameState): void {
    if (!this._followedEntityId) return;
    const wvm = WeaponViewManager.getInstance();
    if (!wvm.isInitialized()) return;
    for (const event of state.events) {
      if (event.type !== "weapon_state") continue;
      if (event.entityId !== this._followedEntityId) continue;
      const weapon = event.currentWeapon as string;
      if (weapon === this._lastDemoWeapon) return;
      this._lastDemoWeapon = weapon;
      if (this._isSeeking) {
        wvm.loadWeapon(weapon).catch(() => {});
      } else {
        wvm.switchWeaponAnimated(weapon).catch(() => {});
      }
      return;
    }
  }

  /**
   * Trigger recoil on weapon_fire events and feed velocity into weapon bob each frame.
   */
  private _updateDemoRecoil(state: GameState): void {
    if (!this._followedEntityId) return;
    const wvm = WeaponViewManager.getInstance();
    if (!wvm.isInitialized()) return;
    for (const event of state.events) {
      if (event.type !== "weapon_fire") continue;
      if (event.entityId !== this._followedEntityId) continue;
      wvm.triggerRecoil(1.0);
    }
    // Weapon bob from entity velocity
    const entity = state.entities.get(this._followedEntityId);
    const velocity = entity?.getComponent("velocity") as
      | { linear?: { x: number; y: number; z: number }; x?: number; y?: number; z?: number }
      | undefined;
    if (velocity) {
      const v = velocity.linear ?? velocity;
      const hSpeed = Math.sqrt(((v.x ?? 0) ** 2) + ((v.z ?? 0) ** 2));
      wvm.updateBob(hSpeed, v.y ?? 0);
    }
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
