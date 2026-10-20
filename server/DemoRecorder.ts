/**
 * DemoRecorder — Server-side match recording
 *
 * Records game state snapshots to a binary .shagdemo file.
 * Used for:
 *   1. brain.js training data (full match replays for ML)
 *   2. Client-side demo viewer (tournament match replays)
 *
 * Format: Header → Frames → Index Table → Footer
 * Each frame is a full (non-delta) BinaryProtocol.encodeSnapshot()
 * so any frame can be decoded independently for random-access seeking.
 *
 * Usage:
 *   const recorder = new DemoRecorder({ map, gametype, tickRate, snapshotRate });
 *   recorder.addPlayer(playerId, name, team);
 *   // each snapshot tick:
 *   recorder.recordFrame(gameState);
 *   // on match end:
 *   const filepath = await recorder.stop();
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import type { GameState } from "../../../engine/network/core/GameState";
import { BinaryEncoder, BinaryProtocol } from "../../../engine/network/protocol/BinaryProtocol";
import {
  type AppliedCommand,
  aggregateCommand,
  encodeInputs,
  type RecordedInput,
} from "../../../shared/demo/DemoInputs";
import { debugLog } from "./DebugLog";

// ── Magic & Version ─────────────────────────────────────────────────────

/** Magic bytes identifying a .shagdemo file */
const DEMO_MAGIC = new Uint8Array([0x53, 0x48, 0x41, 0x47]); // "SHAG"

/**
 * Version 6 retains v5's header and player view encoding and adds optional
 * persistent disabled brush models to the bomb objective's JSON state.
 */
const DEMO_VERSION = 6;

// ── Types ───────────────────────────────────────────────────────────────

export interface DemoConfig {
  /** Map name */
  map: string;
  /** Gametype (duel, ffa, tdm, etc.) */
  gametype: string;
  /** Server tick rate in Hz (currently 125). Stored as uint8 in the header. */
  tickRate: number;
  /** Snapshot rate in Hz (currently 60). Stored as uint8 in the header. */
  snapshotRate: number;
  /** Lobby-issued match ID, if this recording belongs to a ticketed match. */
  matchId?: string;
  /** Private lobby recording, excluded from featured picks. */
  private?: boolean;
  /** Output directory for demo files */
  outputDir?: string;
  /** Folder under the default demo directory, when `outputDir` is not given. */
  subdirectory?: string;
  /** File name without extension; default `<map>_<gametype>_<date>_<time>`. */
  fileName?: string;
  /**
   * Minimum recorded match duration (ms) below which the demo is discarded on
   * stop() instead of written. Prevents demo flood from aborted / instant-end
   * matches. Defaults to {@link DemoRecorder.DEFAULT_MIN_DURATION_MS}.
   */
  minDurationMs?: number;
}

export interface DemoPlayerEntry {
  playerId: string;
  name: string;
  team: string;
  /** Verified lobby account from a consumed seat ticket, never a display name. */
  accountId?: number;
}

interface FrameIndex {
  tick: number;
  offset: number;
}

// ── DemoRecorder ────────────────────────────────────────────────────────

export class DemoRecorder {
  /** Default floor for a keepable match: shorter recordings are discarded on stop(). */
  static readonly DEFAULT_MIN_DURATION_MS = 10_000;

  private _config: DemoConfig;
  private _players: Map<string, DemoPlayerEntry> = new Map();
  private _frames: Uint8Array[] = [];
  /** Encoded input block per frame, parallel to _frames (format version 3). */
  private _frameInputs: Uint8Array[] = [];
  /** Commands applied since the last frame, folded per player. */
  private _pendingInputs: Map<string, RecordedInput> = new Map();
  private _frameIndices: FrameIndex[] = [];
  private _startTime: number;
  private _frameCount: number = 0;
  private _recording: boolean = true;

  constructor(config: DemoConfig) {
    this._config = config;
    this._startTime = Date.now();

    const dir = config.outputDir || path.join(process.cwd(), "public", "data", "demos", config.subdirectory ?? "");
    this._config.outputDir = dir;

    console.log(`[DemoRecorder] ✓ Recording started for map "${config.map}" (${config.gametype})`);
    debugLog(
      "setup",
      () => `[DemoRecorder]   Tick rate: ${config.tickRate}Hz, Snapshot rate: ${config.snapshotRate}Hz`,
    );
  }

  // ── Player Roster ────────────────────────────────────────────────

  /**
   * Add a player to the demo roster. Call on player connect/join.
   */
  addPlayer(playerId: string, name: string, team: string = "", accountId?: number): void {
    this._players.set(playerId, { playerId, name, team, accountId });
    console.log(`[DemoRecorder] Player added: ${name} (${playerId})`);
  }

