/**
 * Blade - Weapon Definition
 *
 * New default melee weapon replacing gunblade.
 * Primary fire: fast melee slash (80 damage, 100 unit range, ~500ms cooldown)
 * Charged fire: hold attack 1s → releases teal energy projectile (50 damage, large splash)
 * Uses the packaged Arc Blade GLB, normalized to the established blade length.
 */

import { EntityType } from "../../../../../../shared/entities/EntityType";
import type { WeaponDef } from "../../../../../../shared/entities/WeaponDef";

export const BLADE: WeaponDef = {
  // Identity
  id: "blade",
  name: "Blade",
  type: EntityType.WEAPON,
  classname: "weapon_blade",

  // Model (world/pickup)
  modelPath: "/data/models/weapons/blade/arc_blade.glb",
  scale: 1.0,

  // Pickup glow — teal energy
  glowColor: { r: 0.05, g: 1.0, b: 0.9 },

  // Gameplay (server-authoritative) — primary fire: melee slash
  damage: 80, // Big hit for close range
  fireRate: 2.0, // 63 ticks @125Hz = 504ms between swings (2.0 doesn't divide 125 exactly)
  clipSize: 0,
  reloadModel: "none",
  ammoType: "blade",
  maxAmmo: 1,
  reloadTime: 0.65,
  range: 100, // Melee reach (~1.5 player widths)
  hitscan: true, // Melee is instant hit check
  fireMode: "semi",
  pickupBounds: { x: 32, y: 32, z: 32 },
  knockbackScale: 10.0, // Same as RL for melee knockback
  speedBonus: 10, // Agile melee: +10 speed (410 run)
  useLagCompensation: false,
  crosshair: { style: "dot", baseGap: 0, lineLength: 0, lineWidth: 2 },

  // Melee-specific
  meleeRadius: 48, // Wide cone check radius (players within this of ray center count)
  meleeDamageDelay: 0.075, // 75ms delay before damage check (dodge window)
  meleeDashDistance: 64, // Server-authoritative step-in while holding forward and advancing

  // Charged attack — hold ALT_FIRE to charge, release to fire projectile
  chargeTime: 1.0, // Max charge time (seconds)
  chargeMinTime: 0.5, // Min charge to fire (seconds)
  chargedProjectileId: "blade_blast",
  chargedDamageMin: 25, // Damage at minimum charge (500ms)
  chargedDamageMax: 50, // Damage at full charge (1000ms)

  // View Model — GLB format
  viewModel: {
    modelPath: "/data/models/weapons/blade/arc_blade.glb",
    viewModelFormat: "glb",

    // Blade has no ADS — hip and ads positions are identical
    hipOffset: { x: 10, y: -28, z: 10 },
    hipRotation: { x: Math.PI / 2, y: Math.PI / 2, z: Math.PI / 6 + Math.PI },

    adsOffset: { x: 10, y: -28, z: 10 },
    adsRotation: { x: Math.PI / 2, y: Math.PI / 2, z: Math.PI / 6 + Math.PI },

    scale: 30.0,
  },

  // ADS (not really used for melee, but required by interface)
  ads: {
    time: 0.08,
    fovReduction: 0,
    sensitivity: 1.0,
    movementPenalty: 0,
  },

  // Teal energy flash on swing and charged release
  muzzleFlash: {
    color: { r: 0.05, g: 1.0, b: 0.9 },
    intensity: 25,
    range: 40,
    duration: 0.16,
  },
};
