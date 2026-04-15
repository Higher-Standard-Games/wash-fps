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
import { CommandRegistry } from "../../../engine/console/CommandRegistry";
import type { GameState } from "../../../engine/network/core/GameState";
import type { LobbyClient } from "../../../lobby/LobbyClient";
import type { DemoInfo } from "../../../lobby/types";
import { DemoAnalyzer } from "../../../shared/demo/DemoAnalyzer";
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
    const response = await fetch(`/data/demos/${filename}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${filename}`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    return this._loadData(data, filename);
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

    await this.ensureDemoMapLoaded();
    this.stopAll();
    this.activeDemoViewer = viewer;
    await this.ensureRuntimeWiring(viewer);
    await this.ensureCinematicControllers(CameraSystem.getInstance());
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

    await this.ensureDemoMapLoaded();
    this.stopAll();
    this.activeDemoViewer = viewer;
    await this.ensureRuntimeWiring(viewer);
    await this.ensureCinematicControllers(cameraSystem);
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
  }

  private async ensureDemoMapLoaded(): Promise<void> {
    const header = this.loadedDemoReader?.readHeader();
    if (!header?.map) return;

    const result = await CommandRegistry.getInstance().execute(`map ${header.map}`);
    if (result && /failed to load map|no scene available|camerasystem not available|unknown command/i.test(result)) {
      throw new Error(result);
    }
  }

  private async ensureRuntimeWiring(viewer: DemoViewer): Promise<void> {
    const camera = CameraSystem.getInstance().getCamera();
    const scene = camera?.getScene();
    if (!scene) {
      throw new Error("No active scene available for demo playback.");
    }

    const { RemotePlayerRenderer } = await import("./RemotePlayerRenderer");
    this.remoteRenderer = new RemotePlayerRenderer(scene);

    viewer.onFrame((state) => {
      this.latestState = state;
      this.remoteRenderer?.pushSnapshot(state, "");
      this.refreshHudPlayerList();
    });

    if (typeof document === "undefined") return;
    const { DemoViewerHUD } = await import("./DemoViewerHUD");
    this.demoHud = new DemoViewerHUD();
    this.demoHud.onSeek((progress) => this.activeDemoViewer?.seekToProgress(progress));
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
    this.demoHud.onPlayerSelect((entityId) => {
      const spectator = CameraSystem.getInstance().getController("spectator") as {
        setSpectateTarget?: (id: string) => void;
      } | null;
      spectator?.setSpectateTarget?.(entityId);
      CameraSystem.getInstance().setController("spectator");
    });
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
      spectator?.setSpectateTarget?.(first);
      cameraSystem.setController("spectator");
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
