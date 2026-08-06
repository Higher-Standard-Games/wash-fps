/**
 * What being underwater looks like — the pure half.
 *
 * Colours, densities and the transition curve, with no Babylon in sight, so
 * the look can be tested and tuned without a renderer. `UnderwaterView` owns
 * the scene it applies these to.
 *
 * Slime and lava are the same treatment with different numbers, deliberately.
 * That is the whole reason for replacing the legacy shaders rather than
 * translating them: one material family, parameterized per liquid, instead of
 * a fork per map's art.
 */

import type { LiquidKind } from "../LiquidTypes";

export interface LiquidLook {
  /** Fog colour, linear 0-1 RGB. */
  color: [number, number, number];
  /**
   * Exponential fog density at full submersion.
   *
   * Water is murky but playable; you must still be able to see a body coming.
   * Slime is thicker because it is opaque in every game that has it, and lava
   * is near-blinding because being inside it is not a state you survive long
   * enough to need to aim in.
   */
  density: number;
  /** How far the screen tints toward `color`, 0-1. */
  tintStrength: number;
}

const LOOKS: Record<LiquidKind, LiquidLook> = {
  // Deep blue-green. Dark enough to read as underwater, open enough to fight in.
  water: { color: [0.05, 0.22, 0.32], density: 0.0022, tintStrength: 0.55 },
  // Bright toxic green, from a shader rule rather than the map's own art.
  slime: { color: [0.13, 0.42, 0.06], density: 0.0055, tintStrength: 0.75 },
  // Hot and close to blind. You are not going to be in here long.
  lava: { color: [0.75, 0.18, 0.02], density: 0.012, tintStrength: 0.9 },
};

export function lookFor(kind: LiquidKind): LiquidLook {
  return LOOKS[kind];
}

/**
 * Move the current submersion mix toward its target.
 *
 * Mechanics switch instantly — you are swimming the moment your waist goes
 * under. Presentation does not, because a camera skimming the surface would
 * otherwise strobe the whole screen. Roughly 150 ms each way: fast enough to
 * feel like a transition, slow enough to swallow a bobbing waterline.
 */
export const SUBMERSION_RATE = 6.7;

export function approachSubmersion(current: number, target: number, deltaTime: number): number {
  const t = Math.min(1, SUBMERSION_RATE * deltaTime);
  const next = current + (target - current) * t;
  // Snap the last sliver so a fog density that should be off actually reaches
  // zero rather than asymptotically haunting the scene.
  if (Math.abs(target - next) < 0.002) return target;
  return next;
}

/**
 * Quake's underwater view warp: the horizontal and vertical field of view
 * pulse in opposite directions, which reads as the whole world flexing.
 *
 * One degree at 0.4 Hz in the original. Kept as a homage and scaled by a
 * comfort setting, because a permanent low-frequency warp is exactly the kind
 * of motion that makes some people ill — at zero the tint and the fog still
 * say you are underwater, so nothing is communicated by motion alone.
 */
export const WARP_AMPLITUDE_DEGREES = 1;
export const WARP_FREQUENCY_HZ = 0.4;

export function fovWarpDegrees(timeSeconds: number, submersion: number, comfortScale: number): number {
  if (submersion <= 0 || comfortScale <= 0) return 0;
  const phase = timeSeconds * WARP_FREQUENCY_HZ * Math.PI * 2;
  return Math.sin(phase) * WARP_AMPLITUDE_DEGREES * submersion * comfortScale;
}

/** Fog density for a partial transition — nothing at all when dry. */
export function fogDensityFor(look: LiquidLook, submersion: number): number {
  return look.density * submersion;
}
