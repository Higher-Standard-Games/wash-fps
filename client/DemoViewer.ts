/**
 * DemoViewer — In-browser .shagdemo playback controller
 *
 * Loads a demo file, plays back frames at the recorded snapshotRate,
 * and feeds them to RemotePlayerRenderer for visual playback.
 * Reuses SpectatorController for chase-cam (same code as live spectator).
 *
 * Transport controls: play/pause, speed (0.25x–4x), seek, timeline.
 */

import type { GameState } from "../../../engine/network/core/GameState";
import { type DemoHeader, type DemoIndex, DemoReader } from "../../../shared/demo/DemoReader";

// ─── Types ───────────────────────────────────────────────────────

export type DemoViewerState = "idle" | "loaded" | "playing" | "paused" | "ended";

export interface DemoViewerInfo {
  state: DemoViewerState;
  header: DemoHeader | null;
  currentFrame: number;
  totalFrames: number;
  currentTick: number;
  durationMs: number;
  elapsedMs: number;
  playbackSpeed: number;
}

export type DemoViewerCallback = (state: GameState, tick: number) => void;

// ─── Constants ───────────────────────────────────────────────────

const SPEED_OPTIONS = [0.25, 0.5, 1.0, 2.0, 4.0];
const DEFAULT_SPEED = 1.0;

// ─── DemoViewer ──────────────────────────────────────────────────

export class DemoViewer {
  private reader: DemoReader | null = null;
  private header: DemoHeader | null = null;
  private index: DemoIndex | null = null;

  private state: DemoViewerState = "idle";
  private currentFrameIndex: number = 0;
  private playbackSpeed: number = DEFAULT_SPEED;
  private elapsedSinceLastFrame: number = 0;

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
    this.index = this.reader.readIndex();

    this.currentFrameIndex = 0;
    this.elapsedSinceLastFrame = 0;
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
      this.elapsedSinceLastFrame = 0;
    }

    this.setState("playing");

    // Deliver current frame immediately on play
    this.deliverCurrentFrame();
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
    this.elapsedSinceLastFrame = 0;

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
    if (!this.index) return;
    const frameIndex = Math.round(progress * (this.index.frameCount - 1));
    this.seekToFrame(frameIndex);
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

    // Calculate frame interval based on snapshot rate
    const frameInterval = 1000 / this.header.snapshotRate;

    this.elapsedSinceLastFrame += deltaMs * this.playbackSpeed;

    // Cap frame advances per update to prevent tab-return freeze.
    // Without this, a 60s tab-away at 4× speed / 20Hz = 4800 readFrame() calls
    // in one render frame, freezing the browser.
    const MAX_FRAMES_PER_UPDATE = 4;
    let framesAdvanced = 0;

    // Advance frames as needed (capped)
    while (this.elapsedSinceLastFrame >= frameInterval && framesAdvanced < MAX_FRAMES_PER_UPDATE) {
      this.elapsedSinceLastFrame -= frameInterval;
      this.currentFrameIndex++;
      framesAdvanced++;

      if (this.currentFrameIndex >= this.index.frameCount) {
        this.currentFrameIndex = this.index.frameCount - 1;
        this.elapsedSinceLastFrame = 0;
        this.setState("ended");
        return;
      }

      this.deliverCurrentFrame();
    }

    // If we hit the cap, drain leftover to prevent accumulation snowball
    if (framesAdvanced >= MAX_FRAMES_PER_UPDATE) {
      this.elapsedSinceLastFrame = 0;
    }
  }

  // ── Frame Delivery ──────────────────────────────────────────────

  /**
   * Deliver the current frame to the callback.
   */
  private deliverCurrentFrame(): void {
    if (!this.reader || !this.onFrameCallback) return;

    const frame = this.reader.readFrame(this.currentFrameIndex);
    if (frame) {
      this.onFrameCallback(frame.state, frame.tick);
    }
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
    // snapshotRate available via header if needed for display
    const durationMs = this.index?.durationMs ?? 0;
    const elapsedMs = totalFrames > 1 ? (this.currentFrameIndex / (totalFrames - 1)) * durationMs : 0;

    return {
      state: this.state,
      header: this.header,
      currentFrame: this.currentFrameIndex,
      totalFrames,
      currentTick: this.index?.entries[this.currentFrameIndex]?.tick ?? 0,
      durationMs,
      elapsedMs,
      playbackSpeed: this.playbackSpeed,
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

  /**
   * Get playback progress (0.0 – 1.0).
   */
  getProgress(): number {
    const total = this.index?.frameCount ?? 0;
    if (total <= 1) return 0;
    return this.currentFrameIndex / (total - 1);
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
    this.onFrameCallback = null;
    this.onStateChangeCallback = null;
  }
}
