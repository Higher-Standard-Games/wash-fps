/**
 * FPSAudio — one entry point for predecoding the FPS client sound banks.
 *
 * Combat, movement, and pickup audio each own their own bank + `preload*` fn;
 * this bundles them so the map-load path has a single "warm all FPS audio" call
 * instead of repeating the same `Promise.all([...])` at each load site.
 */

import { waitForAsync } from "../../../engine/core/AsyncWait";
import { preloadFPSAnnouncer } from "./FPSAnnouncer";
import { preloadFPSBombAudio } from "./FPSBombAudio";
import { preloadFPSCombatAudio } from "./FPSCombatAudio";
import { preloadFPSLiquidAudio } from "./FPSLiquidAudio";
import { preloadFPSMovementAudio } from "./FPSMovementAudio";
import { preloadFPSPickupAudio } from "./FPSPickupAudio";
import { registerPlayerAudioCvars } from "./FPSPlayerAudio";
import { preloadFPSPowerupAudio } from "./FPSPowerupAudio";

/** Predecode every FPS audio bank (combat + movement + pickup + liquid) once the PK3 index is ready. */
export async function preloadFPSAudio(signal?: AbortSignal): Promise<void> {
  registerPlayerAudioCvars();
  const work = Promise.all([
    preloadFPSCombatAudio(),
    preloadFPSMovementAudio(),
    preloadFPSPickupAudio(),
    preloadFPSPowerupAudio(),
    preloadFPSBombAudio(),
    preloadFPSAnnouncer(),
    preloadFPSLiquidAudio(),
  ]);
  try {
    await waitForAsync(work, signal, 15000, "optional FPS audio");
  } catch (error) {
    signal?.throwIfAborted();
    console.warn("[FPSAudio] Audio preparation unavailable; continuing without pending sounds", error);
  }
}
