/**
 * Aim assist for touch look. It only shapes the thumb's own turn: while the
 * crosshair is over an enemy, turning slows (friction), and near one the turn
 * bends toward it by at most a share of its own size (pull). A still thumb
 * gets nothing, so the assist can never aim by itself. Mouse look never
 * reaches it; see docs/research/touchscreen_controls.md, "Aim assist".
 *
 * Angles follow the camera: yaw turns right, pitch is positive looking down.
 */

export interface AimTarget {
  /** The centre of the player's hitbox. */
  x: number;
  y: number;
  z: number;
  /** The hitbox height (shorter when crouching). */
  height: number;
}

export interface AimView {
  /** The eye. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** Turning while over a target, as a share of the thumb's turn. */
export const FRICTION = 0.6;
/** The most the turn bends toward a target, as a share of the turn: across, then up and down. */
const PULL_YAW = 0.25;
const PULL_PITCH = 0.15;
/** Beyond this distance nobody is helped toward. */
const REACH = 1500;
/** Half a hitbox's width. */
const HALF_WIDTH = 16;
/** How far from a target the assist reaches, in the target's own half widths and half heights. */
const REACH_ACROSS = 3;
const REACH_UP_DOWN = 2;

export interface AimOffset {
  /** From the crosshair to the target centre. */
  yaw: number;
  pitch: number;
  /** Whether the crosshair is on the target's hitbox. */
  over: boolean;
}

/**
 * The target nearest the crosshair that the assist reaches and `visible` can
 * see, as its offset from the crosshair; null when there is none.
 */
export function nearestTarget(
  view: AimView,
  targets: readonly AimTarget[],
  visible: (target: AimTarget) => boolean,
): AimOffset | null {
  let best: AimOffset | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    const dx = target.x - view.x;
    const dy = target.y - view.y;
    const dz = target.z - view.z;
    const across = Math.hypot(dx, dz);
    if (across < 1 || Math.hypot(across, dy) > REACH) continue;
    const yaw = wrap(Math.atan2(dx, dz) - view.yaw);
    const pitch = Math.atan2(-dy, across) - view.pitch;
    const halfWidth = Math.atan2(HALF_WIDTH, across);
    const halfHeight = Math.atan2(target.height / 2, across);
    if (Math.abs(yaw) > halfWidth * REACH_ACROSS || Math.abs(pitch) > halfHeight * REACH_UP_DOWN) continue;
    const score = Math.hypot(yaw / halfWidth, pitch / halfHeight);
    if (score >= bestScore || !visible(target)) continue;
    bestScore = score;
    best = { yaw, pitch, over: Math.abs(yaw) < halfWidth && Math.abs(pitch) < halfHeight };
  }
  return best;
}

/** The thumb's turn (`yaw`, `pitch`, radians) after friction and pull toward `target`. */
export function assistTurn(yaw: number, pitch: number, target: AimOffset | null): [number, number] {
  if (!target || (yaw === 0 && pitch === 0)) return [yaw, pitch];
  if (target.over) {
    yaw *= FRICTION;
    pitch *= FRICTION;
  }
  const turn = Math.hypot(yaw, pitch);
  yaw += Math.sign(target.yaw) * Math.min(Math.abs(target.yaw), turn * PULL_YAW);
  pitch += Math.sign(target.pitch) * Math.min(Math.abs(target.pitch), turn * PULL_PITCH);
  return [yaw, pitch];
}

function wrap(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
