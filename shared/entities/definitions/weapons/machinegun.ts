/**
 * Machinegun - Weapon Definition
 *
 * Fast-firing hitscan weapon. Hip fire sprays wide and opens up the longer the
 * trigger is held; aimed, it stays tight but kicks hard.
 */

import { EntityType } from "../../../../../../shared/entities/EntityType";
import type { WeaponDef } from "../../../../../../shared/entities/WeaponDef";

export const MACHINEGUN: WeaponDef = {
  // Identity
  id: "machinegun",
  name: "Machinegun",
  type: EntityType.WEAPON,
  classname: "weapon_machinegun",

  // Model
  modelPath: "/data/models/weapons/machinegun/machinegun.glb",
  scale: 2.0,

  // Pickup glow (yellow-orange)
  glowColor: { r: 1.0, g: 0.9, b: 0.3 },

  // Gameplay (server-authoritative)
  damage: 10,
  fireRate: 10, // 13 ticks @125Hz = 104ms/shot ≈ 9.6/s (10 doesn't divide 125 exactly)
  clipSize: 30, // 30-round clip (~3.1s of fire) — a real magazine, not the old near-free 0.13s hitch
  reloadModel: "clip",
  ammoType: "bullets",
  maxAmmo: 120, // reserve
  reloadTime: 1.5, // proper reload: 188 ticks @125Hz = 1.504s
  range: 6000,
  hitscan: true,
  hitscanType: "tracer",
  // Cone half-angles. The first shots are tight; held, the cone opens to the
  // maxima below and closes again in a little over half a second off the trigger.
  spread: 2.5,
  adsSpread: 0.4,
  spreadBloom: {
    maxSpread: 6,
    adsMaxSpread: 1.2,
    shotsToMax: 8,
    recoverySeconds: 0.6,
  },
  fireMode: "auto",
  pickupBounds: { x: 32, y: 32, z: 32 },
  knockbackScale: 2.0,
  useLagCompensation: true,
  crosshair: { style: "cross", baseGap: 4, lineLength: 6, lineWidth: 2 },

  // Kick: a heavy view model and a camera that jumps on every shot, harder when
  // aimed, so the gun reads as powerful. Visual only.
  recoilScale: 1.6,
  adsRecoilScale: 0.5,
  viewKick: { pitch: 0.25, yaw: 0.12, adsPitch: 0.4, adsYaw: 0.15, recoverSeconds: 0.14 },

  // View Model — GLB format
  viewModel: {
    modelPath: "/data/models/weapons/machinegun/machinegun.glb",
    viewModelFormat: "glb",

    hipOffset: { x: 0, y: -25, z: -1 },
    hipRotation: { x: 0, y: 0, z: 0 },

    adsOffset: { x: 0, y: -20, z: -5 },
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

  // Muzzle Flash — bright yellow
  muzzleFlash: {
    color: { r: 1.0, g: 0.9, b: 0.3 },
    intensity: 18,
    range: 30,
    duration: 0.075,
  },
};
