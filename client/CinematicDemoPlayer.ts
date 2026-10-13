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

const HIGHLIGHT_LABELS: Record<string, string> = {
  frag: "Frag",
  multi_kill: "Multi kill",
  airborne_frag: "Airborne frag",
  streak_kill: "Streak kill",
  first_blood: "First blood",
  movement: "Movement",
};

const TAG_LABELS: Record<string, string> = {
  airborne: "Air",
  rocket_jump: "RJ",
  low_hp: "Low HP",
  close_range: "Close",
  long_range: "Long",
  multi_kill: "Multi",
  revenge: "Revenge",
  first_blood: "First",
  on_fire: "On fire",
  raging: "Raging",
  unstoppable: "Unstoppable",
  high_speed: "Speed",
  trick_jump: "Trick",
  height_gain: "Height",
};

/** A shot's card, as the playback controls show it when the shot starts. */
export function shotCard(segment: CinematicSegment, totalSegments: number) {
  const h = segment.highlight;
  const kills = h.killCount && h.killCount > 1 ? ` ×${h.killCount}` : "";
  return {
    kicker: `${segment.isReplay ? "Replay" : "Highlight"} ${segment.segmentIndex + 1}/${totalSegments}`,
    title: `${HIGHLIGHT_LABELS[h.type] ?? h.type.replace(/_/g, " ")}${kills}`,
    player: h.victimPlayerName ? `${h.primaryPlayerName} → ${h.victimPlayerName}` : h.primaryPlayerName,
    detail: h.weaponId ? h.weaponId.replace(/_/g, " ") : "",
    tags: h.tags.map((tag) => TAG_LABELS[tag] ?? tag.replace(/_/g, " ")),
  };
}

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

/**
 * How fast a speed change settles, per second of real time. A slow-motion
 * moment eases in and out over about a quarter of a second rather than
 * snapping from full speed.
 */
const SPEED_EASE_RATE = 12;

/** Whether a player is in the recording at the playhead: drawn, alive. */
export type PresenceCheck = (entityId: string) => boolean;

// ── CinematicDemoPlayer ───────────────────────────────────────────────────────

export class CinematicDemoPlayer {
  private readonly demoViewer: DemoViewer;
  private readonly cameraSystem: CameraSystem;

  private reel: CinematicReel | null = null;
  private cameraPaths: CameraPathResult[] = [];

  private currentSegmentIndex = 0;
  private state: CinematicPlayerState = "idle";
  /** The playback speed as eased toward the segment's keyframes. */
  private speed = 1;
  /** Whose eyes the chase camera is behind in this segment. */
  private chaseTarget: string | null = null;

  // Callbacks
  private onSegmentChangeCb: ((segment: CinematicSegment, index: number) => void) | null = null;
  private onReelEndCb: (() => void) | null = null;
  private onStateChangeCb: ((state: CinematicPlayerState) => void) | null = null;

