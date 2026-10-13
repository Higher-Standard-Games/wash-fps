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
 * The pose comes from the shared first-person path: the interpolated sample
 * the watched player is drawn with, their eye height and their screen's view
 * effects, written as the demo viewer and the chase camera write it. No
 * smoothing here: the sample is already smooth, and more would put the view
 * behind the world around it.
 */

import type { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { applyFirstPersonPose, type FirstPersonPose, finitePose } from "../../../engine/camera/FirstPersonPose";
import { currentBaseFov } from "../../../engine/camera/FovSettings";

/** Resolves the current pose, or null while the target is unavailable. */
export type SpectateEyeProvider = () => FirstPersonPose | null;

/** The camera we drive. */
export type SpectateEyeTarget = FreeCamera;

export class SpectateEyeCamera {
  private active = false;
  private provider: SpectateEyeProvider | null = null;
  /** The last good pose, held through a gap in the snapshots. */
  private pose: FirstPersonPose | null = null;

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Begin following whoever `provider` resolves each frame.
   *
   * `seed` is where they are known to be right now, and passing it matters more
   * than it looks: a camera with nothing to show has to decline the frame, and
   * declining hands the view to whatever the caller falls back to. In the FPS
   * controller that fallback is the death tilt — so a spectate that could not
   * prime did not look like a missing camera, it looked like the screen was
   * stuck at forty degrees.
   *
   * The caller always has the seed: it picked this player by reading where they
   * were drawn. Priming from that same reading means the camera is usable on
   * the frame it is chosen, and a later gap in the snapshots is a hold rather
   * than a hand-back.
   */
  start(provider: SpectateEyeProvider, seed?: FirstPersonPose): void {
    this.active = true;
    this.provider = provider;
    this.pose = finitePose(seed);
  }

  stop(): void {
    this.active = false;
    this.provider = null;
    this.pose = null;
  }

  /**
   * Drive the camera. Returns true when it owns the view, so the caller can
   * skip the corpse camera and the fallback death tilt.
   */
  update(_dt: number, camera: SpectateEyeTarget): boolean {
    if (!this.active) return false;
    // The target stepped out of PVS, or a snapshot went missing: hold the last
    // good frame rather than releasing. Giving the view back for one frame and
    // taking it again on the next is a visible flicker between two completely
    // different camera positions.
    this.pose = finitePose(this.provider?.() ?? null) ?? this.pose;
    if (!this.pose) return false;
    applyFirstPersonPose(camera, this.pose, currentBaseFov());
    return true;
  }
}
