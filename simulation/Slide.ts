/**
 * Slide — crouchslide and crouch state management
 *
 * Manages slide entry/exit, speed decay, camera phase,
 * and crouch view offset transitions.
 *
 * TIMELINE MODEL: all timers are ABSOLUTE sim-clock deadlines/anchors
 * (`nowMs` = sequence-derived sim time from MovementProfile), never
 * accumulated deltaTime. Reconciliation replays re-simulate old inputs
 * with their original sequence numbers, so recomputing `nowMs - startMs`
 * is idempotent — the v0.9.16 "superfast slide camera" bug was exactly
 * an accumulated `elapsedTime += dt` advancing once per replay on top of
 * real time.
 */

import { InputButtons } from "../../../engine/network/components/InputComponent";
import type { Vec3 } from "../../../engine/network/components/TransformComponent";
import type { MovementInput } from "../../../engine/network/systems/movement/MovementProfile";
import type { MovementConfig } from "./MovementConfig";
import { vec3LengthXZ } from "./Vec3Helpers";

// Slide camera constants (matched from AdvancedCharacterController)
const SLIDE_FADE_MS = 400;
/** Slide-exit camera tilt fade (sim-clock anchored — see header note). */
const SLIDE_EXIT_FADE_MS = 250;
const CROUCH_HEIGHT_OFFSET = -24;
/** Crouch view transitions: snappy going down, deliberate standing up. */
const CROUCH_DOWN_MS = 140;
const CROUCH_UP_MS = 260;

