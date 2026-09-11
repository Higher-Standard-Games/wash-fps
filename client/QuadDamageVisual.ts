import { Color3 } from "@babylonjs/core/Maths/math.color";

const QUAD_PULSE_HZ = 1.5;
export const QUAD_DAMAGE_COLOR = new Color3(1, 0.28, 0.025);
export const QUAD_EMISSIVE_MIN = 0.35;
export const QUAD_EMISSIVE_RANGE = 0.6;
/** Player outline sizes use the same 0..100 scale as cl_player_outline_size. */
export const QUAD_PLAYER_OUTLINE_MIN = 28;
export const QUAD_PLAYER_OUTLINE_RANGE = 24;
/** Desired world-space outline width for an attached third-person weapon. */
export const QUAD_WORLD_WEAPON_OUTLINE_MIN = 0.7;
export const QUAD_WORLD_WEAPON_OUTLINE_RANGE = 0.55;
/** Desired outline before first-person weapon root-scale compensation. */
export const QUAD_VIEW_WEAPON_OUTLINE_MIN = 0.24;
export const QUAD_VIEW_WEAPON_OUTLINE_RANGE = 0.24;

/** One allocation-free breathing pulse shared by body and both weapon views. */
export function getQuadDamagePulse(elapsedSeconds: number): number {
  return 0.5 + 0.5 * Math.sin(elapsedSeconds * QUAD_PULSE_HZ * Math.PI * 2);
}
