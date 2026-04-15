/**
 * Movement Configuration & Result Types
 *
 * Shared configuration interface for the movement profile
 * and extended result types for advanced movement states.
 */

import type { MovementResult } from "../../../engine/network/systems/movement/MovementProfile";

// ================== Configuration ==================

export interface MovementConfig {
  // Core movement
  maxSpeed: number;
  runSpeed: number;
  groundAcceleration: number;
  airAcceleration: number;
  maxAirSpeed: number;
  friction: number;
  stopSpeed: number;
  gravity: number;
  fallingGravityMultiplier: number;
  jumpVelocity: number;
  crouchMultiplier: number;
  stepHeight: number;

  // Top speed limiter
  topSpeed: number;

  // Air control (Warsow style)
  airControl: number;
  airControlPower: number;

  // Wall jump
  wallJumpEnabled: boolean;
  wallJumpHeight: number;
  wallJumpBounce: number;
  wallJumpReach: number;
  wallJumpCooldown: number;
  wallJumpMinHeight: number;
  wallJumpChargeTime: number;
  wallJumpBoost: number;

  // Ledge grab
  ledgeGrabEnabled: boolean;
  ledgeReach: number;
  ledgeHeight: number;
  ledgeMinFall: number;
  ledgeTimeout: number;
  ledgePullTime: number;

  // Crouchslide
  slideEnabled: boolean;
  slideDuration: number;
  slideSpeedMultiplier: number;
  slideDecay: number;
  slideJumpBoost: number;
  slideMinSpeed: number;
  slideFriction: number;
  slideCooldown: number;
}

// Backward-compat alias
export type FPSMovementConfig = MovementConfig;

// ================== Extended Result with Advanced State ==================

export interface AdvancedMovementResult extends MovementResult {
  isSliding: boolean;
  isCrouching: boolean;
  wallJumpState: "none" | "available" | "charging";
  ledgeGrabState: "none" | "grabbing" | "pulling";
  actualHorizSpeed: number;
  crouchViewOffset: number;
  /** Slide camera tilt intensity (0-1, smoothstep fade in/out) */
  slidePhase: number;
  /** Ledge grab/pull camera phase (0-1 progress through grab+pull) */
  ledgeGrabPhase: number;
}
