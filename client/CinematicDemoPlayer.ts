/**
 * CinematicDemoPlayer — Phase 4 cinematic demo playback engine
 *
 * Orchestrates DemoViewer + CameraSystem to play a CinematicReel:
 *   1. Calls DemoAnalyzer + SequenceBuilder to build the reel
 *   2. Advances through segments as demo ticks pass
 *   3. Switches camera controller per segment (spectator chase-cam or scripted freefly)
 *   4. Interpolates freefly camera keyframes each frame
 *   5. Applies speed-ramp keyframes within segments
 *
 * Usage:
 *   const player = new CinematicDemoPlayer(demoViewer, CameraSystem.getInstance());
 *   await player.loadAndPlay(rawData, 2);   // 2-minute highlight reel
 *   // call player.update(deltaMs) each render frame
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { CameraSystem } from "../../../engine/camera/CameraSystem";
import type { FreeflyController } from "../../../engine/camera/controllers/FreeflyController";
import type { SpectatorController } from "../../../engine/camera/controllers/SpectatorController";
import { type CameraPathResult, generateCameraPath, interpolatePath } from "../../../shared/demo/CinematicCameraPaths";
import type { DemoAnalysis, HighlightCandidate } from "../../../shared/demo/DemoAnalyzer";
import { DemoAnalyzer } from "../../../shared/demo/DemoAnalyzer";
import { DemoReader } from "../../../shared/demo/DemoReader";
import { type CinematicReel, type CinematicSegment, SequenceBuilder } from "../../../shared/demo/SequenceBuilder";
import type { DemoViewer } from "./DemoViewer";

// ── Public types ──────────────────────────────────────────────────────────────

export type CinematicPlayerState = "idle" | "analyzing" | "playing" | "paused" | "ended";

export interface ReelInfo {
  state: CinematicPlayerState;
  currentSegment: number;
  totalSegments: number;
  reelElapsedMs: number;
  reelTotalMs: number;
  /** 0.0 – 1.0 */
  reelProgress: number;
  currentHighlight: HighlightCandidate | null;
  isReplay: boolean;
  currentSpeed: number;
}

// ── CinematicDemoPlayer ───────────────────────────────────────────────────────

export class CinematicDemoPlayer {
  private readonly demoViewer: DemoViewer;
  private readonly cameraSystem: CameraSystem;

  private reel: CinematicReel | null = null;
  private cameraPaths: CameraPathResult[] = [];

  private currentSegmentIndex = 0;
  private state: CinematicPlayerState = "idle";
  private reelElapsedMs = 0;
  private segmentElapsedMs = 0;

  // Callbacks
  private onSegmentChangeCb: ((segment: CinematicSegment, index: number) => void) | null = null;
  private onReelEndCb: (() => void) | null = null;
  private onStateChangeCb: ((state: CinematicPlayerState) => void) | null = null;

  constructor(demoViewer: DemoViewer, cameraSystem: CameraSystem) {
    this.demoViewer = demoViewer;
    this.cameraSystem = cameraSystem;
  }

  // ── Callback registration ─────────────────────────────────────────────────

  onSegmentChange(cb: (segment: CinematicSegment, index: number) => void): void {
    this.onSegmentChangeCb = cb;
  }

  onReelEnd(cb: () => void): void {
    this.onReelEndCb = cb;
  }

  onStateChange(cb: (state: CinematicPlayerState) => void): void {
    this.onStateChangeCb = cb;
  }

  // ── Orchestration ─────────────────────────────────────────────────────────

  /**
   * Full pipeline: parse → analyze → build reel → start playback.
   */
  async loadAndPlay(data: Uint8Array, durationMinutes: number): Promise<void> {
    this._setState("analyzing");

    const reader = await DemoReader.fromFile(data);
    const header = reader.readHeader();
    const index = reader.readIndex();

    await this.demoViewer.load(data);

    const frames = reader.readAllFrames();
    const analysis: DemoAnalysis = new DemoAnalyzer().analyze(frames, header, index.durationMs);

    this.reel = new SequenceBuilder().build(analysis, durationMinutes, header.snapshotRate, header);

    // Pre-generate camera paths for every segment
    this.cameraPaths = this.reel.segments.map((seg) =>
      generateCameraPath(seg.cameraPreset, seg.highlight, seg.startTick, seg.endTick, header.snapshotRate),
    );

    this._startPlayback();
  }

  // ── Update loop ───────────────────────────────────────────────────────────

