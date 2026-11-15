/**
 * A body bigger than a player's (a campaign boss) is a player's scaled up
 * about the feet, the way the client draws it. These turn a height on a
 * normal body into the same point on a bigger one, and back; heights are
 * measured from the player's origin, which stands PLAYER_ORIGIN_HEIGHT above
 * the feet. At scale 1 both are the identity.
 *
 * Shared by the game server (shot origin, hit spheres, hit location) and the
 * bots (where a bot's own shots leave from), so the two agree.
 */

import { PLAYER_ORIGIN_HEIGHT } from "../../../engine/physics/PlayerPhysicsConstants";

/** Height above the origin of the point `normalHeight` above it on a normal body, on a body `scale` times as big. */
export function scaledBodyHeight(normalHeight: number, scale: number): number {
  return scale === 1 ? normalHeight : normalHeight * scale + PLAYER_ORIGIN_HEIGHT * (scale - 1);
}

/** The reverse: where a point `height` above the origin of a body `scale` times as big would be on a normal one. */
export function normalBodyHeight(height: number, scale: number): number {
  return scale === 1 ? height : (height - PLAYER_ORIGIN_HEIGHT * (scale - 1)) / scale;
}
