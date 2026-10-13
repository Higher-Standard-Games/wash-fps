/**
 * Reconstructed first-person presentation for a watched player, in demo
 * playback or live spectating.
 *
 * Snapshots and demos carry world movement, not the player's cosmetic camera
 * phase. This class rebuilds that phase by running the local camera's own view
 * effects over the sampled entity, on the clock it is handed, and reads no
 * other time. Demo playback hands it the recorded-tick playhead, so pause,
 * speed changes and seeks behave predictably; live spectating hands it wall
 * time.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { FirstPersonPose } from "../../../engine/camera/FirstPersonPose";
import type { InterpolatedEntity } from "../../../engine/network/client/SnapshotBuffer";
import { DEFAULT_VIEWHEIGHT } from "../../../engine/physics/PlayerPhysicsConstants";
import { FirstPersonEffectStack } from "../../../engine/viewport/FirstPersonEffects";
import type { PlayerState } from "../../../engine/viewport/PlayerState";
import type { ViewportDelta } from "../../../engine/viewport/ViewportDelta";

const FALLBACK_CROUCH_VIEW_OFFSET = -24;

export interface DemoPovClock {
  playheadTick: number;
  tickRate: number;
  paused: boolean;
  discontinuityId: number;
}

export interface DemoPovPresentation {
  entityId: string;
  eyeHeight: number;
  /** The view effects of their screen: the local camera's effects, on this clock. */
  effects: ViewportDelta;
  bobCycle: number;
  demoDeltaSeconds: number;
  horizontalSpeed: number;
  velocityY: number;
  grounded: boolean;
  sliding: boolean;
  landingVelocity: number;
}

export class DemoPovState {
  private readonly effects = new FirstPersonEffectStack();
  private lastEntityId: string | null = null;
  private lastDiscontinuityId: number | null = null;
  private lastPlayheadTick: number | null = null;
  private wasGrounded = true;
  private lastVelocityY = 0;
  private readonly state: PlayerState = {
    position: new Vector3(),
    velocity: new Vector3(),
    horizontalSpeed: 0,
    isGrounded: true,
    wasGroundedLastFrame: true,
    isJumping: false,
    // Snapshots carry no input: their strafe keys, and so the strafe lean, are unknown.
    strafeInput: 0,
    forwardInput: 0,
    bobCycle: 0,
  };

  update(entityId: string, sample: InterpolatedEntity, clock: DemoPovClock): DemoPovPresentation {
    const discontinuous =
      this.lastEntityId !== entityId ||
      this.lastDiscontinuityId !== clock.discontinuityId ||
      (this.lastPlayheadTick !== null && clock.playheadTick < this.lastPlayheadTick);

    if (discontinuous) {
      this.effects.reset();
      this.state.bobCycle = 0;
      this.lastPlayheadTick = clock.playheadTick;
      this.wasGrounded = sample.grounded;
      this.lastVelocityY = sample.vy;
    }

    let demoDeltaSeconds = 0;
    if (!clock.paused && !discontinuous && this.lastPlayheadTick !== null && clock.tickRate > 0) {
      demoDeltaSeconds = Math.max(0, (clock.playheadTick - this.lastPlayheadTick) / clock.tickRate);
    }

    const horizontalSpeed = Math.hypot(sample.vx, sample.vz);
    const landingVelocity = !this.wasGrounded && sample.grounded ? Math.abs(this.lastVelocityY) : 0;
    const state = this.state;
    state.position.set(sample.x, sample.y, sample.z);
    state.velocity.set(sample.vx, sample.vy, sample.vz);
    state.horizontalSpeed = horizontalSpeed;
    state.isGrounded = sample.grounded;
    state.wasGroundedLastFrame = this.wasGrounded;
    state.landingVelocity = landingVelocity;
    state.isSliding = sample.sliding;
    state.wallJumpState = sample.wallJumping ? "charging" : "none";
    const effects = this.effects.update(demoDeltaSeconds, state);

    const crouchOffset =
      sample.crouchViewOffset ?? (sample.crouching || sample.sliding ? FALLBACK_CROUCH_VIEW_OFFSET : 0);

    this.lastEntityId = entityId;
    this.lastDiscontinuityId = clock.discontinuityId;
    this.lastPlayheadTick = clock.playheadTick;
    // A held frame keeps its landing edge for the frame that moves.
    if (demoDeltaSeconds > 0 || discontinuous) {
      this.wasGrounded = sample.grounded;
      this.lastVelocityY = sample.vy;
    }

    return {
      entityId,
      eyeHeight: DEFAULT_VIEWHEIGHT + crouchOffset,
      effects,
      bobCycle: state.bobCycle ?? 0,
      demoDeltaSeconds,
      horizontalSpeed,
      velocityY: sample.vy,
      grounded: sample.grounded,
      sliding: sample.sliding,
      landingVelocity,
    };
  }

  reset(): void {
    this.effects.reset();
    this.state.bobCycle = 0;
    this.lastEntityId = null;
    this.lastDiscontinuityId = null;
    this.lastPlayheadTick = null;
    this.wasGrounded = true;
    this.lastVelocityY = 0;
  }
}

/**
 * The watched player's view this frame: the sample they are drawn with, at
 * their eye height, with their screen's effects. Every view behind someone
 * else's eyes is built here, live or recorded.
 */
export function watchedEyePose(sample: InterpolatedEntity, pov: DemoPovPresentation | null): FirstPersonPose {
  const crouchOffset =
    sample.crouchViewOffset ?? (sample.crouching || sample.sliding ? FALLBACK_CROUCH_VIEW_OFFSET : 0);
  return {
    x: sample.x,
    y: sample.y + (pov?.eyeHeight ?? DEFAULT_VIEWHEIGHT + crouchOffset),
    z: sample.z,
    yaw: sample.yaw,
    pitch: sample.pitch ?? 0,
    effects: pov?.effects ?? null,
  };
}
