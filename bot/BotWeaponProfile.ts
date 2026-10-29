/**
 * BotWeaponProfile — Static weapon knowledge for bot AI
 *
 * Pre-computes weapon properties from WeaponDef at import time.
 * Zero per-tick cost — just a map lookup.
 *
 * Usage:
 *   const profile = getWeaponProfile('machinegun');
 *   if (profile.aimsDownSights) buttons |= InputButtons.ALT_FIRE;
 */

import type { WeaponDef } from "../../../shared/entities/WeaponDef";
import { BLADE } from "../shared/entities/definitions/weapons/blade";
import { ELECTROBOLT } from "../shared/entities/definitions/weapons/electrobolt";
import { GRENADE_LAUNCHER } from "../shared/entities/definitions/weapons/glauncher";
import { MACHINEGUN } from "../shared/entities/definitions/weapons/machinegun";
import { PLASMAGUN } from "../shared/entities/definitions/weapons/plasmagun";
import { RIOTGUN } from "../shared/entities/definitions/weapons/riotgun";
import { ROCKET_LAUNCHER } from "../shared/entities/definitions/weapons/rlauncher";
import { VOLTAIC } from "../shared/entities/definitions/weapons/voltaic";
import { canonicalWeaponId } from "../shared/entities/definitions/weapons/WeaponsTable";
import { InputButtons } from "./BotConfig";

// ── Profile Interface ───────────────────────────────────────────────

export interface WeaponProfile {
  /** Weapon id (matches WeaponDef.id) */
  id: string;

  /** True if melee weapon (range < 200) */
  isMelee: boolean;

  /** True if hitscan (instant hit) */
  isHitscan: boolean;

  /** True if projectile weapon (!hitscan && !melee) */
  isProjectile: boolean;

  /** True if continuous beam weapon */
  isBeam: boolean;

  /** True if weapon cannot hipfire (must ADS to shoot) */
  needsADS: boolean;

  /** True if aiming down sights makes its shots land closer to the aim (tighter spread, no beam wander) */
  aimsDownSights: boolean;

  /** Server ticks ADS must be held before a shot counts as aimed (0 when it counts at once) */
  adsReadyTicks: number;

  /** True if has splash damage */
  hasSplash: boolean;

  /** True if alt-fire can charge and release a projectile */
  hasChargedProjectile: boolean;

  /** Minimum hold time before a charged projectile can fire, in server ticks */
  chargeMinTicks: number;

  /** Maximum useful hold time for a charged projectile, in server ticks */
  chargeMaxTicks: number;

  /** Fire mode: 'auto' (hold fire) or 'semi' (tap fire) */
  fireMode: string;

  /** Projectile speed for aim prediction (0 if hitscan) */
  projectileSpeed: number;

  /** Splash radius for aim-at-feet logic */
  splashRadius: number;

  /** Effective minimum range */
  idealMinRange: number;

  /** Effective maximum range */
  idealMaxRange: number;

  /** Damage per second (damage × fireRate) */
  dps: number;

  /** ADS movement speed penalty (0 = no penalty, 0.7 = 70% slower) */
  adsMovePenalty: number;

  /** Raw damage per hit */
  damagePerHit: number;
}

// ── Build profiles from weapon defs ─────────────────────────────────

function buildProfile(def: WeaponDef): WeaponProfile {
  const isMelee = (def.range ?? 0) < 200;
  const isHitscan = def.hitscan === true;
  const isBeam = def.hitscanType === "beam";
  const isProjectile = !isHitscan && !isMelee;
  const hasSplash = (def.splashRadius ?? 0) > 0;
  const needsADS = def.hipfireBlocked === true;
  const aimsDownSights =
    !isMelee && (needsADS || (def.adsSpread ?? def.spread ?? 0) < (def.spread ?? 0) || (def.beamWanderDeg ?? 0) > 0);
  const hasChargedProjectile = Boolean(def.chargedProjectileId);

  // Compute ideal range brackets
  let idealMinRange: number;
  let idealMaxRange: number;

  if (isMelee) {
    idealMinRange = 0;
    idealMaxRange = def.range ?? 100;
  } else if (isBeam) {
    // Beam weapons: effective at short-medium range
    idealMinRange = 50;
    idealMaxRange = Math.min(def.range ?? 850, 900);
  } else if (hasSplash && isProjectile) {
    // Splash projectiles (RL, GL): medium range, not too close (self-damage)
    idealMinRange = 200;
    idealMaxRange = 1200;
  } else if (isProjectile) {
    // Non-splash projectiles (plasma): short-medium
    idealMinRange = 100;
    idealMaxRange = 1000;
  } else if ((def.pelletCount ?? 0) > 0) {
    // Shotgun: close range
    idealMinRange = 50;
    idealMaxRange = 500;
  } else if (def.fireRate && def.fireRate < 1) {
    // Slow hitscan (EB, insta): sniping at long range
    idealMinRange = 400;
    idealMaxRange = 5000;
  } else {
    // Fast hitscan (MG): medium-long
    idealMinRange = 100;
    idealMaxRange = 3000;
  }

  // DPS calculation
  const damage = def.damage ?? 0;
  const fireRate = def.fireRate ?? 1;
  const pellets = def.pelletCount ?? 1;
  const dps = damage * pellets * fireRate;

  return {
    id: def.id,
    isMelee,
    isHitscan,
    isProjectile,
    isBeam,
    needsADS,
    aimsDownSights,
    adsReadyTicks: def.adsRequireReady ? Math.ceil((def.ads?.time ?? 0.08) * 125) : 0,
    hasSplash,
    hasChargedProjectile,
    chargeMinTicks: Math.ceil((def.chargeMinTime ?? 0.5) * 125),
    chargeMaxTicks: Math.ceil((def.chargeTime ?? 1.0) * 125),
    fireMode: def.fireMode ?? "semi",
    projectileSpeed: def.projectileSpeed ?? (hasChargedProjectile ? 2500 : 0),
    splashRadius: def.splashRadius ?? 0,
    idealMinRange,
    idealMaxRange,
    dps,
    adsMovePenalty: def.ads?.movementPenalty ?? 0,
    damagePerHit: damage * pellets,
  };
}