  /**
   * Call this once per render frame. Drives segment advancement, speed
   * keyframes, and freefly camera path interpolation.
   *
   * DemoViewer.update() is expected to be driven separately by the Game render
   * loop — CinematicDemoPlayer does not call it.
   */
  update(deltaMs: number): void {
    if (this.state !== "playing" || !this.reel) return;

    this.segmentElapsedMs += deltaMs;
    this.reelElapsedMs += deltaMs;

    const segment = this.reel.segments[this.currentSegmentIndex];
    if (!segment) return;

    const currentTick = this.demoViewer.getInfo().currentTick;

    // ── Segment end check ─────────────────────────────────────────
    if (currentTick >= segment.endTick) {
      this._advanceSegment();
      return;
    }

    // ── Speed keyframes ───────────────────────────────────────────
    if (segment.speedKeyframes) {
      let targetSpeed = segment.playbackSpeed;
      for (const kf of segment.speedKeyframes) {
        if (currentTick >= kf.tick) {
          targetSpeed = kf.speed;
        }
      }
      this.demoViewer.setSpeed(targetSpeed);
    }

    // ── Freefly camera path interpolation ─────────────────────────
    const path = this.cameraPaths[segment.segmentIndex];
    if (path?.type === "freefly" && path.keyframes?.length) {
      const { position, lookAt, fov } = interpolatePath(path.keyframes, currentTick);

      const freeflyCtrl = this.cameraSystem.getController("freefly") as FreeflyController | undefined;
      freeflyCtrl?.setPosition(new Vector3(position.x, position.y, position.z));

      const cam = this.cameraSystem.getFreeCamera();
      if (cam) {
        const { pitch, yaw } = this._lookAtRotation(position, lookAt);
        cam.rotation.set(pitch, yaw, 0);
        if (fov !== 90) {
          cam.fov = fov * (Math.PI / 180);
        }
      }
    }
  }

  // ── Transport controls ────────────────────────────────────────────────────

  pause(): void {
    if (this.state !== "playing") return;
    this._setState("paused");
    this.demoViewer.pause();
  }

  resume(): void {
    if (this.state !== "paused") return;
    this._setState("playing");
    this.demoViewer.play();
  }

  togglePlayPause(): void {
    if (this.state === "playing") this.pause();
    else if (this.state === "paused") this.resume();
  }

  skipToSegment(index: number): void {
    if (!this.reel) return;
    const clamped = Math.max(0, Math.min(index, this.reel.segments.length - 1));
    this.currentSegmentIndex = clamped;
    this._applySegment(this.reel.segments[clamped]);
    if (this.state === "paused") this._setState("playing");
  }

  nextSegment(): void {
    this.skipToSegment(this.currentSegmentIndex + 1);
  }

  prevSegment(): void {
    this.skipToSegment(Math.max(0, this.currentSegmentIndex - 1));
  }

  stop(): void {
    this._setState("idle");
    this.reel = null;
    this.cameraPaths = [];
    this.currentSegmentIndex = 0;
    this.reelElapsedMs = 0;
    this.segmentElapsedMs = 0;
  }

  dispose(): void {
    this.stop();
    this.onSegmentChangeCb = null;
    this.onReelEndCb = null;
    this.onStateChangeCb = null;
  }

  // ── Info ──────────────────────────────────────────────────────────────────

  getReelInfo(): ReelInfo {
    const segment = this.reel?.segments[this.currentSegmentIndex] ?? null;
    const totalMs = this.reel?.totalDurationMs ?? 0;
    return {
      state: this.state,
      currentSegment: this.currentSegmentIndex,
      totalSegments: this.reel?.totalSegments ?? 0,
      reelElapsedMs: this.reelElapsedMs,
      reelTotalMs: totalMs,
      reelProgress: totalMs > 0 ? Math.min(1, this.reelElapsedMs / totalMs) : 0,
      currentHighlight: segment?.highlight ?? null,
      isReplay: segment?.isReplay ?? false,
      currentSpeed: this.demoViewer.getInfo().playbackSpeed,
    };
  }

  getState(): CinematicPlayerState {
    return this.state;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _startPlayback(): void {
    if (!this.reel || this.reel.segments.length === 0) {
      this._setState("ended");
      this.onReelEndCb?.();
      return;
    }

    this.currentSegmentIndex = 0;
    this.reelElapsedMs = 0;
    this._applySegment(this.reel.segments[0]);
    this._setState("playing");
  }

  private _applySegment(segment: CinematicSegment): void {
    this.demoViewer.seekToTick(segment.startTick);
    this.demoViewer.setSpeed(segment.playbackSpeed);
    this.demoViewer.play();
    this.segmentElapsedMs = 0;

    const path = this.cameraPaths[segment.segmentIndex];

    if (path?.type === "chase") {
      this.cameraSystem.setController("spectator");
      const spectator = this.cameraSystem.getController("spectator") as SpectatorController | undefined;
      spectator?.setSpectateTarget(path.targetEntityId ?? segment.cameraTarget ?? "");
    } else {
      this.cameraSystem.setController("freefly");
      // Snap to first keyframe position immediately
      if (path?.keyframes?.length) {
        const first = path.keyframes[0];
        const freeflyCtrl = this.cameraSystem.getController("freefly") as FreeflyController | undefined;
        freeflyCtrl?.setPosition(new Vector3(first.position.x, first.position.y, first.position.z));
      }
    }

    this.onSegmentChangeCb?.(segment, segment.segmentIndex);
  }

  private _advanceSegment(): void {
    this.currentSegmentIndex++;
    if (!this.reel || this.currentSegmentIndex >= this.reel.segments.length) {
      this._setState("ended");
      this.onReelEndCb?.();
      return;
    }
    this._applySegment(this.reel.segments[this.currentSegmentIndex]);
  }

  private _setState(newState: CinematicPlayerState): void {
    this.state = newState;
    this.onStateChangeCb?.(newState);
  }

  /**
   * Convert position + lookAt target to Babylon camera rotation (pitch, yaw).
   */
  private _lookAtRotation(
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
  ): { pitch: number; yaw: number } {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);
    return {
      yaw: Math.atan2(dx, dz),
      pitch: -Math.atan2(dy, horizDist),
    };
  }
}
