/**
 * Voltaic - Weapon Definition
 *
 * Continuous hitscan beam with chain damage and hipfire wander.
 */

import { EntityType } from "../../../../../../shared/entities/EntityType";
import type { WeaponDef } from "../../../../../../shared/entities/WeaponDef";

export const VOLTAIC: WeaponDef = {
  // Identity
  id: "voltaic",
  name: "Voltaic",
  type: EntityType.WEAPON,
  classname: "weapon_voltaic",
  classnameAliases: ["weapon_lasergun"],

  modelPath: "/data/models/weapons/voltaic/voltaic.glb",
  scale: 2.0,

  // Pickup glow — electric cyan
  glowColor: { r: 0.2, g: 0.8, b: 1.0 },

  // Gameplay (server-authoritative)
  damage: 7,
  fireRate: 20, // 6 ticks @125Hz = 48ms/shot ≈ 20.8/s (20 doesn't divide 125 exactly)
  clipSize: 120,
  reloadModel: "clip",
  ammoType: "lasers",
  maxAmmo: 60,
  reloadTime: 1.5,
  range: 850, // Short range beam
  hitscan: true,
  hitscanType: "beam",
  fireMode: "auto",
  pickupBounds: { x: 32, y: 32, z: 32 },
  knockbackScale: 1.5,
  useLagCompensation: true,
  crosshair: { style: "dot", baseGap: 0, lineLength: 0, lineWidth: 3 },
  recoilScale: 0.1, // Energy gun — very stable, minimal recoil

  // Weapon aliases are normalized to this definition before combat runs.
  chainCount: 2, // arc to up to 2 extra enemies
  chainRadius: 280, // links up to 280u apart
  chainFalloff: 0.5, // 100% → 50% → 25% per hop

  // Hipfire downside: the beam is unstable and bends/drifts from the hip, so it's
  // imprecise at range unless ADS locks it straight.
  beamWanderDeg: 4,

  // View model
  viewModel: {
    modelPath: "/data/models/weapons/voltaic/voltaic.glb",
    viewModelFormat: "glb",

    hipOffset: { x: 0, y: -25, z: -1 },
    hipRotation: { x: 0, y: 0, z: 0 },

    // Y is viewmodel height; one unit lower keeps the rear housing off the sightline.
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

  // Muzzle Flash — warm orange (matches beam)
  muzzleFlash: {
    color: { r: 1.0, g: 0.7, b: 0.1 },
    intensity: 12,
    range: 25,
    duration: 0.03,
  },
};
