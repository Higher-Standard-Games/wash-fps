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
const CROUCH_HEIGHT_OFFSET = -24;
const CROUCH_TRANSITION_SPEED = 0.2;

export class Slide {
  isSliding: boolean = false;
  isCrouching: boolean = false;
  crouchViewOffset: number = 0;
  slidePhase: number = 0; // Camera tilt intensity (0-1)

  // Absolute sim-clock anchors (ms) — see header note
  private slideStartMs: number = 0; // Sim time when current slide began
  private cooldownUntilMs: number = 0; // Sim time when next slide is allowed

  /** True while the post-slide cooldown deadline is in the future */
  isOnCooldown(nowMs: number): boolean {
    return nowMs < this.cooldownUntilMs;
  }

  /** Reset state for reconciliation */
  reset(): void {
    this.isSliding = false;
    this.isCrouching = false;
    this.slidePhase = 0;
    this.slideStartMs = 0;
    this.cooldownUntilMs = 0;
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
        // Not sliding - decay phase
        this.slidePhase *= 0.85;
        if (this.slidePhase < 0.01) this.slidePhase = 0;
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
    // slidePhase will decay naturally in the non-sliding branch
  }

  /** Update crouch state and view offset transitions */
  updateCrouch(input: MovementInput, _deltaTime: number): void {
    const wantsCrouch = input.isPressed(InputButtons.CROUCH) || this.isSliding;
    this.isCrouching = wantsCrouch;

    const targetOffset = this.isCrouching ? CROUCH_HEIGHT_OFFSET : 0;
    this.crouchViewOffset += (targetOffset - this.crouchViewOffset) * CROUCH_TRANSITION_SPEED;
  }
}
