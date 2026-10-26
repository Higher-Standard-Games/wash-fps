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
import { PLAYER_ORIGIN_HEIGHT } from "../../../shared/bsp/SpawnPointTable";
import { type CameraPathResult, generateCameraPath, interpolatePath } from "../../../shared/demo/CinematicCameraPaths";
import type { DemoAnalysis, GroundClearance, HighlightCandidate } from "../../../shared/demo/DemoAnalyzer";
import { DemoAnalyzer } from "../../../shared/demo/DemoAnalyzer";
import { type DemoHeader, DemoReader } from "../../../shared/demo/DemoReader";
import { type CinematicReel, type CinematicSegment, SequenceBuilder } from "../../../shared/demo/SequenceBuilder";
import type { DemoViewer } from "./DemoViewer";
import { type ReelSummary, type ReelTitle, reelSummary, reelTitle } from "./ReelCards";

// ── Public types ──────────────────────────────────────────────────────────────

export type CinematicPlayerState = "idle" | "analyzing" | "playing" | "paused" | "ended";

const HIGHLIGHT_LABELS: Record<string, string> = {
  frag: "Frag",
  multi_kill: "Multi kill",
  airborne_frag: "Airborne frag",
  streak_kill: "Streak kill",
  first_blood: "First blood",
  movement: "Trick jump",
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
  trick_jump: "Combo",
  height_gain: "Climb",
  wall_jump: "Wall jump",
  slide: "Slide",
  bunny_hop: "Hops",
};

