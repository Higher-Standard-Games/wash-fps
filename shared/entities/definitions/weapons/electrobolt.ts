/**
 * Electrobolt - Weapon Definition
 *
 * High-damage hitscan sniper weapon with slow fire rate.
 * Stats from Warsow gs_weapondefs.c.
 */

import { EntityType } from "../../../../../../shared/entities/EntityType";
import type { WeaponDef } from "../../../../../../shared/entities/WeaponDef";

export const ELECTROBOLT: WeaponDef = {
  // Identity
  id: "electrobolt",
  name: "Electrobolt",
  type: EntityType.WEAPON,
  classname: "weapon_electrobolt",

  // Model
  modelPath: "/data/models/weapons/electrobolt/electrobolt.glb",
  scale: 2.0,

  // Pickup glow (electric blue)
  glowColor: { r: 0.3, g: 0.5, b: 1.0 },

  // Gameplay (server-authoritative)
  damage: 75,
  fireRate: 0.8, // 1250ms reload = 0.8 shots/sec
  clipSize: 0,
  reloadModel: "pool",
  ammoType: "bolts",
  maxAmmo: 10,
  reloadTime: 1.625,
  range: 10000,
  hitscan: true,
  hitscanType: "bolt",
  adsRequireReady: true,
  spread: 20,
  adsSpread: 0,
  fireMode: "semi",
  pickupBounds: { x: 32, y: 32, z: 32 },
  knockbackScale: 3.5,
  pickupAmmo: 5,
  useLagCompensation: true,
  crosshair: { style: "cross_dot", baseGap: 2, lineLength: 5, lineWidth: 1 },
  speedBonus: -25, // Heavy sniper: -25 speed (375 run)
  recoilScale: 4.0, // Heavy upward/backward kick, matching Riotgun; ADS reduces it to 20%.

  // View Model — GLB format
  viewModel: {
    modelPath: "/data/models/weapons/electrobolt/electrobolt.glb",
    viewModelFormat: "glb",

    // Energy-coil glow: applied as additive emissive (WO-EB1). The GLB's baked
    // emissive channel is empty, so the coil rendered flat/black without this.
    glowTexture: "/data/models/weapons/electrobolt/electrobolt_glow.tga",

    hipOffset: { x: 0, y: -25, z: -1 },
    hipRotation: { x: 0, y: 0, z: 0 },

    adsOffset: { x: 0, y: -21, z: -5 },
    adsRotation: { x: 0, y: 0, z: 0 },

    scale: 2.0,
  },

  // ADS
  ads: {
    time: 0.375,
    fovReduction: 25, // More zoom for sniper
    sensitivity: 0.3,
    movementPenalty: 0.7,
  },

  // Muzzle Flash — electric blue
  muzzleFlash: {
    color: { r: 0.3, g: 0.5, b: 1.0 },
    intensity: 35,
    range: 60,
    duration: 0.12,
    style: "arcs",
    scale: 2.3,
  },
};
