/**
 * Players bigger than normal (a campaign boss): how much bigger each one is,
 * the hit sphere that follows from it, and how much faster it moves.
 *
 * A bigger body is a normal one scaled up about its feet, the way the client
 * draws it, so the hit shapes scale about the feet too: a sphere around a
 * player's position becomes one `scale` times as wide, around the point that
 * many times as far above the feet. At scale 1 both are exactly the normal ones.
 */

import type { EntityId } from "@engine/server/ecs/types";
import { scaledBodyHeight } from "../../shared/BodyScale";

/** How many times a player's normal size this entity is; 1 for everyone but a boss. */
export type HitScaleLookup = (entityId: EntityId) => number;

/** Everyone their normal size. */
export const NORMAL_SIZE: HitScaleLookup = () => 1;

/**
 * How much faster a body `scale` times as big moves: by the square root of its
 * size, as walking speed grows with leg length, so a giant strides ahead
 * without running at its full size's multiple.
 */
export function bodySpeedFactor(scale: number): number {
  return scale > 1 ? Math.sqrt(scale) : 1;
}

export function scaledHitSphere(
  position: { x: number; y: number; z: number },
  radius: number,
  scale: number,
): { center: { x: number; y: number; z: number }; radius: number } {
  if (scale === 1) return { center: position, radius };
  return {
    center: { x: position.x, y: position.y + scaledBodyHeight(0, scale), z: position.z },
    radius: radius * scale,
  };
}