  constructor(
    demoViewer: DemoViewer,
    cameraSystem: CameraSystem,
    private readonly isPresent: PresenceCheck = () => true,
  ) {
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

    this.reel = new SequenceBuilder().build(analysis, durationMinutes, header.tickRate, header);

    // Pre-generate camera paths for every segment
    this.cameraPaths = this.reel.segments.map((seg) =>
      generateCameraPath(seg.cameraPreset, seg.highlight, seg.startTick, seg.endTick, header.tickRate),
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

    const segment = this.reel.segments[this.currentSegmentIndex];
    if (!segment) return;

    // The playhead, not the last delivered frame: in slow motion a frame stays
    // current for several screen frames, and a camera keyed to it steps.
    const playheadTick = this.demoViewer.getInfo().playheadTick;

    // ── Segment end check ─────────────────────────────────────────
    if (playheadTick >= segment.endTick) {
      this._advanceSegment();
      return;
    }

    // ── Speed keyframes, eased ────────────────────────────────────
    let targetSpeed = segment.playbackSpeed;
    for (const kf of segment.speedKeyframes ?? []) {
      if (playheadTick >= kf.tick) targetSpeed = kf.speed;
    }
    this.speed += (targetSpeed - this.speed) * (1 - Math.exp((-SPEED_EASE_RATE * deltaMs) / 1000));
    if (Math.abs(targetSpeed - this.speed) < 0.005) this.speed = targetSpeed;
    this.demoViewer.setSpeed(this.speed);

    // ── Chase target ──────────────────────────────────────────────
    const path = this.cameraPaths[segment.segmentIndex];
    if (path?.type === "chase") this._followChaseTarget(segment, playheadTick);

    // ── Freefly camera path interpolation ─────────────────────────
    if (path?.type === "freefly" && path.keyframes?.length) {
      const { position, lookAt, fov } = interpolatePath(path.keyframes, playheadTick);

      const freeflyCtrl = this.cameraSystem.getController("freefly") as FreeflyController | undefined;
      freeflyCtrl?.setPosition(new Vector3(position.x, position.y, position.z));

      // The fly-by camera is the controller's own: the camera system's is an
      // ArcRotateCamera, so getFreeCamera() is null and shots never aimed (D2).
      const cam = freeflyCtrl?.getCamera() ?? this.cameraSystem.getFreeCamera();
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
  }

  dispose(): void {
    this.stop();
    this.onSegmentChangeCb = null;
    this.onReelEndCb = null;
    this.onStateChangeCb = null;
  }

  /** Jump to the shot that holds this point (0 – 1) of the reel. */
  skipToProgress(progress: number): void {
    if (!this.reel) return;
    const starts = this.getShotStarts();
    let index = 0;
    for (let i = 0; i < starts.length; i++) if (progress >= starts[i]) index = i;
    this.skipToSegment(index);
  }

  // ── Info ──────────────────────────────────────────────────────────────────

  /** Where each shot starts, as fractions of the reel. */
  getShotStarts(): number[] {
    const total = this.totalShotMs();
    let at = 0;
    return (this.reel?.segments ?? []).map((segment) => {
      const start = total > 0 ? at / total : 0;
      at += segment.durationMs;
      return start;
    });
  }

  /**
   * Where the reel is: the shots before this one, and how far the playhead is
   * through this one. Read from the playhead rather than counted from time,
   * so a skip or a pause leaves it right.
   */
  getReelInfo(): ReelInfo {
    const segments = this.reel?.segments ?? [];
    const segment = segments[this.currentSegmentIndex] ?? null;
    const totalMs = this.totalShotMs();
    let elapsedMs = 0;
    for (let i = 0; i < this.currentSegmentIndex && i < segments.length; i++) elapsedMs += segments[i].durationMs;
    if (segment) {
      const span = segment.endTick - segment.startTick;
      const through = span > 0 ? (this.demoViewer.getInfo().playheadTick - segment.startTick) / span : 0;
      elapsedMs += segment.durationMs * Math.max(0, Math.min(1, through));
    }
    if (this.state === "ended") elapsedMs = totalMs;
    return {
      state: this.state,
      currentSegment: this.currentSegmentIndex,
      totalSegments: this.reel?.totalSegments ?? 0,
      reelElapsedMs: elapsedMs,
      reelTotalMs: totalMs,
      reelProgress: totalMs > 0 ? Math.min(1, elapsedMs / totalMs) : 0,
      currentHighlight: segment?.highlight ?? null,
      isReplay: segment?.isReplay ?? false,
      currentSpeed: this.demoViewer.getInfo().playbackSpeed,
    };
  }

  /** The reel's running time: its shots end to end. */
  private totalShotMs(): number {
    return (this.reel?.segments ?? []).reduce((sum, segment) => sum + segment.durationMs, 0);
  }

  getState(): CinematicPlayerState {
    return this.state;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _startPlayback(): void {
    if (!this.reel || this.reel.segments.length === 0) {
      this._endReel();
      return;
    }

    this.currentSegmentIndex = 0;
    this._applySegment(this.reel.segments[0]);
    this._setState("playing");
  }

  private _applySegment(segment: CinematicSegment): void {
    this.demoViewer.seekToTick(segment.startTick);
    this.speed = segment.playbackSpeed;
    this.demoViewer.setSpeed(this.speed);
    this.demoViewer.play();

    const path = this.cameraPaths[segment.segmentIndex];

    if (path?.type === "chase") {
      this.cameraSystem.setController("spectator");
      this.chaseTarget = null;
      this._followChaseTarget(segment, segment.startTick);
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

  /**
   * Point the chase camera at the player the shot is about. A victim shot
   * watches the victim up to the frag and the killer after it: the victim
   * leaves the recording when they die, and a camera left on them holds a
   * frozen picture through the rest of a slowed shot. Whoever the shot wants
   * gives way to the other player while they are not in the recording.
   */
  private _followChaseTarget(segment: CinematicSegment, playheadTick: number): void {
    const path = this.cameraPaths[segment.segmentIndex];
    const killer = segment.highlight.primaryPlayer;
    const victim = segment.highlight.victimPlayer;
    const named = path?.targetEntityId ?? segment.cameraTarget ?? killer;
    let wanted = segment.cameraPreset === "victim_pov" && playheadTick >= segment.highlight.peakTick ? killer : named;
    const other = wanted === killer ? victim : killer;
    if (!this.isPresent(wanted) && other && this.isPresent(other)) wanted = other;
    if (!wanted || wanted === this.chaseTarget) return;
    this.chaseTarget = wanted;
    const spectator = this.cameraSystem.getController("spectator") as SpectatorController | undefined;
    spectator?.setSpectateTarget(wanted);
  }

  private _advanceSegment(): void {
    this.currentSegmentIndex++;
    if (!this.reel || this.currentSegmentIndex >= this.reel.segments.length) {
      this._endReel();
      return;
    }
    this._applySegment(this.reel.segments[this.currentSegmentIndex]);
  }

  /** The reel is the whole show: stop on its last shot, not run on into unedited footage (D6). */
  private _endReel(): void {
    this.demoViewer.pause();
    this._setState("ended");
    this.onReelEndCb?.();
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
