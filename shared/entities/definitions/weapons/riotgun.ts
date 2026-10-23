/**
 * Riotgun - Weapon Definition
 *
 * Shotgun-style hitscan weapon firing 18 pellets per shot.
 * Stats from Warsow gs_weapondefs.c.
 */

import { EntityType } from "../../../../../../shared/entities/EntityType";
import type { WeaponDef } from "../../../../../../shared/entities/WeaponDef";

export const RIOTGUN: WeaponDef = {
  // Identity
  id: "riotgun",
  name: "Riotgun",
  type: EntityType.WEAPON,
  classname: "weapon_riotgun",

  // Model
  modelPath: "/data/models/weapons/riotgun/riotgun.glb",
  scale: 2.0,

  // Pickup glow (warm orange)
  glowColor: { r: 1.0, g: 0.6, b: 0.2 },

  // Gameplay (server-authoritative)
  // 5 damage per pellet × 18 pellets = 90 max damage. Pellet damage is rounded
  // per hit (CombatSystem), so shaving the 100 down via fractional damage would
  // not work — 4.5 rounds straight back to 5. Fewer pellets it is.
  damage: 5,
  fireRate: 1.25, // 800ms between shots
  clipSize: 8,
  reloadModel: "clip",
  ammoType: "shells",
  maxAmmo: 24,
  reloadTime: 0.832,
  range: 8192,
  hitscan: true,
  hitscanType: "pellet",
  spread: 8, // 8° shotgun cone (hip-fire)
  adsSpread: 2, // 2° when ADS (4x tighter)
  fireMode: "semi",
  burstCount: 18, // 18 pellets per shot
  pickupBounds: { x: 32, y: 32, z: 32 },
  pelletCount: 18,
  knockbackScale: 2.5,
  pickupAmmo: 8,
  useLagCompensation: true,
  crosshair: { style: "cross", baseGap: 12, lineLength: 8, lineWidth: 2 },
  speedBonus: 5, // Light shotgun: +5 speed (405 run)
  recoilScale: 4.0, // Heavy shotgun kick (4x normal — strong upward + backward)

  // View Model — GLB format
  viewModel: {
    modelPath: "/data/models/weapons/riotgun/riotgun.glb",
    viewModelFormat: "glb",

    hipOffset: { x: 0, y: -25, z: -1 },
    hipRotation: { x: 0, y: 0, z: 0 },

    adsOffset: { x: 0, y: -21, z: -5 },
    adsRotation: { x: 0, y: 0, z: 0 },

    scale: 2.0,
  },

  // ADS
  ads: {
    time: 0.08,
    fovReduction: 15,
    sensitivity: 0.5,
    movementPenalty: 0.5,
  },

  // Muzzle Flash — bright warm
  muzzleFlash: {
    color: { r: 1.0, g: 0.7, b: 0.2 },
    intensity: 25,
    range: 45,
    duration: 0.14,
    style: "plume",
    scale: 1.4,
  },
};
