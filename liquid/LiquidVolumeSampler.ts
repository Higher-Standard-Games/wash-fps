/**
 * Three-point water sampling.
 *
 * Q3 decides how deep you are with three probes up the body — foot, midpoint,
 * eye — and stops at the first one that is dry. Every liquid behaviour in the
 * game reads the number this produces, so it lives in one pure function that
 * the server and the predicted client both call with the same arguments.
 *
 * Deliberately takes bounds and view height as parameters rather than reading
 * constants. Standing and crouched players have different hulls and different
 * eye heights, and the caller is the only thing that knows which applies after
 * crouch has been resolved for the step.
 */

import type { Vec3 } from "../../../engine/network/components/TransformComponent";
import { Contents, MASK_LIQUID } from "../../../shared/collision/CollisionWorld";
import { DRY_SAMPLE, type LiquidKind, type LiquidSample, type WaterLevel } from "./LiquidTypes";

/** The only thing the sampler needs from the world. */
export interface PointContentsSource {
  pointContents(point: Vec3): number;
}

export interface LiquidSampleBounds {
  /** Hull floor relative to the origin: -24 standing, -4 crouched. */
  minsY: number;
  /** Eye height relative to the origin: 34 standing, 12 crouched. */
  viewHeight: number;
}

/**
 * The liquid at a point, reduced to a kind.
 *
 * Where several liquid bits are set at once — four shipped shaders declare
 * water and slime together — the most hostile wins, because that is the one
 * with consequences.
 */
export function liquidKindAt(contents: number): LiquidKind | null {
  if (contents & Contents.LAVA) return "lava";
  if (contents & Contents.SLIME) return "slime";
  if (contents & Contents.WATER) return "water";
  return null;
}

/**
 * Sample how deep a player is standing in liquid.
 *
 * The probe heights follow Q3 exactly:
 *
 *   feet  = origin.y + mins.y          (the hull's own floor)
 *   foot  = feet + 1                   (lifted out of the floor it rests on)
 *   eye   = origin.y + viewHeight
 *   mid   = midpoint of feet..eye
 *
 * Note that the midpoint is measured from the FEET, not from the lifted foot
 * probe. The `+1` belongs to the foot probe alone; deriving the midpoint from
 * it instead puts the waist half a unit high, which is invisible in play and
 * wrong in a path that feeds prediction and replay.
 */
export function sampleLiquid(
  collision: PointContentsSource | null,
  origin: Vec3,
  bounds: LiquidSampleBounds,
): LiquidSample {
  if (!collision) return { ...DRY_SAMPLE };

  const feetY = origin.y + bounds.minsY;
  const eyeY = origin.y + bounds.viewHeight;

  const footContents = collision.pointContents({ x: origin.x, y: feetY + 1, z: origin.z }) & MASK_LIQUID;
  if (footContents === 0) return { ...DRY_SAMPLE };

  const midY = feetY + (eyeY - feetY) * 0.5;
  const waistContents = collision.pointContents({ x: origin.x, y: midY, z: origin.z }) & MASK_LIQUID;

  let level: WaterLevel = 1;
  let eyeContents = 0;

  if (waistContents !== 0) {
    level = 2;
    eyeContents = collision.pointContents({ x: origin.x, y: eyeY, z: origin.z }) & MASK_LIQUID;
    if (eyeContents !== 0) level = 3;
  }

  return {
    level,
    kind: liquidKindAt(footContents),
    rawContents: footContents,
    footContents,
    waistContents,
    eyeContents,
  };
}
