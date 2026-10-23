/**
 * Blade Blast - Projectile Definition
 *
 * Charged blade energy projectile with teal glow and trail.
 * Fires when player holds attack for 1 second.
 * Double plasma splash radius for area denial.
 */

import { EntityType } from "../../../../../../shared/entities/EntityType";
import type { ProjectileDef } from "../../../../../../shared/entities/ProjectileDef";

export const BLADE_BLAST: ProjectileDef = {
  // Identity
  id: "blade_blast",
  name: "Blade Blast",
  type: EntityType.PROJECTILE,
  classname: "projectile_blade",

  // Projectile model
  modelPath: "models/objects/projectile/gunblade/proj_gunbladeblast.md3",
  scale: 1.5,

  // Gameplay (server-authoritative)
  speed: 2500,
  damage: 50,
  splashDamage: 50,
  splashRadius: 90, // 2x plasma (plasma = 40)
  lifetime: 5.0,
  gravity: 0,
  bounces: 0,

  // Light and trail — teal energy
  lightColor: { r: 0.05, g: 1.0, b: 0.9 },
  lightIntensity: 12,
  lightRange: 35,

  // Impact — reuse gunblade hit for now
  impactModelPath: "models/weapon_hits/gunblade/hit_blast.md3",
  impactScale: 3.0,
  impactDuration: 0.4,

  trailEffect: "blade_trail",
  impactEffect: "blade_impact",
};