/** A shot's card, as the playback controls show it when the shot starts. */
export function shotCard(segment: CinematicSegment, totalScenes: number) {
  const h = segment.highlight;
  const kills = h.killCount && h.killCount > 1 ? ` ×${h.killCount}` : "";
  return {
    kicker: `${segment.isReplay ? "Replay" : "Highlight"} ${segment.scene + 1}/${totalScenes}`,
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
  /** The scene (highlight) the current shot belongs to, 0-based. */
  currentScene: number;
  /** Highlights in the reel; each is a scene of several shots. */
  totalScenes: number;
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

/** How long the reel takes to fade in from black at its start and out to black at its end. */
const REEL_FADE_MS = 1000;

/** How strongly a crossfade between two shots dips through black at its deepest. */
const CROSSFADE_DIP = 0.6;
/** A white flash's brightest, so the frame under it still reads. */
const FLASH_PEAK = 0.9;

/** A full-screen veil over the picture, for the reel's transitions. */
export interface ReelVeil {
  color: "black" | "white";
  /** 0 clear – 1 covered. */
  opacity: number;
}

type Vec3 = { x: number; y: number; z: number };

/** What the reel reads from the scene it plays in. */
export interface ReelWorld {
  /** Where a player is drawn at the playhead, or null while they are not in the recording. */
  positionOf(entityId: string): Vec3 | null;
  /** Where the line from `from` to `to` first meets the map, or null if it is clear. */
  blockedAt(from: Vec3, to: Vec3): Vec3 | null;
}

const NO_WORLD: ReelWorld = { positionOf: () => null, blockedAt: () => null };

/** How far below a player the ground is looked for when scoring airborne frags. */
const GROUND_PROBE_DEPTH = 1024;

/** Feet height above the map below a player origin, measured in `world`; null where it cannot tell. */
export function groundClearanceIn(world: ReelWorld): GroundClearance {
  return (origin) => {
    const floor = world.blockedAt(origin, { x: origin.x, y: origin.y - GROUND_PROBE_DEPTH, z: origin.z });
    return floor ? Math.max(0, origin.y - floor.y - PLAYER_ORIGIN_HEIGHT) : null;
  };
}

/** How fast the fly-by camera turns toward the players and settles on its spot, per second. */
const FLYBY_FOLLOW_RATE = 8;
/** How far in front of a wall a pulled-in fly-by camera stops. */
const WALL_MARGIN = 24;
/** Aim at a player's chest rather than their origin. */
const CHEST_HEIGHT = 12;
/** Players further apart than this don't fit one fly-by shot; it keeps to the killer. */
const FRAME_BOTH_WITHIN = 300;

// ── CinematicDemoPlayer ───────────────────────────────────────────────────────

export class CinematicDemoPlayer {
  private readonly demoViewer: DemoViewer;
  private readonly cameraSystem: CameraSystem;

  private reel: CinematicReel | null = null;
  private cameraPaths: CameraPathResult[] = [];
  private tickRate = 60;
  /** Real time the current shot has been playing, for its way in. */
  private shotPlayedMs = 0;
  /** The fly-by camera's eased spot and aim; null until a shot's first frame. */
  private flybyPos: Vec3 | null = null;
  private flybyLook: Vec3 | null = null;

  private currentSegmentIndex = 0;
  private state: CinematicPlayerState = "idle";
  /** The playback speed as eased toward the segment's keyframes. */
  private speed = 1;
  /** Whose eyes the chase camera is behind in this segment. */
  private chaseTarget: string | null = null;
  /** The fly-by camera's own field of view, from before the reel first changed it. */
  private baseFov: number | null = null;
  /** How long the reel holds on black under its title card before the first shot. */
  private readonly titleHoldTotalMs: number;
  /** What is left of that hold; 0 once the first shot plays. */
  private titleHoldMs = 0;
  private header: DemoHeader | null = null;
  private analysis: DemoAnalysis | null = null;

  // Callbacks
  private onSegmentChangeCb: ((segment: CinematicSegment, index: number) => void) | null = null;
  private onReelEndCb: (() => void) | null = null;
  private onStateChangeCb: ((state: CinematicPlayerState) => void) | null = null;

  constructor(
    demoViewer: DemoViewer,
    cameraSystem: CameraSystem,
    private readonly world: ReelWorld = NO_WORLD,
    options: { titleHoldMs?: number } = {},
  ) {
    this.demoViewer = demoViewer;
    this.cameraSystem = cameraSystem;
    this.titleHoldTotalMs = options.titleHoldMs ?? 0;
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
    const analysis: DemoAnalysis = new DemoAnalyzer(groundClearanceIn(this.world)).analyze(
      frames,
      header,
      index.durationMs,
    );

    this.tickRate = header.tickRate;
    this.header = header;
    this.analysis = analysis;
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

    // The title card over black: the first shot waits, already in place
    if (this.titleHoldMs > 0) {
      this.titleHoldMs = Math.max(0, this.titleHoldMs - deltaMs);
      if (this.titleHoldMs === 0) this.demoViewer.play();
      return;
    }

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
    this.shotPlayedMs += deltaMs;
    this.speed += (targetSpeed - this.speed) * (1 - Math.exp((-SPEED_EASE_RATE * deltaMs) / 1000));
    if (Math.abs(targetSpeed - this.speed) < 0.005) this.speed = targetSpeed;
    this.demoViewer.setSpeed(this.speed);

    // ── Chase target ──────────────────────────────────────────────
    const path = this.cameraPaths[segment.segmentIndex];
    if (path?.type === "chase") this._followChaseTarget(segment, playheadTick);

    // ── Freefly camera path interpolation ─────────────────────────
    if (path?.type === "freefly" && path.keyframes?.length) {
      const planned = interpolatePath(path.keyframes, playheadTick, path.interpolation);
      const { position, lookAt } = this._frameFlyby(segment, planned.position, planned.lookAt, deltaMs);
      // A path that sets its own field of view (the zoom) uses it; every other
      // shot gets the camera's own back, so a zoom never carries into later shots
      const fov = path.keyframes.some((kf) => kf.fov !== undefined) ? planned.fov * (Math.PI / 180) : this.baseFov;

      const freeflyCtrl = this.cameraSystem.getController("freefly") as FreeflyController | undefined;
      freeflyCtrl?.setPosition(new Vector3(position.x, position.y, position.z));

      // The fly-by camera is the controller's own: the camera system's is an
      // ArcRotateCamera, so getFreeCamera() is null and shots never aimed (D2).
      const cam = freeflyCtrl?.getCamera() ?? this.cameraSystem.getFreeCamera();
      if (cam) {
        const { pitch, yaw } = this._lookAtRotation(position, lookAt);
        cam.rotation.set(pitch, yaw, 0);
        this.baseFov ??= cam.fov;
        cam.fov = fov ?? cam.fov;
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
    if (this.titleHoldMs === 0) this.demoViewer.play();
  }

  togglePlayPause(): void {
    if (this.state === "playing") this.pause();
    else if (this.state === "paused") this.resume();
  }

  skipToSegment(index: number): void {
    if (!this.reel) return;
    const clamped = Math.max(0, Math.min(index, this.reel.segments.length - 1));
    this.currentSegmentIndex = clamped;
    this.titleHoldMs = 0;
    this._applySegment(this.reel.segments[clamped]);
    if (this.state === "paused" || this.state === "ended") this._setState("playing");
  }

  /** Play the reel again from its first shot, its title card and opening fade and all. */
  replay(): void {
    this.skipToSegment(0);
    this._holdForTitle();
  }

  /** The reel is holding on black under its title card. */
  isShowingTitle(): boolean {
    return this.titleHoldMs > 0 && this.state !== "ended";
  }

  /** The opening card for this reel's demo; null before one is loaded. */
  getTitle(): ReelTitle | null {
    return this.header ? reelTitle(this.header) : null;
  }

  /** The closing card for this reel; null before one is built. */
  getSummary(): ReelSummary | null {
    const reel = this.reel;
    if (!reel || !this.analysis) return null;
    return reelSummary(reel, this.analysis, (segment) => shotCard(segment, reel.totalScenes).title);
  }

  private _holdForTitle(): void {
    if (this.titleHoldTotalMs <= 0) return;
    this.titleHoldMs = this.titleHoldTotalMs;
    this.demoViewer.pause();
  }

  nextSegment(): void {
    this.skipToSegment(this.currentSegmentIndex + 1);
  }

  prevSegment(): void {
    this.skipToSegment(Math.max(0, this.currentSegmentIndex - 1));
  }

  stop(): void {
    this._restoreFov();
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
      currentScene: segment?.scene ?? 0,
      totalSegments: this.reel?.totalSegments ?? 0,
      totalScenes: this.reel?.totalScenes ?? 0,
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

  /** Give the fly-by camera back the field of view it had before the reel. */
  private _restoreFov(): void {
    if (this.baseFov === null) return;
    const freeflyCtrl = this.cameraSystem.getController("freefly") as FreeflyController | undefined;
    const cam = freeflyCtrl?.getCamera() ?? this.cameraSystem.getFreeCamera();
    if (cam) cam.fov = this.baseFov;
    this.baseFov = null;
  }

  private _startPlayback(): void {
    if (!this.reel || this.reel.segments.length === 0) {
      this._endReel();
      return;
    }

    this.currentSegmentIndex = 0;
    this._applySegment(this.reel.segments[0]);
    this._setState("playing");
    this._holdForTitle();
  }

  /**
   * The veil over the picture now: a shot's way in (from black at the start,
   * a white flash into a replay, a dip through black between two players'
   * shots) and its way out (to black at the end, the flash rising into a
   * replay). A cut is clear.
   */
  getVeil(): ReelVeil {
    // Once the reel has ended it stays on its closing black: the index has run past its last shot
    if (this.state === "ended") {
      const last = this.reel?.segments.at(-1);
      return { color: "black", opacity: last?.transitionOut === "fade_to_black" ? 1 : 0 };
    }
    const segment = this.reel?.segments[this.currentSegmentIndex];
    if (!segment) return { color: "black", opacity: 0 };
    if (this.titleHoldMs > 0) return { color: "black", opacity: 1 };
    const span = Math.max(1, segment.transitionDurationMs);
    // The reel opens out of black and closes into it over a full second, so a
    // recording of it starts and ends clean for editing
    const first = this.currentSegmentIndex === 0;
    const last = this.currentSegmentIndex === (this.reel?.segments.length ?? 0) - 1;
    const into = 1 - Math.min(1, this.shotPlayedMs / (first ? REEL_FADE_MS : span));
    const ticksLeft = segment.endTick - this.demoViewer.getInfo().playheadTick;
    const msLeft = ((ticksLeft / this.tickRate) * 1000) / Math.max(0.05, this.speed);
    const out = 1 - Math.min(1, Math.max(0, msLeft) / (last ? REEL_FADE_MS : span));

    let veil: ReelVeil = { color: "black", opacity: 0 };
    const take = (color: ReelVeil["color"], opacity: number) => {
      if (opacity > veil.opacity) veil = { color, opacity };
    };
    if (segment.transitionIn === "fade_to_black") take("black", into);
    if (segment.transitionIn === "white_flash") take("white", FLASH_PEAK * into * into);
    if (segment.transitionIn === "crossfade") take("black", CROSSFADE_DIP * into);
    if (segment.transitionOut === "fade_to_black") take("black", out);
    if (segment.transitionOut === "white_flash") take("white", FLASH_PEAK * out * out);
    const next = this.reel?.segments[this.currentSegmentIndex + 1];
    if (next?.transitionIn === "crossfade") take("black", CROSSFADE_DIP * out);
    return veil;
  }

  private _applySegment(segment: CinematicSegment): void {
    this.shotPlayedMs = 0;
    this.flybyPos = null;
    this.flybyLook = null;
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
    const present = (id: string) => this.world.positionOf(id) !== null;
    if (!present(wanted) && other && present(other)) wanted = other;
    if (!wanted || wanted === this.chaseTarget) return;
    this.chaseTarget = wanted;
    const spectator = this.cameraSystem.getController("spectator") as SpectatorController | undefined;
    spectator?.setSpectateTarget(wanted);
  }

  /**
   * Aim a fly-by at the players the shot is about, as they are drawn, and keep
   * a wall from coming between the camera and them. The path gives the
   * camera's way round; the players give where it looks. Both ease, so a
   * player leaving the recording or a wall cutting in never snaps the shot.
   */
  private _frameFlyby(
    segment: CinematicSegment,
    plannedPos: Vec3,
    plannedLook: Vec3,
    deltaMs: number,
  ): { position: Vec3; lookAt: Vec3 } {
    // The shot is the killer's play: look at them, and at the victim too only
    // while the two fit one frame. Aiming between two players across a room
    // shows neither. A scene's ending orbits the frag itself, so when the two
    // are apart it watches the victim take the hit.
    const killer = this.world.positionOf(segment.highlight.primaryPlayer);
    const victim = segment.highlight.victimPlayer ? this.world.positionOf(segment.highlight.victimPlayer) : null;
    const together =
      killer &&
      victim &&
      Math.hypot(killer.x - victim.x, killer.y - victim.y, killer.z - victim.z) <= FRAME_BOTH_WITHIN;
    const lead = segment.cameraPreset === "replay_orbit" ? (victim ?? killer) : (killer ?? victim);
    const subjects = together ? [killer, victim] : [lead].filter((p): p is Vec3 => p !== null);
    const focus = subjects.length
      ? {
          x: subjects.reduce((sum, p) => sum + p.x, 0) / subjects.length,
          y: subjects.reduce((sum, p) => sum + p.y, 0) / subjects.length + CHEST_HEIGHT,
          z: subjects.reduce((sum, p) => sum + p.z, 0) / subjects.length,
        }
      : plannedLook;

    let target = plannedPos;
    const wall = this.world.blockedAt(focus, plannedPos);
    if (wall) {
      const dx = focus.x - wall.x;
      const dy = focus.y - wall.y;
      const dz = focus.z - wall.z;
      const length = Math.hypot(dx, dy, dz) || 1;
      const margin = Math.min(WALL_MARGIN, length / 2) / length;
      target = { x: wall.x + dx * margin, y: wall.y + dy * margin, z: wall.z + dz * margin };
    }

    const k = 1 - Math.exp((-FLYBY_FOLLOW_RATE * deltaMs) / 1000);
    const ease = (from: Vec3 | null, to: Vec3): Vec3 =>
      from ? { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: from.z + (to.z - from.z) * k } : to;
    this.flybyPos = ease(this.flybyPos, target);
    this.flybyLook = ease(this.flybyLook, focus);
    return { position: this.flybyPos, lookAt: this.flybyLook };
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
