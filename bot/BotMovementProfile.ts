/**
 * BotMovementProfile — Static movement mechanics knowledge for bot AI
 *
 * Pre-computed movement physics from MovementVars.ts defaults.
 * Provides the bot with knowledge of HOW each movement mechanic works
 * (input recipes, speed effects, restrictions).
 *
 * The neural network learns WHEN to use them; this tells it WHAT they are.
 *
 * Usage:
 *   import { MOVEMENT, canInitiateSlide, getEscapeInputs } from './BotMovementProfile';
 *   if (canInitiateSlide(currentSpeed, slideCooldownExpired)) { ... }
 */

import { InputButtons } from "../../../engine/network/components/InputComponent";
import { DEFAULT_FPS_MOVEMENT_CONFIG } from "../simulation/MovementProfile";

// ── Movement Mechanic Interface ─────────────────────────────────────

export interface MovementMechanic {
  /** Mechanic identifier */
  id: string;
  /** Can the bot fire weapons during this movement? */
  canFire: boolean;
  /** Resulting speed (ups) or multiplier */
  speed: number;
  /** Minimum horizontal speed required to initiate (0 = none) */
  minSpeedRequired: number;
  /** Maximum duration in ms (0 = unlimited) */
  duration: number;
  /** Cooldown before reuse in ms (0 = none) */
  cooldown: number;
  /** InputButtons bitmask to activate this mechanic */
  inputMask: number;
  /** Brief description for debugging */
  description: string;
}

// ── Physics Constants (from MovementVars.ts defaults) ───────────────
// Derived from the same exported baseline consumed by authoritative FPS simulation.

const FPS = DEFAULT_FPS_MOVEMENT_CONFIG;

export const PHYSICS = {
  // Movement speeds
  BASE_SPEED: FPS.maxSpeed,
  SPRINT_SPEED: FPS.runSpeed,
  CROUCH_MULT: FPS.crouchMultiplier,
  SPRINT_MULT: 1.5, // cl_sprintmult
  TOP_SPEED: FPS.topSpeed,

  // Jump
  JUMP_VELOCITY: FPS.jumpVelocity,
  GRAVITY: FPS.gravity,
  AUTO_HOP: true, // sv_autohop = 1

  // Air control
  AIR_CONTROL: FPS.airControl,
  MAX_AIR_SPEED: FPS.maxAirSpeed,
  AIR_ACCELERATE: FPS.airAcceleration,

  // Crouch-slide
  SLIDE_MIN_SPEED: FPS.slideMinSpeed,
  SLIDE_SPEED_MULT: FPS.slideSpeedMultiplier,
  SLIDE_DURATION: FPS.slideDuration,
  SLIDE_COOLDOWN: FPS.slideCooldown,
  SLIDE_FRICTION: FPS.slideFriction,
  SLIDE_DECAY: FPS.slideDecay,
  SLIDE_JUMP_BOOST: FPS.slideJumpBoost,

  // Wall-jump
  WALLJUMP_HEIGHT: FPS.wallJumpHeight,
  WALLJUMP_BOUNCE: FPS.wallJumpBounce,
  WALLJUMP_REACH: FPS.wallJumpReach,
  WALLJUMP_COOLDOWN: FPS.wallJumpCooldown * 1000,
  WALLJUMP_MIN_HEIGHT: FPS.wallJumpMinHeight,
  WALLJUMP_CHARGE: FPS.wallJumpChargeTime * 1000,
  WALLJUMP_BOOST: FPS.wallJumpBoost,

  // Ledge-grab
  LEDGE_REACH: FPS.ledgeReach,
  LEDGE_HEIGHT: FPS.ledgeHeight,
  LEDGE_TIMEOUT: FPS.ledgeTimeout * 1000,
  LEDGE_PULL_TIME: FPS.ledgePullTime * 1000,

  // Collision
  STEP_HEIGHT: FPS.stepHeight,
  PLAYER_HEIGHT: 64, // sv_playerheight
} as const;

// ── Movement Mechanics Table ────────────────────────────────────────

