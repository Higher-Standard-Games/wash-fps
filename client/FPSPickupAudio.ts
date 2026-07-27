/**
 * FPSPickupAudio — Warsow item/armor/health pickup feedback for the LOCAL player.
 *
 * Driven by the server `pickup_notify` event (per-player, shown local-only — the
 * same gate as the HUD pickup toast). That event carries only the display
 * `label` (no typed kind — see PickupNotifyEvent in SnapshotEvent), so the sound
 * is chosen by classifying the label. The label distinguishes every armor tier
 * (shard/green/yellow/red), ammo, weapons, and mega/ultra vs. regular health;
 * the small/large health tiers collapse to one "bubble" sound, which is fine for
 * pickup feedback. Played 2D (one-shot) so you always hear your own grab,
 * independent of world distance — matching how the combat hit-confirm plays.
 *
 * Media: sounds/items/*.ogg from the Warsow data pk3s (mounted at map load).
 */

import { AudioManager } from "../../../engine/AudioManager";

/** Warsow item pickup bank (sounds/items). */
const PICKUP_SOUNDS = {
  weapon: "sounds/items/weapon_pickup.ogg",
  ammo: "sounds/items/ammo_pickup.ogg",
  armorShard: "sounds/items/armor_shard.ogg",
  armorGreen: "sounds/items/armor_green.ogg",
  armorYellow: "sounds/items/armor_yellow.ogg",
  armorRed: "sounds/items/armor_red.ogg",
  health: "sounds/items/health_25.ogg",
  megaHealth: "sounds/items/megahealth.ogg",
} as const;

/**
 * Resolve the pickup sound for a `pickup_notify` label. Keyword-based so it is
 * tolerant of label formatting ("Green Armor", "Armor Shard", "25 Cells Ammo",
 * "Mega Health", weapon display names). Weapon names carry no keyword and fall
 * through to the generic weapon pickup.
 */
export function getPickupSound(label: string): string {
  const l = label.toLowerCase();
  if (l.includes("armor")) {
    if (l.includes("shard")) return PICKUP_SOUNDS.armorShard;
    if (l.includes("yellow")) return PICKUP_SOUNDS.armorYellow;
    if (l.includes("red")) return PICKUP_SOUNDS.armorRed;
    return PICKUP_SOUNDS.armorGreen; // "Green Armor" + any unlabeled armor
  }
  if (l.includes("health")) {
    return l.includes("mega") || l.includes("ultra") ? PICKUP_SOUNDS.megaHealth : PICKUP_SOUNDS.health;
  }
  if (l.includes("ammo")) return PICKUP_SOUNDS.ammo;
  return PICKUP_SOUNDS.weapon;
}

/** All pickup sound paths (deduped) — used for the map-load predecode. */
export const FPS_PICKUP_SOUND_PATHS = [...new Set(Object.values(PICKUP_SOUNDS))] as const;

/** Predecode the pickup bank once the map's PK3 index is available. */
export async function preloadFPSPickupAudio(): Promise<void> {
  await AudioManager.getInstance().preloadSfx(FPS_PICKUP_SOUND_PATHS);
}

/** Play the local player's pickup feedback (2D, distance-independent). */
export function playPickupSound(label: string): void {
  if (!label) return;
  AudioManager.getInstance().playSfx2D(getPickupSound(label), 0.75, 4);
}
