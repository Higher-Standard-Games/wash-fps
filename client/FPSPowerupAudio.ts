/**
 * FPSPowerupAudio — Warsow powerup feedback (currently Quad Damage only).
 *
 * Three distinct cues, each with a different audience, which is why this is its
 * own module rather than more branches inside FPSPickupAudio:
 *
 *  - `quad_spawn`  — 3D, at the item. Heard by EVERYONE when the quad returns.
 *    Every shipped map places exactly one, so this is the cue that starts the
 *    fight over it.
 *  - `quad_pickup` — 2D, local only. Your own "you have it now" confirmation.
 *  - `quad_fire`   — 2D, local only, layered over your normal weapon sound on
 *    every shot while quad is up. It is the running reminder that your damage
 *    is quadrupled, and it stops the instant the powerup lapses.
 *
 * Media: sounds/items/quad_*.ogg from the indexed CC0 washoi_sounds.pk3 bank.
 */

import { AudioManager } from "../../../engine/AudioManager";
import { Attenuation } from "../../../engine/audio/AudioV2Sfx";
import type { PowerupKind } from "../../../shared/items/Powerups";

const QUAD_SPAWN = "sounds/items/quad_spawn.ogg";
const QUAD_PICKUP = "sounds/items/quad_pickup.ogg";
const QUAD_FIRE = "sounds/items/quad_fire.ogg";

export const FPS_POWERUP_SOUND_PATHS = [QUAD_SPAWN, QUAD_PICKUP, QUAD_FIRE] as const;

/** Predecode the powerup bank once the map's PK3 index is available. */
export async function preloadFPSPowerupAudio(): Promise<void> {
  await AudioManager.getInstance().preloadSfx(FPS_POWERUP_SOUND_PATHS);
}

/** True if this `pickup_notify` label is a powerup grab (vs. armor/health/ammo). */
export function isPowerupLabel(label: string): boolean {
  return label.toLowerCase().includes("quad");
}

/** Local player picked the powerup up. */
export function playPowerupPickupSound(kind: PowerupKind = "quad"): void {
  if (kind !== "quad") return;
  AudioManager.getInstance().playSfx2D(QUAD_PICKUP, 0.9, 2);
}

/** A powerup respawned somewhere on the map — audible to everyone, positioned. */
export function playPowerupSpawnSound(position: { x: number; y: number; z: number }): void {
  AudioManager.getInstance().playSfx3D(QUAD_SPAWN, position, {
    volume: 1.0,
    // Carries across the arena, like an explosion
    attenuation: Attenuation.Distant,
    maxInstances: 1,
  });
}

/**
 * Layered over the local player's own weapon fire while quad is held.
 * `maxInstances: 2` keeps a fast weapon (plasma at 10/s) from stacking dozens of
 * overlapping copies into a wall of noise.
 */
export function playPowerupFireSound(): void {
  AudioManager.getInstance().playSfx2D(QUAD_FIRE, 0.55, 2);
}
