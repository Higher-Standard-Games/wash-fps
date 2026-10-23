/**
 * Instagun - Weapon Definition
 *
 * One-hit-kill hitscan weapon (instagib mode).
 * Stats from Warsow gs_weapondefs.c.
 */

import { EntityType } from "../../../../../../shared/entities/EntityType";
import type { WeaponDef } from "../../../../../../shared/entities/WeaponDef";

export const INSTAGUN: WeaponDef = {
  // Identity
  id: "instagun",
  name: "Instagun",
  type: EntityType.WEAPON,
  classname: "weapon_instagun",

  // Model
  modelPath: "models/weapons/instagun/instagun.md3",
  scale: 2.0,

  // Pickup glow (bright purple)
  glowColor: { r: 0.8, g: 0.2, b: 1.0 },

  // Gameplay (server-authoritative)
  damage: 200,
  fireRate: 0.77, // 1300ms reload = ~0.77 shots/sec
  clipSize: 0,
  reloadModel: "pool",
  ammoType: "instas",
  maxAmmo: 5,
  reloadTime: 1.69,
  range: 8024,
  hitscan: true,
  hitscanType: "bolt",
  fireMode: "semi",
  pickupBounds: { x: 32, y: 32, z: 32 },
  // Splash exists for movement, not enemy AoE: shooting a surface launches the
  // shooter (instagib "insta-jump"). Self-damage is gated by the gametype
  // (instagib = 0), but knockback still applies (WeaponSystem.applyHitscanSplash).
  splashRadius: 80,
  splashDamage: 50,
  minSplashDamage: 10,
  knockbackScale: 12.0,
  useLagCompensation: true,
  crosshair: { style: "circle", baseGap: 0, lineLength: 0, lineWidth: 2 },

  // View Model
  viewModel: {
    modelPath: "models/weapons/instagun/instagun.md3",
    handModelPath: "models/weapons/instagun/instagun_hand.md3",
    flashModelPath: "models/weapons/instagun/instagun_flash.md3",

    hipOffset: { x: 10, y: -19, z: 25 },
    hipRotation: { x: 0, y: -Math.PI / 2, z: 0 },

    adsOffset: { x: 0, y: -15, z: 25 },
    adsRotation: { x: 0, y: -Math.PI / 2, z: 0 },

    scale: 2.0,
  },

  // ADS
  ads: {
    time: 0.08,
    fovReduction: 20,
    sensitivity: 0.4,
    movementPenalty: 0.6,
  },

  // Muzzle Flash — bright purple
  muzzleFlash: {
    color: { r: 0.8, g: 0.2, b: 1.0 },
    intensity: 40,
    range: 70,
    duration: 0.12,
    style: "arcs",
    scale: 2.0,
  },
};
