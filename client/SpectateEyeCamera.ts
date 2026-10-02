/**
 * SpectateEyeCamera — watch a living player from behind their eyes.
 *
 * The dead half of a round mode is still the round. In Search & Destroy you can
 * be out at fifteen seconds and have another minute of match to read, so what a
 * dead player sees is not a consolation view — it is how they follow the round
 * they still have a stake in, and how they learn the site they just lost.
 *
 * That view is first person, for the same reason the game is: it is the frame
 * the mode is actually played in. A camera slung behind someone's shoulders
 * shows you their back, not their fight — you cannot see what they are aiming
 * at, you lose the corner they are holding, and in a corridor the wall clamp
 * pushes the camera into the model until it fills the screen.
 *
 * Distinct from {@link DeathCamera}, which is a third-person chase and stays
 * that way: it exists to watch a RAGDOLL, which has no eyes and no view angles,
 * and is worth a couple of seconds after you go down. These are two different
 * jobs that happen to run back to back, not one job with a flag.
 *
 * Position and angles both come from the same snapshot, so the head and the
 * body are never a frame apart. Smoothing lives here rather than in the caller
 * because the raw source updates at the snapshot rate, not the frame rate.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { DEFAULT_VIEWHEIGHT } from "../../../engine/physics/PlayerPhysicsConstants";

/** One frame of the watched player: where they are, and where they are looking. */
export interface SpectateEyeSample {
  /** Entity origin, in the space the renderer draws them in. */
  x: number;
  y: number;
  z: number;
  /** View angles in radians, as the server received them from their input. */
  yaw: number;
  pitch: number;
  /** Eye offset above the origin. Defaults to the standing height. */
  eyeHeight?: number;
  /** Camera-local stride sway, as the watched player's own screen moved. */
  bobRight?: number;
  bobUp?: number;
  pitchOffsetDegrees?: number;
  rollDegrees?: number;
}

const DEG = Math.PI / 180;

/** Resolves the current sample, or null while the target is unavailable. */
export type SpectateEyeProvider = () => SpectateEyeSample | null;

/** Minimal camera surface we drive; a Babylon FreeCamera satisfies it. */
export interface SpectateEyeTarget {
  position: Vector3;
  rotation: Vector3;
}

/**
 * Exponential follow rate, per second.
 *
 * Chosen so a 60fps frame lands near the 0.25 blend the demo POV spectator
 * already uses — fast enough that it does not read as lag on a flick, slow
 * enough to absorb the step between snapshots.
 */
const SMOOTH_RATE = 18;

/**
 * Past this, the target did not move — they teleported, respawned, or we were
 * pointed at someone else entirely. Cut instead of flying across the map.
 */
const SNAP_DISTANCE = 400;

/** Signed shortest way round from one angle to another. */
function shortestAngle(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export class SpectateEyeCamera {
  private active = false;
  private provider: SpectateEyeProvider | null = null;
  /** True once a real sample has landed, so the first frame snaps. */
  private primed = false;
  private readonly pos = new Vector3();
  private yaw = 0;
  private pitch = 0;
  /** Sway from the latest sample, laid over the smoothed pose rather than smoothed itself. */
  private sway = { right: 0, up: 0, pitch: 0, roll: 0 };

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Begin following whoever `provider` resolves each frame.
   *
   * `seed` is where they are known to be right now, and passing it matters more
   * than it looks: an unprimed camera with nothing to show has to decline the
   * frame, and declining hands the view to whatever the caller falls back to.
   * In the FPS controller that fallback is the death tilt — so a spectate that
   * could not prime did not look like a missing camera, it looked like the
   * screen was stuck at forty degrees.
   *
   * The caller always has the seed: it picked this player by reading where they
   * were drawn. Priming from that same reading means the camera is usable on
   * the frame it is chosen, and a later gap in the snapshots is a hold rather
   * than a hand-back.
   */
  start(provider: SpectateEyeProvider, seed?: SpectateEyeSample): void {
    this.active = true;
    this.provider = provider;
    this.primed = false;
    this.sway = { right: 0, up: 0, pitch: 0, roll: 0 };

    const sane = this.sane(seed ?? null);
    if (sane) {
      this.snapTo(sane, sane.y + (sane.eyeHeight ?? DEFAULT_VIEWHEIGHT));
      this.primed = true;
    }
  }

  stop(): void {
    this.active = false;
    this.provider = null;
    this.primed = false;
  }

  /**
   * Drive the camera. Returns true when it owns the view, so the caller can
   * skip the corpse camera and the fallback death tilt.
   */
  update(dt: number, camera: SpectateEyeTarget): boolean {
    if (!this.active) return false;

    const sample = this.sane(this.provider?.() ?? null);
    if (!sample) {
      // The target stepped out of PVS, or a snapshot went missing. Hold the
      // last good frame rather than releasing: giving the view back for one
      // frame and taking it again on the next is a visible flicker between two
      // completely different camera positions.
      if (!this.primed) return false;
      this.write(camera);
      return true;
    }

    const eyeY = sample.y + (sample.eyeHeight ?? DEFAULT_VIEWHEIGHT);
    this.sway = {
      right: sample.bobRight ?? 0,
      up: sample.bobUp ?? 0,
      pitch: (sample.pitchOffsetDegrees ?? 0) * DEG,
      roll: (sample.rollDegrees ?? 0) * DEG,
    };

    if (!this.primed) {
      this.snapTo(sample, eyeY);
      this.primed = true;
    } else {
      const dx = sample.x - this.pos.x;
      const dy = eyeY - this.pos.y;
      const dz = sample.z - this.pos.z;
      if (dx * dx + dy * dy + dz * dz > SNAP_DISTANCE * SNAP_DISTANCE) {
        this.snapTo(sample, eyeY);
      } else {
        const k = 1 - Math.exp(-SMOOTH_RATE * dt);
        this.pos.x += dx * k;
        this.pos.y += dy * k;
        this.pos.z += dz * k;
        this.yaw += shortestAngle(this.yaw, sample.yaw) * k;
        this.pitch += (sample.pitch - this.pitch) * k;
      }
    }

    this.write(camera);
    return true;
  }

  private snapTo(sample: SpectateEyeSample, eyeY: number): void {
    this.pos.set(sample.x, eyeY, sample.z);
    this.yaw = sample.yaw;
    this.pitch = sample.pitch;
  }

  private write(camera: SpectateEyeTarget): void {
    // Sideways sway follows the camera's own right axis, as the local view does.
    const { right, up, pitch, roll } = this.sway;
    camera.position.set(
      this.pos.x + Math.cos(this.yaw) * right,
      this.pos.y + up,
      this.pos.z - Math.sin(this.yaw) * right,
    );
    // Roll is only ever the stride's. The FPS controller writes a death roll
    // into this same camera on its way here, and a spectator view that
    // inherits it is a screen stuck permanently sideways.
    camera.rotation.set(this.pitch + pitch, this.yaw, roll);
  }

  /** Reject a sample that would put the camera somewhere undefined. */
  private sane(sample: SpectateEyeSample | null): SpectateEyeSample | null {
    if (!sample) return null;
    const finite =
      Number.isFinite(sample.x) &&
      Number.isFinite(sample.y) &&
      Number.isFinite(sample.z) &&
      Number.isFinite(sample.yaw) &&
      Number.isFinite(sample.pitch);
    return finite ? sample : null;
  }
}
