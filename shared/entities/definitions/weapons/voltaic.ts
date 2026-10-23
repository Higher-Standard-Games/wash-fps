/**
 * Voltaic - Weapon Definition
 *
 * Continuous beam hitscan weapon using the modern Lasergun model set.
 * Orange/yellow beam with charge-up mechanic.
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

  // Runtime conversion of the modern Lasergun IQM supplied by washoi_weapons.pk3.
  modelPath: "/data/models/weapons/lasergun/lasergun.glb",
  scale: 2.0,

  // Pickup glow — electric cyan
  glowColor: { r: 0.2, g: 0.8, b: 1.0 },

  // Gameplay (server-authoritative)
  damage: 7,
  fireRate: 20, // 6 ticks @125Hz = 48ms/shot ≈ 20.8/s (20 doesn't divide 125 exactly)
  // Continuous-beam clip: 120 cells run ~5.8s before a brief 0.5s reload, so the
  // beam's rhythm isn't broken every ~3s the way the old 60-cell / 1.3s reload did
  // (that was ~31% downtime — unacceptable for a held beam). Total ammo is the same
  // 180 cells (clip 120 + reserve 60), just far fewer, quicker interruptions.
  clipSize: 120,
  reloadModel: "clip",
  ammoType: "lasers", // own pool — no longer shared with the plasmagun's cells
  maxAmmo: 60,
  reloadTime: 0.5,
  range: 850, // Short range beam
  hitscan: true,
  hitscanType: "beam",
  fireMode: "auto",
  pickupBounds: { x: 32, y: 32, z: 32 },
  knockbackScale: 1.5,
  useLagCompensation: true,
  crosshair: { style: "dot", baseGap: 0, lineLength: 0, lineWidth: 3 },
  recoilScale: 0.1, // Energy gun — very stable, minimal recoil

  // Canonical Voltaic chain behavior. Warsow `lasergun` compatibility input is
  // normalized to this same definition before combat runs.
  chainCount: 2, // arc to up to 2 extra enemies
  chainRadius: 280, // links up to 280u apart
  chainFalloff: 0.5, // 100% → 50% → 25% per hop

  // Hipfire downside: the beam is unstable and bends/drifts from the hip, so it's
  // imprecise at range unless you ADS (which locks it straight). Warsow-LG feel.
  beamWanderDeg: 4,

  // View model — runtime conversion of the modern z_weapons IQM.
  viewModel: {
    modelPath: "/data/models/weapons/lasergun/lasergun.glb",
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