// ── Static Lookup Table ─────────────────────────────────────────────

const ALL_WEAPON_DEFS: WeaponDef[] = [
  BLADE,
  MACHINEGUN,
  RIOTGUN,
  ELECTROBOLT,
  VOLTAIC,
  PLASMAGUN,
  ROCKET_LAUNCHER,
  GRENADE_LAUNCHER,
];

const PROFILES: Map<string, WeaponProfile> = new Map();
for (const def of ALL_WEAPON_DEFS) {
  PROFILES.set(def.id, buildProfile(def));
}

// Default fallback profile for unknown weapons
const DEFAULT_PROFILE: WeaponProfile = {
  id: "unknown",
  isMelee: false,
  isHitscan: true,
  isProjectile: false,
  isBeam: false,
  needsADS: false,
  aimsDownSights: false,
  adsReadyTicks: 0,
  hasSplash: false,
  hasChargedProjectile: false,
  chargeMinTicks: 0,
  chargeMaxTicks: 0,
  fireMode: "semi",
  projectileSpeed: 0,
  splashRadius: 0,
  idealMinRange: 100,
  idealMaxRange: 2000,
  dps: 50,
  adsMovePenalty: 0.5,
  damagePerHit: 10,
};

// ── Public API ──────────────────────────────────────────────────────

/**
 * Get weapon profile by weapon ID.
 */
export function getWeaponProfile(weaponId: string): WeaponProfile {
  return PROFILES.get(canonicalWeaponId(weaponId)) ?? DEFAULT_PROFILE;
}

/**
 * Select best weapon for the given distance from available weapons.
 * Returns { slot, profile } where slot is 1-indexed, or { slot: 0 } to keep current.
 */
export function selectBestWeapon(
  availableWeapons: string[],
  ammo: Record<string, number>,
  currentWeapon: string,
  distance: number,
): { slot: number; profile: WeaponProfile } {
  let bestSlot = 0;
  let bestProfile = getWeaponProfile(currentWeapon);
  let bestScore = -Infinity;

  for (let i = 0; i < availableWeapons.length; i++) {
    const weaponId = availableWeapons[i];
    if (!weaponId) continue;

    const profile = getWeaponProfile(weaponId);

    // Skip weapons with no ammo (undefined = unlimited, e.g. blade)
    const weaponAmmo = ammo[weaponId];
    if (weaponAmmo !== undefined && weaponAmmo <= 0) continue;

    // Score: how well does this weapon fit the current distance?
    let score = profile.dps;

    // Range fitness: bonus if distance is within ideal range
    if (distance >= profile.idealMinRange && distance <= profile.idealMaxRange) {
      score *= 2.0; // Double score for ideal range
    } else if (distance < profile.idealMinRange) {
      // Too close for this weapon
      const ratio = distance / profile.idealMinRange;
      score *= ratio; // Linear falloff
    } else {
      // Too far for this weapon
      const ratio = profile.idealMaxRange / distance;
      score *= ratio; // Linear falloff
    }

    // Melee bonus at very close range
    if (profile.isMelee && distance < 150) {
      score *= 3.0; // Strong preference for melee when in face
    }

    // Penalty for melee at range
    if (profile.isMelee && distance > 200) {
      score = 0; // Never pick melee at range
    }

    if (score > bestScore) {
      bestScore = score;
      bestProfile = profile;
      bestSlot = i + 1; // 1-indexed
    }
  }

  // Don't switch if already on best weapon
  if (availableWeapons[bestSlot - 1] === currentWeapon) {
    return { slot: 0, profile: bestProfile };
  }

  return { slot: bestSlot, profile: bestProfile };
}

/**
 * The attack buttons for one command with `weaponId` out. A blade swings only on
 * a fresh press, and a press made while the last swing or the weapon switch is
 * still cooling down is lost: held fire would swing once and never again. With
 * a melee weapon, fire is pressed and released on alternate commands, so the
 * next press lands within two ticks of the blade being ready. `pressedLast` is
 * whether the previous command pressed it; the result says whether this one does.
 */
export function pulseMeleeFire(
  buttons: number,
  weaponId: string,
  pressedLast: boolean,
): { buttons: number; pressed: boolean } {
  if ((buttons & InputButtons.FIRE) === 0 || !getWeaponProfile(weaponId).isMelee) return { buttons, pressed: false };
  return pressedLast ? { buttons: buttons & ~InputButtons.FIRE, pressed: false } : { buttons, pressed: true };
}
