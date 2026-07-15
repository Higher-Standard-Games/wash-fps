/**
 * Reconstructed first-person presentation for a followed demo entity.
 *
 * The authoritative demo records world movement, not the original client's
 * cosmetic camera phase. This class rebuilds that phase from the sampled
 * entity and the recorded-tick playhead. It deliberately never consumes wall
 * time, so pause, speed changes, and seeks have predictable behavior.
 */

import { Cvar } from "../../../engine/core/Cvar";
import type { InterpolatedEntity } from "../../../engine/network/client/SnapshotBuffer";
import { DEFAULT_VIEWHEIGHT } from "../../../engine/physics/PlayerPhysicsConstants";
import { WalkBobEffect } from "../../../engine/viewport/effects/WalkBobEffect";

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
  cameraBobRight: number;
  cameraBobUp: number;
  cameraPitchDegrees: number;
  cameraRollDegrees: number;
  bobCycle: number;
  demoDeltaSeconds: number;
  horizontalSpeed: number;
  velocityY: number;
  grounded: boolean;
  sliding: boolean;
  landingVelocity: number;
}

export class DemoPovState {
  private bobCycle = 0;
  private currentLean = 0;
  private lastEntityId: string | null = null;
  private lastDiscontinuityId: number | null = null;
  private lastPlayheadTick: number | null = null;
  private wasGrounded = true;
  private lastVelocityY = 0;

  constructor() {
    WalkBobEffect.ensureCvars();
  }

  update(entityId: string, sample: InterpolatedEntity, clock: DemoPovClock): DemoPovPresentation {
    const discontinuous =
      this.lastEntityId !== entityId ||
      this.lastDiscontinuityId !== clock.discontinuityId ||
      (this.lastPlayheadTick !== null && clock.playheadTick < this.lastPlayheadTick);

    if (discontinuous) {
      this.bobCycle = 0;
      this.currentLean = 0;
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
    let cameraBobRight = 0;
    let cameraBobUp = 0;
    let cameraPitchDegrees = 0;
    let cameraRollDegrees = 0;
    const bobActive = Cvar.getNumber("cg_bob") !== 0 && !sample.sliding && sample.grounded && horizontalSpeed >= 10;
    if (bobActive) {
      // Single-source bob formula (shared with the live WalkBobEffect — the
      // two can never drift apart); only the clock/lean integration is
      // demo-specific (recorded-tick time, exp smoothing).
      const bob = WalkBobEffect.computeBob(this.bobCycle, horizontalSpeed, demoDeltaSeconds);
      this.bobCycle = bob.newBobCycle;
      cameraBobUp = bob.bobUp;
      cameraBobRight = bob.bobRight;
      cameraRollDegrees = bob.rollDegrees;
      this.currentLean += (bob.targetLean - this.currentLean) * (1 - Math.exp(-demoDeltaSeconds * 5));
      cameraPitchDegrees = this.currentLean;
    } else {
      // The live effect's inactive decay is render-call based. For demos, keep
      // the visible result neutral and decay hidden lean only by recorded time.
      this.currentLean += (0 - this.currentLean) * (1 - Math.exp(-demoDeltaSeconds * 5));
    }
    const crouchOffset =
      sample.crouchViewOffset ?? (sample.crouching || sample.sliding ? FALLBACK_CROUCH_VIEW_OFFSET : 0);

    this.lastEntityId = entityId;
    this.lastDiscontinuityId = clock.discontinuityId;
    this.lastPlayheadTick = clock.playheadTick;
    this.wasGrounded = sample.grounded;
    this.lastVelocityY = sample.vy;

    return {
      entityId,
      eyeHeight: DEFAULT_VIEWHEIGHT + crouchOffset,
      cameraBobRight,
      cameraBobUp,
      cameraPitchDegrees,
      cameraRollDegrees,
      bobCycle: this.bobCycle,
      demoDeltaSeconds,
      horizontalSpeed,
      velocityY: sample.vy,
      grounded: sample.grounded,
      sliding: sample.sliding,
      landingVelocity,
    };
  }

  reset(): void {
    this.bobCycle = 0;
    this.currentLean = 0;
    this.lastEntityId = null;
    this.lastDiscontinuityId = null;
    this.lastPlayheadTick = null;
    this.wasGrounded = true;
    this.lastVelocityY = 0;
  }
}