  /**
   * Remove a player from future roster (they disconnected).
   * Their data stays in the roster for replay — just stops being updated.
   */
  removePlayer(playerId: string): void {
    // Don't remove from roster — we keep the full list for replay
    console.log(`[DemoRecorder] Player disconnected: ${playerId}`);
  }

  // ── Frame Recording ──────────────────────────────────────────────

  /**
   * Note one command the server applied, for the frame being accumulated.
   *
   * Commands arrive at tick rate and frames are written at snapshot rate, so
   * several fold into one record: buttons are OR-ed, so a press between two
   * snapshots survives, and the analogue fields keep their last applied value.
   */
  recordInput(playerId: string, command: AppliedCommand): void {
    if (!this._recording) return;
    this._pendingInputs.set(playerId, aggregateCommand(this._pendingInputs.get(playerId), command, playerId));
  }

  /**
   * Record a frame (one snapshot tick's worth of game state).
   * Called at snapshot rate (e.g. 20Hz).
   *
   * Uses BinaryProtocol.encodeSnapshot() WITHOUT baseline (full encode)
   * so each frame is independently decodable.
   */
  recordFrame(state: GameState): void {
    if (!this._recording) return;

    // Encode full snapshot (no baseline = no delta compression)
    const frameData = BinaryProtocol.encodeSnapshot(state);
    const inputData = encodeInputs([...this._pendingInputs.values()]);
    this._pendingInputs.clear();
    this._frameInputs.push(inputData);

    // Track offset for index table
    this._frameIndices.push({
      tick: state.tick,
      offset: this._frameCount, // Frame number (we'll compute byte offset at write time)
    });

    this._frames.push(frameData);
    this._frameCount++;
  }

  // ── Recording State ──────────────────────────────────────────────

  get isRecording(): boolean {
    return this._recording;
  }

  get frameCount(): number {
    return this._frameCount;
  }

  get durationMs(): number {
    return Date.now() - this._startTime;
  }

  // ── Finalize & Write ─────────────────────────────────────────────

  /**
   * Stop recording and write the demo file to disk.
   * Returns the filepath of the written demo.
   */
  async stop(): Promise<string> {
    this._recording = false;
    const duration = this.durationMs;

    console.log(`[DemoRecorder] Stopping... ${this._frameCount} frames, ${(duration / 1000).toFixed(1)}s`);

    // Guard: don't write an empty demo file
    if (this._frameCount === 0) {
      console.warn("[DemoRecorder] No frames recorded, skipping file write");
      return "";
    }

    // Guard: discard trivially short matches (aborted / instant-end) so casual
    // testing doesn't flood the demo folder. Only real matches are kept.
    const minDurationMs = this._config.minDurationMs ?? DemoRecorder.DEFAULT_MIN_DURATION_MS;
    if (duration < minDurationMs) {
      console.log(
        `[DemoRecorder] Match too short (${(duration / 1000).toFixed(1)}s < ${(minDurationMs / 1000).toFixed(
          0,
        )}s) — discarding demo`,
      );
      return "";
    }

    // Generate filename: map_gametype_YYYYMMDD_HHmmss.shagdemo
    const dir = this._config.outputDir!;

    // Ensure output directory exists
    fs.mkdirSync(dir, { recursive: true });

    // Build the complete binary file
    const demoBuffer = this._buildDemoBuffer(duration);

    // Gzip compress (like pk3 = zip, .shagdemo is gzipped binary)
    const compressed = zlib.gzipSync(demoBuffer, { level: 6 });

    // Write compressed data to disk (Uint8Array copy: Node's Buffer no longer
    // satisfies the ArrayBuffer-backed view type under TS 5.9 strict generics)
    const filepath = this._writeUnclaimed(dir, this._generateFilename(), new Uint8Array(compressed));
    const filename = path.basename(filepath);

    const rawMB = (demoBuffer.byteLength / (1024 * 1024)).toFixed(2);
    const compMB = (compressed.byteLength / (1024 * 1024)).toFixed(2);
    const ratio = ((1 - compressed.byteLength / demoBuffer.byteLength) * 100).toFixed(0);
    console.log(
      `[DemoRecorder] ✓ Demo saved: ${filename} (${compMB} MB, ${ratio}% compressed from ${rawMB} MB, ${this._frameCount} frames)`,
    );

    return filepath;
  }

  // ── Private: Binary Format Builder ───────────────────────────────

