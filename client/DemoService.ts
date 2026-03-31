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

import type { LobbyClient } from "../../../lobby/LobbyClient";
import type { DemoInfo } from "../../../lobby/types";
import { DemoAnalyzer } from "../../../shared/demo/DemoAnalyzer";
import { DemoReader } from "../../../shared/demo/DemoReader";
import { CameraSystem } from "../../../engine/camera/CameraSystem";
import { CinematicDemoPlayer } from "./CinematicDemoPlayer";
import { DemoViewer } from "./DemoViewer";

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

    this.stopAll();
    this.activeDemoViewer = viewer;
    await viewer.load(this.loadedDemoData);
    viewer.play();
  }

  // ── Cinematic playback ─────────────────────────────────────────────────────

  /**
   * Start cinematic highlight reel.
   * viewer + cameraSystem are injected so callers control the rendering context.
   */
  async loadAndPlayCinematic(
    viewer: DemoViewer,
    cameraSystem: CameraSystem,
    durationMinutes: number,
  ): Promise<void> {
    if (!this.loadedDemoData) throw new Error("No demo loaded. Use `demo <filename>` first.");

    this.stopAll();
    this.activeDemoViewer = viewer;
    const player = new CinematicDemoPlayer(viewer, cameraSystem);
    this.activeCinematicPlayer = player;
    await player.loadAndPlay(this.loadedDemoData, durationMinutes);
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
    this.activeCinematicPlayer?.dispose();
    this.activeCinematicPlayer = null;

    this.activeDemoViewer?.pause();
    this.activeDemoViewer = null;
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
            (d) =>
              d.map.toLowerCase().includes(f) ||
              d.players.some((p) => p.toLowerCase().includes(f)),
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