export const MOVEMENT: Record<string, MovementMechanic> = {
  walk: {
    id: "walk",
    canFire: true,
    speed: PHYSICS.BASE_SPEED,
    minSpeedRequired: 0,
    duration: 0,
    cooldown: 0,
    inputMask: InputButtons.FORWARD,
    description: "Standard ground movement (280 ups)",
  },

  sprint: {
    id: "sprint",
    canFire: false, // Weapon tilts up — cannot shoot
    speed: PHYSICS.SPRINT_SPEED,
    minSpeedRequired: 0,
    duration: 0,
    cooldown: 0,
    inputMask: InputButtons.FORWARD | InputButtons.SPRINT,
    description: "Sprint at 400 ups — cannot fire",
  },

  jump: {
    id: "jump",
    canFire: true,
    speed: PHYSICS.JUMP_VELOCITY, // Upward velocity
    minSpeedRequired: 0,
    duration: 0,
    cooldown: 0,
    inputMask: InputButtons.JUMP,
    description: "Jump (320 upvel), hold for auto-hop",
  },

  strafeJump: {
    id: "strafeJump",
    canFire: true, // But hard to aim
    speed: PHYSICS.TOP_SPEED, // Potential max
    minSpeedRequired: 0,
    duration: 0,
    cooldown: 0,
    inputMask: InputButtons.JUMP | InputButtons.LEFT, // + yaw turn
    description: "Strafe-jump momentum building (up to 1000 ups)",
  },

  crouchSlide: {
    id: "crouchSlide",
    canFire: true, // Lower profile while sliding
    speed: PHYSICS.SLIDE_SPEED_MULT, // 1.2× current speed
    minSpeedRequired: PHYSICS.SLIDE_MIN_SPEED, // Need 375+ ups
    duration: PHYSICS.SLIDE_DURATION,
    cooldown: PHYSICS.SLIDE_COOLDOWN,
    inputMask: InputButtons.CROUCH,
    description: "Crouch-slide: need 375+ ups, 1.2× boost, 800ms max",
  },

  wallJump: {
    id: "wallJump",
    canFire: true, // Briefly
    speed: PHYSICS.WALLJUMP_HEIGHT, // 280 upward velocity
    minSpeedRequired: 0,
    duration: PHYSICS.WALLJUMP_CHARGE, // 200ms charge
    cooldown: PHYSICS.WALLJUMP_COOLDOWN,
    inputMask: InputButtons.JUMP, // While airborne + near wall
    description: "Wall-jump: 280 upvel, 0.2s charge, 1.2× boost",
  },

  ledgeGrab: {
    id: "ledgeGrab",
    canFire: false, // Hanging state
    speed: 0,
    minSpeedRequired: 0,
    duration: PHYSICS.LEDGE_TIMEOUT,
    cooldown: 0,
    inputMask: InputButtons.JUMP | InputButtons.FORWARD, // To pull up
    description: "Ledge-grab: auto-trigger, JUMP/FWD to pull up",
  },
};

// ── Query Functions ─────────────────────────────────────────────────

/**
 * Check if a crouch-slide can be initiated given current speed and cooldown.
 */
export function canInitiateSlide(currentSpeed: number, cooldownExpired: boolean): boolean {
  return currentSpeed >= PHYSICS.SLIDE_MIN_SPEED && cooldownExpired;
}

/**
 * Check if a wall-jump can be performed.
 */
export function canWallJump(isGrounded: boolean, heightAboveGround: number, cooldownExpired: boolean): boolean {
  return !isGrounded && heightAboveGround >= PHYSICS.WALLJUMP_MIN_HEIGHT && cooldownExpired;
}

/**
 * Get the estimated jump height (apex) from a standing jump.
 * h = v² / (2g) where v = JUMP_VELOCITY, g = GRAVITY
 */
export function getJumpApex(): number {
  return (PHYSICS.JUMP_VELOCITY * PHYSICS.JUMP_VELOCITY) / (2 * PHYSICS.GRAVITY);
}

/**
 * Get jump + wall-jump combined height potential.
 */
export function getMaxReachHeight(): number {
  const jumpApex = getJumpApex();
  const wallJumpApex = (PHYSICS.WALLJUMP_HEIGHT * PHYSICS.WALLJUMP_HEIGHT) / (2 * PHYSICS.GRAVITY);
  return jumpApex + wallJumpApex;
}

/**
 * Get the input buttons for the "escape sequence":
 * Turn away → switch to blade → sprint → crouchslide → jump-cancel
 *
 * Returns array of input steps (each step = a few ticks).
 */
export function getEscapeSequence(): Array<{
  phase: string;
  buttons: number;
  durationTicks: number;
  notes: string;
}> {
  return [
    {
      phase: "sprint",
      buttons: InputButtons.FORWARD | InputButtons.SPRINT,
      durationTicks: 30, // ~0.5s to build speed to 375+
      notes: "Build speed (switch to blade for speedBonus)",
    },
    {
      phase: "slide",
      buttons: InputButtons.CROUCH,
      durationTicks: 30, // 500ms of slide
      notes: "Crouch-slide: 1.2× speed, low profile",
    },
    {
      phase: "jumpCancel",
      buttons: InputButtons.JUMP,
      durationTicks: 1,
      notes: "Jump-cancel slide for 1.3× velocity boost",
    },
    {
      phase: "bunnyHop",
      buttons: InputButtons.FORWARD | InputButtons.JUMP,
      durationTicks: 60, // 1s of bunny hopping
      notes: "Maintain speed with auto-hop",
    },
  ];
}

/**
 * Get the input buttons for gaining height advantage:
 * Sprint → jump → wall-jump → ledge grab
 */
export function getHeightSequence(): Array<{
  phase: string;
  buttons: number;
  durationTicks: number;
  notes: string;
}> {
  return [
    {
      phase: "approach",
      buttons: InputButtons.FORWARD | InputButtons.SPRINT,
      durationTicks: 15,
      notes: "Sprint toward wall",
    },
    {
      phase: "jump",
      buttons: InputButtons.FORWARD | InputButtons.JUMP,
      durationTicks: 5,
      notes: "Jump off ground",
    },
    {
      phase: "wallJump",
      buttons: InputButtons.JUMP,
      durationTicks: 12, // ~0.2s charge time
      notes: "Wall-jump: press JUMP near wall while airborne",
    },
    {
      phase: "pullUp",
      buttons: InputButtons.FORWARD | InputButtons.JUMP,
      durationTicks: 21, // ~0.35s pull-up
      notes: "Ledge-grab pull-up (if ledge detected)",
    },
  ];
}
