/**
 * Slide — crouchslide and crouch state management
 *
 * Manages slide entry/exit, speed decay, camera phase,
 * and crouch view offset transitions.
 */

import { InputButtons } from "../../../engine/network/components/InputComponent";
import type { Vec3 } from "../../../engine/network/components/TransformComponent";
import type { MovementInput } from "../../../engine/network/systems/movement/MovementProfile";
import type { MovementConfig } from "./MovementConfig";
import { vec3Clone, vec3LengthXZ } from "./Vec3Helpers";

// Slide camera constants (matched from AdvancedCharacterController)
const SLIDE_FADE_MS = 400;
const CROUCH_HEIGHT_OFFSET = -24;
const CROUCH_TRANSITION_SPEED = 0.2;

export class Slide {
  isSliding: boolean = false;
  isCrouching: boolean = false;
  crouchViewOffset: number = 0;
  slidePhase: number = 0; // Camera tilt intensity (0-1)

  // Internal slide state
  private elapsedTime: number = 0; // Accumulated slide duration (ms)
  cooldownRemaining: number = 0; // Countdown timer (ms)
  // @ts-expect-error TS6133 — slideVelocity is written during slide entry and read indirectly
  private slideVelocity: Vec3 = { x: 0, y: 0, z: 0 };

  /** Tick down cooldown timer (called by orchestrator) */
  tickCooldown(dtMs: number): void {
    if (this.cooldownRemaining > 0) this.cooldownRemaining -= dtMs;
  }

  /** Reset state for reconciliation */
  reset(): void {
    this.isSliding = false;
    this.isCrouching = false;
    this.slidePhase = 0;
  }

  /**
   * Update slide state machine.
   * Mutates vel in-place for slide boost/decay.
   */
  update(vel: Vec3, input: MovementInput, isGrounded: boolean, deltaTime: number, config: MovementConfig): void {
    const isCrouching = input.isPressed(InputButtons.CROUCH);
    const isJumping = input.isPressed(InputButtons.JUMP);
    const horizSpeed = vec3LengthXZ(vel);
    const dtMs = deltaTime * 1000;

    if (!this.isSliding) {
      // Check if we should enter slide
      const canSlide = isGrounded && isCrouching && horizSpeed >= config.slideMinSpeed && this.cooldownRemaining <= 0;

      if (canSlide) {
        this.isSliding = true;
        this.elapsedTime = 0;
        this.slideVelocity = vec3Clone(vel);
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
      // Currently sliding — accumulate elapsed time
      this.elapsedTime += dtMs;
      const slideElapsed = this.elapsedTime;
      const slideDuration = config.slideDuration;

      // === COMPUTE SLIDE PHASE (camera tilt intensity) ===
      const fadeMs = SLIDE_FADE_MS;
      const timeRemaining = slideDuration - slideElapsed;

      if (slideElapsed < fadeMs) {
        const t = slideElapsed / fadeMs;
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
        this.exit(vel, config);

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
  exit(_vel: Vec3, config?: MovementConfig): void {
    this.isSliding = false;
    if (config) {
      this.cooldownRemaining = config.slideCooldown;
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