/** Hermite ease-in-out. */
function smoothstep01(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

export interface SlideState {
  readonly isSliding: boolean;
  readonly isCrouching: boolean;
  readonly crouchViewOffset: number;
  readonly slidePhase: number;
  readonly slideStartMs: number;
  readonly cooldownUntilMs: number;
  readonly slideEndMs: number;
  readonly slideEndPhase: number;
  readonly crouchAnchorMs: number;
  readonly crouchFromOffset: number;
  readonly crouchTargetOffset: number;
}

export class Slide {
  isSliding: boolean = false;
  isCrouching: boolean = false;
  crouchViewOffset: number = 0;
  slidePhase: number = 0; // Camera tilt intensity (0-1)

  // Absolute sim-clock anchors (ms) — see header note
  private slideStartMs: number = 0; // Sim time when current slide began
  private cooldownUntilMs: number = 0; // Sim time when next slide is allowed
  private slideEndMs: number = 0; // Sim time the last slide ended (exit tilt fade)
  private slideEndPhase: number = 0; // slidePhase captured at slide exit
  private crouchAnchorMs: number = 0; // Sim time the crouch target last flipped
  private crouchFromOffset: number = 0; // Offset value at the flip
  private crouchTargetOffset: number = 0; // Current transition target

  /** True while the post-slide cooldown deadline is in the future */
  isOnCooldown(nowMs: number): boolean {
    return nowMs < this.cooldownUntilMs;
  }

  /** Everything that carries from one step to the next, for a replay to resume from. */
  saveState(): SlideState {
    return {
      isSliding: this.isSliding,
      isCrouching: this.isCrouching,
      crouchViewOffset: this.crouchViewOffset,
      slidePhase: this.slidePhase,
      slideStartMs: this.slideStartMs,
      cooldownUntilMs: this.cooldownUntilMs,
      slideEndMs: this.slideEndMs,
      slideEndPhase: this.slideEndPhase,
      crouchAnchorMs: this.crouchAnchorMs,
      crouchFromOffset: this.crouchFromOffset,
      crouchTargetOffset: this.crouchTargetOffset,
    };
  }

  loadState(state: SlideState): void {
    this.isSliding = state.isSliding;
    this.isCrouching = state.isCrouching;
    this.crouchViewOffset = state.crouchViewOffset;
    this.slidePhase = state.slidePhase;
    this.slideStartMs = state.slideStartMs;
    this.cooldownUntilMs = state.cooldownUntilMs;
    this.slideEndMs = state.slideEndMs;
    this.slideEndPhase = state.slideEndPhase;
    this.crouchAnchorMs = state.crouchAnchorMs;
    this.crouchFromOffset = state.crouchFromOffset;
    this.crouchTargetOffset = state.crouchTargetOffset;
  }

  /** Reset state for reconciliation */
  reset(): void {
    this.isSliding = false;
    this.isCrouching = false;
    this.slidePhase = 0;
    this.slideStartMs = 0;
    this.cooldownUntilMs = 0;
    this.slideEndMs = 0;
    this.slideEndPhase = 0;
    this.crouchAnchorMs = 0;
    this.crouchFromOffset = 0;
    this.crouchTargetOffset = 0;
  }

  /**
   * Update slide state machine.
   * Mutates vel in-place for slide boost/decay.
   *
   * @param nowMs Absolute sim time (sequence-derived; replay-idempotent)
   */
  update(
    vel: Vec3,
    input: MovementInput,
    isGrounded: boolean,
    nowMs: number,
    deltaTime: number,
    config: MovementConfig,
  ): void {
    const isCrouching = input.isPressed(InputButtons.CROUCH);
    const isJumping = input.isPressed(InputButtons.JUMP);
    const horizSpeed = vec3LengthXZ(vel);

    if (!this.isSliding) {
      // Check if we should enter slide
      const canSlide = isGrounded && isCrouching && horizSpeed >= config.slideMinSpeed && !this.isOnCooldown(nowMs);

      if (canSlide) {
        this.isSliding = true;
        this.slideStartMs = nowMs;
        this.slidePhase = 0;

        // Boost on entry
        const boost = config.slideSpeedMultiplier;
        vel.x *= boost;
        vel.z *= boost;
      } else {
        // Not sliding — fade the exit tilt from a sim-clock anchor. The old
        // per-call decay (`slidePhase *= 0.85`) advanced once per simulate()
        // call, so reconciliation replays fast-forwarded it (same class of
        // bug as the v0.9.16 slide-timer fix) — the get-up read as a flick.
        if (this.slideEndPhase > 0) {
          const t = (nowMs - this.slideEndMs) / SLIDE_EXIT_FADE_MS;
          this.slidePhase = t >= 1 ? 0 : this.slideEndPhase * (1 - smoothstep01(t));
          if (this.slidePhase === 0) this.slideEndPhase = 0;
        } else {
          this.slidePhase = 0;
        }
      }
    } else {
      // Currently sliding — elapsed derives from the sim clock, not accumulation
      const slideElapsed = nowMs - this.slideStartMs;
      const slideDuration = config.slideDuration;

      // === COMPUTE SLIDE PHASE (camera tilt intensity) ===
      const fadeMs = SLIDE_FADE_MS;
      const timeRemaining = slideDuration - slideElapsed;

      if (slideElapsed < fadeMs) {
        const t = Math.max(0, slideElapsed) / fadeMs;
        this.slidePhase = t * t * (3 - 2 * t);
      } else if (timeRemaining < fadeMs) {
        const t = Math.max(0, timeRemaining) / fadeMs;
        this.slidePhase = t * t * (3 - 2 * t);
      } else {
        this.slidePhase = 1;
      }

      // Exit conditions
      const slideExpired = slideElapsed >= slideDuration;
      const tooSlow = horizSpeed < 50;
      const releasedCrouch = !isCrouching;
      const jumpCancel = isJumping && slideElapsed > 100;

      if (slideExpired || tooSlow || releasedCrouch || jumpCancel) {
        this.exit(vel, nowMs, config);

        // Jump boost on cancel
        if (jumpCancel) {
          vel.y = config.jumpVelocity;
          const boost = config.slideJumpBoost;
          vel.x *= boost;
          vel.z *= boost;
        }
      } else {
        // Apply slide decay
        const decay = config.slideDecay * deltaTime;
        const currentSpeed = vec3LengthXZ(vel);
        const newSpeed = Math.max(50, currentSpeed - decay);
        const scale = newSpeed / currentSpeed;
        vel.x *= scale;
        vel.z *= scale;
      }
    }
  }

  /** Exit slide and start cooldown */
  exit(_vel: Vec3, nowMs: number, config?: MovementConfig): void {
    this.isSliding = false;
    if (config) {
      this.cooldownUntilMs = nowMs + config.slideCooldown;
    }
    // Anchor the exit tilt fade (resolved in the non-sliding branch)
    this.slideEndMs = nowMs;
    this.slideEndPhase = this.slidePhase;
  }

  /**
   * Update crouch state and view offset transitions.
   *
   * The offset is a pure function of the sim clock: when the crouch target
   * flips, we anchor (nowMs, current offset) and smoothstep toward the new
   * target over a fixed duration — snappy down, deliberate up. The previous
   * per-call exponential lerp (`+= delta * 0.2`) advanced on every simulate()
   * call, so reconciliation replays fast-forwarded the get-up into a flick.
   */
  updateCrouch(input: MovementInput, nowMs: number): void {
    const wantsCrouch = input.isPressed(InputButtons.CROUCH) || this.isSliding;
    this.isCrouching = wantsCrouch;

    const targetOffset = this.isCrouching ? CROUCH_HEIGHT_OFFSET : 0;
    if (targetOffset !== this.crouchTargetOffset) {
      this.crouchFromOffset = this.crouchViewOffset;
      this.crouchTargetOffset = targetOffset;
      this.crouchAnchorMs = nowMs;
    }

    const durationMs = this.crouchTargetOffset === 0 ? CROUCH_UP_MS : CROUCH_DOWN_MS;
    const t = smoothstep01((nowMs - this.crouchAnchorMs) / durationMs);
    this.crouchViewOffset = this.crouchFromOffset + (this.crouchTargetOffset - this.crouchFromOffset) * t;
  }
}
