/**
 * DemoViewer — In-browser .shagdemo playback controller
 *
 * Loads a demo file, plays back frames at their recorded server ticks,
 * and feeds them to RemotePlayerRenderer for visual playback.
 * Reuses SpectatorController for chase-cam (same code as live spectator).
 *
 * Transport controls: play/pause, speed (0.25x–4x), seek, timeline.
 */

import type { GameState } from "../../../engine/network/core/GameState";
import { type DemoFrame, type DemoHeader, type DemoIndex, DemoReader } from "../../../shared/demo/DemoReader";

// ─── Types ───────────────────────────────────────────────────────

export type DemoViewerState = "idle" | "loaded" | "playing" | "paused" | "ended";

export interface DemoViewerInfo {
  state: DemoViewerState;
  header: DemoHeader | null;
  currentFrame: number;
  totalFrames: number;
  currentTick: number;
  /** Continuous server-tick position between the current and next frame. */
  playheadTick: number;
  durationMs: number;
  elapsedMs: number;
  playbackSpeed: number;
  /** Increments whenever playback jumps discontinuously. */
  discontinuityId: number;
}

export type DemoViewerCallback = (state: GameState, tick: number) => void;

// ─── Constants ───────────────────────────────────────────────────

const SPEED_OPTIONS = [0.25, 0.5, 1.0, 2.0, 4.0];
const DEFAULT_SPEED = 1.0;
/**
 * Recorded time, in real milliseconds of playback, that one update may catch
 * up on. Frames older than that behind the playhead are skipped after a long
 * browser stall rather than replayed in one burst. A cap in frames (4) skipped
 * frames, and their kills, sounds and projectile spawns, at 4x speed every
 * update.
 */
const MAX_CATCH_UP_MS = 250;

// ─── DemoViewer ──────────────────────────────────────────────────

export class DemoViewer {
  private reader: DemoReader | null = null;
  private header: DemoHeader | null = null;
  private index: DemoIndex | null = null;

  private state: DemoViewerState = "idle";
  private currentFrameIndex: number = 0;
  private playbackSpeed: number = DEFAULT_SPEED;
  /** Current position on the recorded timeline, relative to the first frame. */
  private playheadMs: number = 0;
  private discontinuityId: number = 0;
  /** The frame last handed to onFrame, and in which discontinuity, so play() never hands it over twice. */
  private presented: { frame: number; discontinuityId: number } | null = null;
  private frameCache: Map<number, DemoFrame> = new Map();

  // Callbacks
  private onFrameCallback: DemoViewerCallback | null = null;
  private onStateChangeCallback: ((state: DemoViewerState) => void) | null = null;

  // ── Loading ─────────────────────────────────────────────────────

  /**
   * Load a demo from raw file data (Uint8Array or ArrayBuffer).
   * Automatically handles gzip decompression in browser.
   */
  async load(data: Uint8Array | ArrayBuffer): Promise<void> {
    this.reader = await DemoReader.fromFile(data);
    this.header = this.reader.readHeader();

    // Recorded ticks are the playback time source; a header without a positive
    // tickRate is a legacy recording whose playhead can't advance — the models
    // would render frozen while the scrubber moves. Refuse it cleanly instead.
    if (!this.header.tickRate || this.header.tickRate <= 0) {
      this.reader = null;
      this.header = null;
      throw new Error("Legacy demo (no tickRate in header) — re-record with a current server.");
    }

    this.index = this.reader.readIndex();

    this.currentFrameIndex = 0;
    this.playheadMs = 0;
    this.discontinuityId++;
    this.frameCache.clear();
    this.setState("loaded");

    console.log(`[DemoViewer] Loaded demo: ${this.reader.getSummary()}`);
  }

  /**
   * Check if a demo is loaded and ready for playback.
   */
  isLoaded(): boolean {
    return this.reader !== null && this.index !== null;
  }

  // ── Transport Controls ──────────────────────────────────────────

  /**
   * Start or resume playback.
   */
  play(): void {
    if (!this.isLoaded()) return;

    if (this.state === "ended") {
      // Restart from beginning
      this.currentFrameIndex = 0;
      this.playheadMs = 0;
      this.discontinuityId++;
    }

    this.setState("playing");

    // Deliver the current frame at once, unless it is already on screen: a
    // resume, or a play right after a seek, replayed its shots, deaths, gibs
    // and kill feed a second time.
    if (!this.isPresented(this.currentFrameIndex)) this.deliverCurrentFrame();
  }

  /**
   * Pause playback.
   */
  pause(): void {
    if (this.state !== "playing") return;
    this.setState("paused");
  }

