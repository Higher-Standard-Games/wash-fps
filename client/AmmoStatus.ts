/**
 * AmmoStatus — shared derivation of "can I fire / should I reload" from the
 * local player's ammo state.
 *
 * Single source of truth for the out-of-ammo red crosshair (#1), the
 * "OUT OF AMMO" banner (#1), and the low-clip "RELOAD" warning (#2). Both the
 * Crosshair overlay (driven from the Game render loop) and the AmmoWarning HUD
 * widget read through here so the two signals never drift apart.
 */

import { WEAPONS } from "../../../shared/entities/definitions/weapons/WeaponsTable";
import type { HUDWeaponAmmo } from "./HUDState";

export interface AmmoStatus {
  /** Weapon cannot fire — no clip and no reserve. Drives the red-X crosshair + banner. */
  outOfAmmo: boolean;
  /** Clip weapon whose magazine is low (or empty) with reserve to reload from. */
  lowClip: boolean;
  /** Melee / infinite starter weapon (blade, gunblade) — never runs dry. */
  infinite: boolean;
}

/** Starter weapons that never run out of ammo (matches DroppedWeaponRenderer.isDefaultWeapon). */
const INFINITE_WEAPONS = new Set(["blade", "gunblade"]);

/** Fraction of clipSize at or below which we surface the RELOAD hint. */
const LOW_CLIP_FRACTION = 0.2;

export function getAmmoStatus(weaponId: string, ammo: HUDWeaponAmmo | undefined): AmmoStatus {
  if (INFINITE_WEAPONS.has(weaponId)) {
    return { outOfAmmo: false, lowClip: false, infinite: true };
  }

  // HUDWeaponAmmo is either {clip, reserve} (clip weapons) or a bare pool number.
  let clip = 0;
  let reserve = 0;
  if (typeof ammo === "object" && ammo !== null) {
    clip = ammo.clip;
    reserve = ammo.reserve;
  } else if (typeof ammo === "number") {
    reserve = ammo;
  }

  const def = WEAPONS[weaponId];
  const outOfAmmo = clip <= 0 && reserve <= 0;

  let lowClip = false;
  if (def?.reloadModel === "clip" && def.clipSize > 0 && !outOfAmmo) {
    const threshold = Math.max(1, Math.ceil(def.clipSize * LOW_CLIP_FRACTION));
    // Warn when the magazine is low (or already empty) and there is reserve to reload from.
    lowClip = clip <= threshold && reserve > 0;
  }

  return { outOfAmmo, lowClip, infinite: false };
}
