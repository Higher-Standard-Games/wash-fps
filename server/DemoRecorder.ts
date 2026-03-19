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

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { BinaryProtocol, BinaryEncoder } from '../../../engine/network/protocol/BinaryProtocol';
import type { GameState } from '../../../engine/network/core/GameState';

// ── Magic & Version ─────────────────────────────────────────────────────

/** Magic bytes identifying a .shagdemo file */
const DEMO_MAGIC = new Uint8Array([0x53, 0x48, 0x41, 0x47]); // "SHAG"

/** Current demo format version */
const DEMO_VERSION = 1;

// ── Types ───────────────────────────────────────────────────────────────

export interface DemoConfig {
    /** Map name */
    map: string;
    /** Gametype (duel, ffa, tdm, etc.) */
    gametype: string;
    /** Server tick rate (e.g. 60) */
    tickRate: number;
    /** Snapshot rate (e.g. 20) */
    snapshotRate: number;
    /** Output directory for demo files */
    outputDir?: string;
}

export interface DemoPlayerEntry {
    playerId: string;
    name: string;
    team: string;
}

interface FrameIndex {
    tick: number;
    offset: number;
}

// ── DemoRecorder ────────────────────────────────────────────────────────

export class DemoRecorder {
    private _config: DemoConfig;
    private _players: Map<string, DemoPlayerEntry> = new Map();
    private _frames: Uint8Array[] = [];
    private _frameIndices: FrameIndex[] = [];
    private _startTime: number;
    private _frameCount: number = 0;
    private _recording: boolean = true;

    constructor(config: DemoConfig) {
        this._config = config;
        this._startTime = Date.now();

        const dir = config.outputDir || path.join(process.cwd(), 'public', 'data', 'demos');
        this._config.outputDir = dir;

        console.log(`[DemoRecorder] ✓ Recording started for map "${config.map}" (${config.gametype})`);
        console.log(`[DemoRecorder]   Tick rate: ${config.tickRate}Hz, Snapshot rate: ${config.snapshotRate}Hz`);
    }

    // ── Player Roster ────────────────────────────────────────────────

    /**
     * Add a player to the demo roster. Call on player connect/join.
     */
    addPlayer(playerId: string, name: string, team: string = ''): void {
        this._players.set(playerId, { playerId, name, team });
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

        // Generate filename: map_gametype_YYYYMMDD_HHmmss.shagdemo
        const filename = this._generateFilename();
        const dir = this._config.outputDir!;
        const filepath = path.join(dir, filename);

        // Ensure output directory exists
        fs.mkdirSync(dir, { recursive: true });

        // Build the complete binary file
        const demoBuffer = this._buildDemoBuffer(duration);

        // Gzip compress (like pk3 = zip, .shagdemo is gzipped binary)
        const compressed = zlib.gzipSync(demoBuffer, { level: 6 });

        // Write compressed data to disk
        fs.writeFileSync(filepath, compressed);

        const rawMB = (demoBuffer.byteLength / (1024 * 1024)).toFixed(2);
        const compMB = (compressed.byteLength / (1024 * 1024)).toFixed(2);
        const ratio = ((1 - compressed.byteLength / demoBuffer.byteLength) * 100).toFixed(0);
        console.log(`[DemoRecorder] ✓ Demo saved: ${filename} (${compMB} MB, ${ratio}% compressed from ${rawMB} MB, ${this._frameCount} frames)`);

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
        encoder.writeUint32(indexOffset);           // Offset to index table (for seeking)

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
        encoder.writeUint32(timestamp >>> 0);                      // Low bits

        // Player roster
        const players = [...this._players.values()];
        encoder.writeUint8(players.length);

        for (const player of players) {
            encoder.writeString(player.playerId);
            encoder.writeString(player.name);
            encoder.writeString(player.team);
        }
    }

    private _generateFilename(): string {
        const d = new Date(this._startTime);
        const pad = (n: number) => n.toString().padStart(2, '0');
        const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
        const timeStr = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        const map = this._config.map.replace(/[^a-zA-Z0-9_-]/g, '_');
        const gametype = this._config.gametype.replace(/[^a-zA-Z0-9_-]/g, '_');
        return `${map}_${gametype}_${dateStr}_${timeStr}.shagdemo`;
    }
}