  /**
   * Toggle play/pause.
   */
  togglePlayPause(): void {
    if (this.state === "playing") {
      this.pause();
    } else {
      this.play();
    }
  }

  /**
   * Seek to a specific frame index.
   */
  seekToFrame(frameIndex: number): void {
    if (!this.index) return;

    this.currentFrameIndex = Math.max(0, Math.min(frameIndex, this.index.frameCount - 1));
    this.playheadMs = this.getFrameTimeMs(this.currentFrameIndex);
    this.discontinuityId++;

    // Deliver the frame at the new position
    this.deliverCurrentFrame();

    // If ended and seeking back, switch to paused
    if (this.state === "ended") {
      this.setState("paused");
    }
  }

  /**
   * Seek to a specific tick.
   */
  seekToTick(tick: number): void {
    if (!this.reader) return;
    const frameIndex = this.reader.findFrameByTick(tick);
    this.seekToFrame(frameIndex);
  }

  /**
   * Seek to a position in the timeline (0.0 – 1.0).
   */
  seekToProgress(progress: number): void {
    if (!this.reader || !this.index || this.index.frameCount === 0) return;
    const clampedProgress = Math.max(0, Math.min(progress, 1));
    const firstTick = this.index.entries[0].tick;
    const lastTick = this.index.entries[this.index.frameCount - 1].tick;
    const targetTick = Math.round(firstTick + (lastTick - firstTick) * clampedProgress);
    this.seekToFrame(this.reader.findFrameByTick(targetTick));
  }

  // ── Speed Control ───────────────────────────────────────────────

  /**
   * Set playback speed multiplier.
   */
  setSpeed(speed: number): void {
    this.playbackSpeed = Math.max(0.1, Math.min(speed, 10));
  }

  /**
   * Get current playback speed.
   */
  getSpeed(): number {
    return this.playbackSpeed;
  }

  /**
   * Cycle to the next speed option.
   */
  cycleSpeed(): number {
    const idx = SPEED_OPTIONS.indexOf(this.playbackSpeed);
    if (idx === -1) {
      // Current speed not in presets — snap to nearest
      const closest = SPEED_OPTIONS.reduce((a, b) =>
        Math.abs(b - this.playbackSpeed) < Math.abs(a - this.playbackSpeed) ? b : a,
      );
      this.playbackSpeed = closest;
    } else {
      const nextIdx = (idx + 1) % SPEED_OPTIONS.length;
      this.playbackSpeed = SPEED_OPTIONS[nextIdx];
    }
    return this.playbackSpeed;
  }

  /**
   * Get available speed options.
   */
  getSpeedOptions(): number[] {
    return [...SPEED_OPTIONS];
  }

  // ── Update Loop ─────────────────────────────────────────────────

  /**
   * Call this every frame to advance playback.
   * @param deltaMs Delta time in milliseconds
   */
  update(deltaMs: number): void {
    if (this.state !== "playing" || !this.reader || !this.header || !this.index) {
      return;
    }

    const durationMs = this.getTimelineDurationMs();
    this.playheadMs = Math.min(durationMs, this.playheadMs + Math.max(0, deltaMs) * this.playbackSpeed);

    const targetFrameIndex = this.findFrameAtPlayhead(this.playheadMs);
    if (targetFrameIndex > this.currentFrameIndex) {
      // Full snapshots make it safe to skip old intermediate frames after a long
      // browser stall. Deliver what fits the catch-up window so presentation
      // catches up without replaying thousands of stale transient events in one
      // render update; at any speed, a normal frame's worth is all delivered.
      const oldestMs = this.playheadMs - MAX_CATCH_UP_MS * this.playbackSpeed;
      const firstFrameToDeliver = Math.max(this.currentFrameIndex + 1, this.findFrameAtPlayhead(oldestMs));
      this.currentFrameIndex = firstFrameToDeliver - 1;

      while (this.currentFrameIndex < targetFrameIndex) {
        this.currentFrameIndex++;
        this.deliverCurrentFrame();
      }
    }

    if (this.currentFrameIndex >= this.index.frameCount - 1 && this.playheadMs >= durationMs) {
      this.playheadMs = durationMs;
      this.setState("ended");
    }
  }

  /** Recorded time of a frame relative to the first frame. Recorded ticks are
   *  the single time source; load() rejects headers without a tickRate. */
  private getFrameTimeMs(frameIndex: number): number {
    if (!this.header || !this.index || this.index.frameCount === 0) return 0;
    const safeIndex = Math.max(0, Math.min(frameIndex, this.index.frameCount - 1));
    const firstTick = this.index.entries[0].tick;
    const frameTick = this.index.entries[safeIndex].tick;
    return (Math.max(0, frameTick - firstTick) / this.header.tickRate) * 1000;
  }

