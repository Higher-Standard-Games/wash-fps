/**
 * Getting out of slime and lava.
 *
 * Both hurt every second a body is in them, so a bot in either jumps for the
 * nearest dry ground: the nearest route node out of the liquid, one in sight
 * first, climbs counted double since a bank above the surface takes longer to
 * reach than one level with it.
 */

import { type CollisionWorld, Contents } from "../../../engine/network/systems/collision/CollisionWorld";
import type { Vec3 } from "./BotGameState";

/** The liquids that hurt. */
const HARMFUL = Contents.SLIME | Contents.LAVA;

/** Heights above a bot's origin checked for liquid: the feet, the waist and the chest. */
const BODY_POINTS = [-20, 0, 20];

/** How far a way out is looked for. */
const MAX_ESCAPE_DISTANCE = 1500;

/** How far below a bot a way out may be: a pool is left by its banks, not through its floor. */
const MAX_ESCAPE_DROP = 64;

/** Whether any part of the body at `origin` is in slime or lava. */
export function inHarmfulLiquid(world: Pick<CollisionWorld, "pointContents">, origin: Vec3): boolean {
  return BODY_POINTS.some(
    (dy) => (world.pointContents({ x: origin.x, y: origin.y + dy, z: origin.z }) & HARMFUL) !== 0,
  );
}

/** The nearest dry node of `nodes` in sight of `origin`, else the nearest at all; null when there is none. */
export function liquidEscapeTarget(
  world: Pick<CollisionWorld, "pointContents" | "trace">,
  origin: Vec3,
  nodes: ReadonlyArray<{ position: Vec3 }>,
): Vec3 | null {
  const candidates = nodes
    .filter(
      ({ position }) =>
        Math.hypot(position.x - origin.x, position.z - origin.z) <= MAX_ESCAPE_DISTANCE &&
        position.y >= origin.y - MAX_ESCAPE_DROP &&
        !inHarmfulLiquid(world, { ...position, y: position.y + 20 }),
    )
    .map(({ position }) => ({
      position,
      cost: Math.hypot(position.x - origin.x, position.z - origin.z) + 2 * Math.max(0, position.y - origin.y),
    }))
    .sort((a, b) => a.cost - b.cost);
  const eye = { x: origin.x, y: origin.y + 20, z: origin.z };
  for (const { position } of candidates) {
    const sight = world.trace(eye, { x: position.x, y: position.y + 20, z: position.z });
    if (!sight.hit || sight.fraction >= 1) return position;
  }
  return candidates[0]?.position ?? null;
}