  private _buildDemoBuffer(duration: number): Uint8Array {
    const encoder = new BinaryEncoder(1024 * 1024); // Start with 1MB buffer

    // ── Section 1: Header ────────────────────────────────────────
    this._writeHeader(encoder);

    // ── Section 2: Frames ────────────────────────────────────────
    const frameOffsets: number[] = [];

    for (let i = 0; i < this._frames.length; i++) {
      frameOffsets.push(encoder.getOffset());

      const frame = this._frames[i];
      // Write tick number
      encoder.writeUint32(this._frameIndices[i].tick);
      // Write frame length + data
      encoder.writeUint32(frame.byteLength);
      // Write raw frame bytes
      encoder.writeBytes(frame);
      // Version 3: the commands applied over the interval this frame covers
      const inputs = this._frameInputs[i] ?? new Uint8Array(0);
      encoder.writeUint32(inputs.byteLength);
      encoder.writeBytes(inputs);
    }

    // ── Section 3: Index Table ───────────────────────────────────
    const indexOffset = encoder.getOffset();

    // Frame count
    encoder.writeUint32(this._frameCount);

    // Frame indices: tick + byte offset
    for (let i = 0; i < this._frameIndices.length; i++) {
      encoder.writeUint32(this._frameIndices[i].tick);
      encoder.writeUint32(frameOffsets[i]); // Byte offset in file
    }

    // ── Footer ──────────────────────────────────────────────────
    encoder.writeUint32(Math.round(duration)); // Total duration ms
    encoder.writeUint32(indexOffset); // Offset to index table (for seeking)

    return encoder.toBytes();
  }

  private _writeHeader(encoder: BinaryEncoder): void {
    // Magic bytes: SHAG
    for (const byte of DEMO_MAGIC) {
      encoder.writeUint8(byte);
    }

    // Version
    encoder.writeUint8(DEMO_VERSION);

    // Map name
    encoder.writeString(this._config.map);

    // Gametype
    encoder.writeString(this._config.gametype);

    // Tick rate
    encoder.writeUint8(this._config.tickRate);

    // Snapshot rate
    encoder.writeUint8(this._config.snapshotRate);

    // Start timestamp (high 32 + low 32 for 64-bit)
    const timestamp = this._startTime;
    encoder.writeUint32(Math.floor(timestamp / 0x100000000)); // High bits
    encoder.writeUint32(timestamp >>> 0); // Low bits

    // Version 2: link to a lobby match without inferring identity from names.
    encoder.writeString(this._config.matchId || "");

    // Version 4: lobby visibility. Frames and inputs keep their version 3 layout.
    encoder.writeUint8(this._config.private ? 1 : 0);

    // Player roster
    const players = [...this._players.values()];
    encoder.writeUint8(players.length);

    for (const player of players) {
      encoder.writeString(player.playerId);
      encoder.writeString(player.name);
      encoder.writeString(player.team);
      encoder.writeString(player.accountId === undefined ? "" : String(player.accountId));
    }
  }

  /**
   * Write under the generated name, or the first variant nobody has yet, and
   * return where it went.
   *
   * The name is only accurate to the second, and two matches can finish inside
   * the same one — a lobby starting two rooms at once is ordinary. Each name is
   * claimed by creating the file exclusively, so the filesystem decides who got
   * it: checking whether a name was free and then writing to it let three game
   * servers that stopped together each see it free, and each write over the
   * others, leaving one recording of three.
   */
  private _writeUnclaimed(dir: string, filename: string, data: Uint8Array): string {
    const stem = filename.replace(/\.shagdemo$/, "");
    const candidates = [filename];
    for (let n = 2; n <= 99; n++) candidates.push(`${stem}_${n}.shagdemo`);
    // Ninety-nine in one second is not a real match, but a demo is still worth
    // more than an error.
    candidates.push(`${stem}_${Date.now()}_${process.pid}.shagdemo`);

    for (const name of candidates) {
      const candidate = path.join(dir, name);
      try {
        fs.writeFileSync(candidate, data, { flag: "wx" });
        return candidate;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new Error(`[DemoRecorder] No free name for ${filename} in ${dir}`);
  }

  private _generateFilename(): string {
    if (this._config.fileName) return `${this._config.fileName.replace(/[^a-zA-Z0-9_-]/g, "_")}.shagdemo`;
    const d = new Date(this._startTime);
    const pad = (n: number) => n.toString().padStart(2, "0");
    const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const timeStr = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const map = this._config.map.replace(/[^a-zA-Z0-9_-]/g, "_");
    const gametype = this._config.gametype.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${map}_${gametype}_${dateStr}_${timeStr}.shagdemo`;
  }
}
