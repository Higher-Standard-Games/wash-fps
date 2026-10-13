/**
 * The sound of entering, leaving and being under a liquid.
 *
 * Warsow authored the whole set and shipped it in the pk3s; none of it was
 * wired. `water_in`, `water_out` and `underwater` have lava counterparts, and
 * `hit_water` is the impact splash a projectile makes.
 *
 * Mirrors the other FPS audio banks: a path list, a `preload*`, and a small
 * classifier. Local sounds play 2D so they are distance-independent — your own
 * splash happens at your ears, not at a point in the world.
 */

import { AudioManager } from "../../../engine/AudioManager";
import type { LiquidKind } from "../liquid/LiquidTypes";

const WATER_IN = "sounds/world/water_in.ogg";
const WATER_OUT = "sounds/world/water_out.ogg";
const UNDERWATER = "sounds/world/underwater.ogg";
const LAVA_IN = "sounds/world/lava_in.ogg";
const LAVA_OUT = "sounds/world/lava_out.ogg";
const UNDERLAVA = "sounds/world/underlava.ogg";
/** Projectile and body impacts on a surface, rather than a body crossing it. */
export const HIT_WATER = "sounds/misc/hit_water.wav";
/**
 * Running out of air.
 *
 * Warsow shipped a per-character drown sound; Bobot's is the one this game's
 * player uses, matching the pain and jump voices already wired.
 */
const DROWN = "sounds/players/bobot/drown.ogg";

export const FPS_LIQUID_SOUND_PATHS = [
  WATER_IN,
  WATER_OUT,
  UNDERWATER,
  LAVA_IN,
  LAVA_OUT,
  UNDERLAVA,
  HIT_WATER,
  DROWN,
] as const;

export async function preloadFPSLiquidAudio(): Promise<void> {
  await AudioManager.getInstance().preloadSfx(FPS_LIQUID_SOUND_PATHS);
}

/**
 * Slime borrows water's sounds deliberately.
 *
 * Warsow authored no slime set, and lava's roar is wrong for it — slime is a
 * liquid you fall into, not a furnace. Water's splash with the slime visuals
 * over it reads correctly; inventing a third sound would be worse than reusing
 * the one that fits.
 */
export function enterSound(kind: LiquidKind): string {
  return kind === "lava" ? LAVA_IN : WATER_IN;
}

export function exitSound(kind: LiquidKind): string {
  return kind === "lava" ? LAVA_OUT : WATER_OUT;
}

export function submergedSound(kind: LiquidKind): string {
  return kind === "lava" ? UNDERLAVA : UNDERWATER;
}

/**
 * How loud a crossing is, from how fast the body went through the surface.
 *
 * A player who steps off a ledge into a pool should be heard; one who drifts
 * across the waterline while treading should barely register. Without this
 * every crossing is the same splash and the surface becomes noisy the moment
 * anyone is near it.
 */
export function splashVolume(verticalSpeed: number): number {
  const speed = Math.abs(verticalSpeed);
  if (speed < 40) return 0;
  return Math.min(1, 0.25 + (speed / 700) * 0.75);
}

/**
 * The gasp when the lungs empty, and the gurgle for each hit after.
 *
 * 2D and local only: this is your own body, and there is no version of it
 * another player should hear from across the map. One instance, so a rapid
 * sequence overlaps itself into noise rather than stacking into a wall.
 */
export function playDrownGasp(): void {
  AudioManager.getInstance().playSfx2D(DROWN, 1.0, 1, "players");
}

export function playDrownTick(): void {
  // Quieter than the first: the first is news, the rest are a countdown the
  // player already knows they are in.
  AudioManager.getInstance().playSfx2D(DROWN, 0.55, 1, "players");
}

/** Play a body crossing the surface. Local plays 2D, remote plays in the world. */
export function playLiquidCrossing(
  path: string,
  volume: number,
  position: { x: number; y: number; z: number },
  local: boolean,
): void {
  if (volume <= 0) return;
  const audio = AudioManager.getInstance();
  if (local) audio.playSfx2D(path, volume, 3);
  else audio.playSfx3D(path, position, { volume });
}
