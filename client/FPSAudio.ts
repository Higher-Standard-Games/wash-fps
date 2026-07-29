/**
 * FPSAudio — one entry point for predecoding the FPS client sound banks.
 *
 * Combat, movement, and pickup audio each own their own bank + `preload*` fn;
 * this bundles them so the map-load path has a single "warm all FPS audio" call
 * instead of repeating the same `Promise.all([...])` at each load site.
 */

import { preloadFPSBombAudio } from "./FPSBombAudio";
import { preloadFPSCombatAudio } from "./FPSCombatAudio";
import { preloadFPSMovementAudio } from "./FPSMovementAudio";
import { preloadFPSPickupAudio } from "./FPSPickupAudio";
import { preloadFPSPowerupAudio } from "./FPSPowerupAudio";

/** Predecode every FPS audio bank (combat + movement + pickup) once the PK3 index is ready. */
export async function preloadFPSAudio(): Promise<void> {
  await Promise.all([
    preloadFPSCombatAudio(),
    preloadFPSMovementAudio(),
    preloadFPSPickupAudio(),
    preloadFPSPowerupAudio(),
    preloadFPSBombAudio(),
  ]);
}
