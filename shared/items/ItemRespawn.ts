/**
 * When a taken pickup comes back. Shared so the server that runs the timers and
 * the bots that time items read the same numbers; a bot that times the Red
 * Armor from its own guess at the respawn would be early or late every time.
 */

import type { PickupType } from "../bsp/PickupTable";
import { POWERUP_RESPAWN_SECONDS, type PowerupKind } from "./Powerups";

/** Respawn times by item class, seconds. Weapons take the gametype's value instead. */
export const ITEM_RESPAWN_SECONDS = {
  weapon: 15,
  ammo: 15,
  armor: 25,
  health: 20,
  megaHealth: 60,
} as const;

/** Armor and Mega/Ultra health first appear this long after the match starts. */
export const MAJOR_ITEM_FIRST_SPAWN_SECONDS = 15;

/** Seconds a taken pickup of this type and kind stays away. */
export function itemRespawnSeconds(
  type: PickupType,
  kind: string,
  weaponSeconds: number = ITEM_RESPAWN_SECONDS.weapon,
): number {
  switch (type) {
    case "weapon":
      return weaponSeconds;
    case "ammo":
      return ITEM_RESPAWN_SECONDS.ammo;
    case "armor":
      return ITEM_RESPAWN_SECONDS.armor;
    case "powerup":
      return POWERUP_RESPAWN_SECONDS[kind as PowerupKind] ?? 120;
    default:
      return kind === "mega" || kind === "ultra" ? ITEM_RESPAWN_SECONDS.megaHealth : ITEM_RESPAWN_SECONDS.health;
  }
}