  private getTimelineDurationMs(): number {
    if (!this.index || this.index.frameCount <= 1) return 0;
    return this.getFrameTimeMs(this.index.frameCount - 1);
  }

  private getPlayheadTick(): number {
    if (!this.header || !this.index || this.index.frameCount === 0) return 0;
    const firstTick = this.index.entries[0].tick;
    return firstTick + (this.playheadMs / 1000) * this.header.tickRate;
  }

  /** Find the newest frame whose recorded timestamp is not after the playhead. */
  private findFrameAtPlayhead(playheadMs: number): number {
    if (!this.index || this.index.frameCount === 0) return 0;

    let low = 0;
    let high = this.index.frameCount - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.getFrameTimeMs(middle) <= playheadMs) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  }

  // ── Frame Delivery ──────────────────────────────────────────────

  /**
   * Deliver the current frame to the callback.
   */
  private deliverCurrentFrame(): void {
    if (!this.onFrameCallback) return;
    const frame = this.readFrameCached(this.currentFrameIndex);
    if (frame) {
      this.presented = { frame: this.currentFrameIndex, discontinuityId: this.discontinuityId };
      this.onFrameCallback(frame.state, frame.tick);
    }
  }

  private isPresented(frameIndex: number): boolean {
    return this.presented?.frame === frameIndex && this.presented.discontinuityId === this.discontinuityId;
  }

  private readFrameCached(frameIndex: number): DemoFrame | null {
    if (!this.reader || !this.index || frameIndex < 0 || frameIndex >= this.index.frameCount) return null;
    const cached = this.frameCache.get(frameIndex);
    if (cached) return cached;

    const frame = this.reader.readFrame(frameIndex);
    if (!frame) return null;
    this.frameCache.set(frameIndex, frame);
    while (this.frameCache.size > 4) {
      const oldest = this.frameCache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.frameCache.delete(oldest);
    }
    return frame;
  }

  // ── Callbacks ───────────────────────────────────────────────────

  /**
   * Register a callback for each frame delivered during playback.
   * This is where you feed the GameState into RemotePlayerRenderer.
   */
  onFrame(callback: DemoViewerCallback): void {
    this.onFrameCallback = callback;
  }

  /**
   * Register a callback for state changes (play/pause/ended/etc).
   */
  onStateChange(callback: (state: DemoViewerState) => void): void {
    this.onStateChangeCallback = callback;
  }

  // ── State ───────────────────────────────────────────────────────

  private setState(newState: DemoViewerState): void {
    this.state = newState;
    this.onStateChangeCallback?.(newState);
  }

  /**
   * Get complete viewer info for HUD display.
   */
  getInfo(): DemoViewerInfo {
    const totalFrames = this.index?.frameCount ?? 0;
    const durationMs = this.getTimelineDurationMs();
    const elapsedMs = this.getFrameTimeMs(this.currentFrameIndex);

    return {
      state: this.state,
      header: this.header,
      currentFrame: this.currentFrameIndex,
      totalFrames,
      currentTick: this.index?.entries[this.currentFrameIndex]?.tick ?? 0,
      playheadTick: this.getPlayheadTick(),
      durationMs,
      elapsedMs,
      playbackSpeed: this.playbackSpeed,
      discontinuityId: this.discontinuityId,
    };
  }

  /**
   * Get current state.
   */
  getState(): DemoViewerState {
    return this.state;
  }

  /**
   * Get the demo header.
   */
  getHeader(): DemoHeader | null {
    return this.header;
  }

  /**
   * Get current frame index.
   */
  getCurrentFrame(): number {
    return this.currentFrameIndex;
  }

  /**
   * Get total frame count.
   */
  getTotalFrames(): number {
    return this.index?.frameCount ?? 0;
  }

  /** Decode the next full frame for deterministic render lookahead. */
  getNextFrame(): DemoFrame | null {
    return this.readFrameCached(this.currentFrameIndex + 1);
  }

  /**
   * Get playback progress (0.0 – 1.0).
   */
  getProgress(): number {
    const durationMs = this.getTimelineDurationMs();
    if (durationMs <= 0) return 0;
    return Math.min(1, this.getFrameTimeMs(this.currentFrameIndex) / durationMs);
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  /**
   * Dispose all resources.
   */
  dispose(): void {
    this.reader = null;
    this.header = null;
    this.index = null;
    this.state = "idle";
    this.currentFrameIndex = 0;
    this.playheadMs = 0;
    this.discontinuityId = 0;
    this.presented = null;
    this.frameCache.clear();
    this.onFrameCallback = null;
    this.onStateChangeCallback = null;
  }
}
