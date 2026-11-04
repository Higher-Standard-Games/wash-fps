/**
 * A move stick's reading, as movement takes it.
 *
 * The stick gives any angle. Movement takes a world direction, which is
 * normalized, so a half-pushed stick still runs at full speed, and the four
 * move keys, which decide running (pure forward only) and animation. The keys
 * split the circle into eight equal sectors, as pressing one or two keys does:
 * each key covers its own direction 67.5° either side, and two keys overlap on
 * the diagonals.
 */

export interface MoveAxis {
  /** Forward is positive, back negative. */
  forward: number;
  /** Right is positive, left negative. */
  right: number;
}

export interface MoveKeys {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
}

/** Below this fraction of its travel the stick reads as centred. */
export const STICK_DEAD_ZONE = 0.12;

// sin 22.5°: the edge between a straight sector and a diagonal one
const KEY_THRESHOLD = Math.sin(Math.PI / 8);

/** The stick's direction with length 1, or null while it is inside the dead zone. */
export function stickDirection(axis: MoveAxis | null | undefined): MoveAxis | null {
  if (!axis) return null;
  const length = Math.hypot(axis.forward, axis.right);
  if (length < STICK_DEAD_ZONE) return null;
  return { forward: axis.forward / length, right: axis.right / length };
}

/** The move keys the stick holds; all released inside the dead zone. */
export function stickKeys(axis: MoveAxis | null | undefined): MoveKeys {
  const dir = stickDirection(axis);
  if (!dir) return { forward: false, backward: false, left: false, right: false };
  return {
    forward: dir.forward > KEY_THRESHOLD,
    backward: dir.forward < -KEY_THRESHOLD,
    left: dir.right < -KEY_THRESHOLD,
    right: dir.right > KEY_THRESHOLD,
  };
}
