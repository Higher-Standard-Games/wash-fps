/**
 * Rocket Launcher - Weapon Definition
 *
 * Classic splash damage projectile weapon.
 * Stats from Warsow gs_weapondefs.c.
 */

import { EntityType } from "../../../../../../shared/entities/EntityType";
import type { WeaponDef } from "../../../../../../shared/entities/WeaponDef";

export const ROCKET_LAUNCHER: WeaponDef = {
  // Identity
  id: "rlauncher",
  name: "Rocket Launcher",
  type: EntityType.WEAPON,
  classname: "weapon_rocketlauncher",

  // Model
  modelPath: "/data/models/weapons/rlauncher/rlauncher.glb",
  scale: 2.0,

  // Pickup glow (red-orange)
  glowColor: { r: 1.0, g: 0.4, b: 0.1 },

  // Gameplay (server-authoritative)
  damage: 80,
  fireRate: 1.25, // 800ms between shots
  clipSize: 0,
  reloadModel: "pool",
  ammoType: "rockets",
  maxAmmo: 20,
  reloadTime: 0.832,
  range: 10000,
  hitscan: false,
  fireMode: "semi",
  hipfireBlocked: true,
  adsRequireReady: true,
  spread: 1,
  adsSpread: 0,
  pickupBounds: { x: 32, y: 32, z: 32 },
  projectileId: "rocket",
  projectileSpeed: 1814,
  splashRadius: 150,
  splashDamage: 80,
  minSplashDamage: 15,
  knockbackScale: 10.0,
  recoilScale: 3.0, // Strong rocket recoil (similar to shotgun feel)
  pickupAmmo: 10,
  useLagCompensation: false,
  crosshair: { style: "cross_dot", baseGap: 6, lineLength: 6, lineWidth: 2 },
  speedBonus: -25, // Heavy weapon: -25 speed (375 run)

  // View Model — GLB format
  viewModel: {
    modelPath: "/data/models/weapons/rlauncher/rlauncher.glb",
    viewModelFormat: "glb",

    hipOffset: { x: 0, y: -25, z: -1 },
    hipRotation: { x: 0, y: 0, z: 0 },

    adsOffset: { x: 0, y: -20, z: -5 },
    adsRotation: { x: 0, y: 0, z: 0 },

    scale: 2.0,
  },

  // ADS
  ads: {
    time: 0.16,
    fovReduction: 15,
    sensitivity: 0.5,
    movementPenalty: 0.5,
  },

  // Muzzle Flash — fiery orange
  muzzleFlash: {
    color: { r: 1.0, g: 0.5, b: 0.1 },
    intensity: 30,
    range: 50,
    duration: 0.16,
    style: "plume",
    scale: 2.4,
  },
};
