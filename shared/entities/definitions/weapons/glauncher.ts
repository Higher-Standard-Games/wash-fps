/**
 * Grenade Launcher - Weapon Definition
 *
 * Lobbing projectile weapon with gravity and bounces.
 * Stats from Warsow gs_weapondefs.c.
 */

import { EntityType } from "../../../../../../shared/entities/EntityType";
import type { WeaponDef } from "../../../../../../shared/entities/WeaponDef";
import { GRENADE } from "../projectiles/grenade";

export const GRENADE_LAUNCHER: WeaponDef = {
  // Identity
  id: "glauncher",
  name: "Grenade Launcher",
  type: EntityType.WEAPON,
  classname: "weapon_grenadelauncher",

  // Model
  modelPath: "/data/models/weapons/glauncher/glauncher.glb",
  scale: 2.0,

  // Pickup glow (green)
  glowColor: { r: 0.3, g: 0.9, b: 0.2 },

  // Gameplay (server-authoritative)
  damage: 80,
  fireRate: 1.25, // 800ms between shots
  clipSize: 0,
  reloadModel: "pool",
  ammoType: "grenades",
  maxAmmo: 20,
  reloadTime: 0.832,
  range: 10000,
  hitscan: false,
  fireMode: "semi",
  hipfireBlocked: true,
  adsRequireReady: true,
  spread: 4,
  adsSpread: 0,
  pickupBounds: { x: 32, y: 32, z: 32 },
  projectileId: "grenade",
  projectileSpeed: GRENADE.speed,
  projectileGravity: GRENADE.gravity, // arcs downward (x base 800); other projectiles fly straight (F6)
  splashRadius: 150,
  splashDamage: 80,
  minSplashDamage: 15,
  knockbackScale: 10.0,
  pickupAmmo: 10,
  useLagCompensation: false,
  crosshair: { style: "cross_dot", baseGap: 6, lineLength: 6, lineWidth: 2 },

  // View Model — GLB format
  viewModel: {
    modelPath: "/data/models/weapons/glauncher/glauncher.glb",
    viewModelFormat: "glb",

    hipOffset: { x: 0, y: -25, z: -1 },
    hipRotation: { x: 0, y: 0, z: 0 },

    adsOffset: { x: 0, y: -20, z: -5 },
    adsRotation: { x: 0, y: 0, z: 0 },

    scale: 2.0,
  },

  // Barrel sub-model: turns a full revolution and one 45° step while the
  // next grenade loads
  barrels: [
    {
      modelPath: "/data/models/weapons/glauncher/glauncher_barrel.glb",
      spinSpeed: 0,
      spinDirection: 1,
      fireStepDegrees: 405,
    },
  ],

  // ADS
  ads: {
    time: 0.16,
    fovReduction: 15,
    sensitivity: 0.5,
    movementPenalty: 0.5,
  },

  // Muzzle Flash — green tint
  muzzleFlash: {
    color: { r: 0.6, g: 1.0, b: 0.3 },
    intensity: 22,
    range: 40,
    duration: 0.15,
    style: "plume",
    scale: 2.2,
  },
};
