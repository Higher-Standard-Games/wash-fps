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

  // Teleporters (trigger_teleport)
  /**
   * Exit velocity policy: 0 = Q3 (fixed teleportExitSpeed along the exit yaw),
   * 1 = redirect the FULL 3D momentum magnitude along the exit yaw (Warsow —
   * falling into a tele converts drop speed into exit speed; the default for
   * a movement game, and required for wdm2's drop-in teles where entry
   * velocity is nearly all vertical). Deliberately a CONFIG value, not a live
   * cvar: profiles read config only, so demo re-simulation stays exact
   * without snapshotting cvars (the F8 caveat).
   */
  teleportSpeedMode: number;
  /** Exit speed for teleportSpeedMode 0 (Q3: 400 ups). */
  teleportExitSpeed: number;
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
  /**
   * A jumppad (trigger_push) replaced velocity this step. Set every step the
   * player overlaps the pad (velocity replace is idempotent) — one-shot
   * effects/sounds must edge-detect on the consumer side (server subsystem /
   * client), NOT in the profile, so reconciliation replays stay stateless.
   */
  jumppadLaunch?: boolean;
  /**
   * A teleporter (trigger_teleport) moved the player this step. Like
   * jumppadLaunch, one-shot side effects (telefrag, events, camera yaw) are
   * the consumer's job. At most one trigger fires per step.
   */
  teleported?: boolean;
  /** Exit yaw (game radians) of the teleporter that fired — the client rotates its camera to this. */
  teleportYaw?: number;
  /** Entry position (player origin the step the teleporter fired) — for entry/exit VFX. */
  teleportFrom?: { x: number; y: number; z: number };
  /** TriggerVolume id that fired this step (jumppad or teleporter). */
  triggerId?: number;

  /**
   * How deep the player is in liquid at the END of this step: 0 dry, 1 wading,
   * 2 swimming, 3 submerged.
   *
   * Simulation state, not presentation. It is a pure function of the resulting
   * position and the map, so a reconciliation replay recomputes it rather than
   * carrying a stale value forward.
   */
  waterLevel?: 0 | 1 | 2 | 3;
  /**
   * Raw liquid contents at the foot probe — Q3's `watertype`. Kept alongside
   * `liquidKind` because a brush can be several liquids at once and the kind
   * discards the bits a later rule may need.
   */
  liquidContents?: number;
  /** Dominant liquid at the feet, or null when dry. */
  liquidKind?: "water" | "slime" | "lava" | null;

  /**
   * Whether the player is attached to a ladder at the END of this step.
   *
   * Simulation state, like {@link waterLevel}: a pure function of the resulting
   * position, the map and the detach cooldown, so a reconciliation replay
   * recomputes it rather than carrying a stale value forward.
   */
  onLadder?: boolean;

  /**
   * Signed vertical distance climbed this step, in units.
   *
   * Presentation input: the renderer advances the climb clip by this rather
   * than by wall-clock, which keeps hand-over-hand locked to actual movement
   * and makes descending the same clip played backwards. Zero when not on a
   * ladder.
   */
  ladderClimbDelta?: number;
}
