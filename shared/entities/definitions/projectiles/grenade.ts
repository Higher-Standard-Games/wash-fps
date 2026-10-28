/**
 * Grenade - Projectile Definition
 *
 * Lobbing projectile with gravity, bounces, and splash damage.
 * Stats from Warsow gs_weapondefs.c.
 */

import { EntityType } from "../../../../../../shared/entities/EntityType";
import type { ProjectileDef } from "../../../../../../shared/entities/ProjectileDef";

export const GRENADE: ProjectileDef = {
  // Identity
  id: "grenade",
  name: "Grenade",
  type: EntityType.PROJECTILE,
  classname: "projectile_grenade",

  // Projectile model
  modelPath: "models/objects/projectile/glauncher/grenadestrong.md3",
  scale: 1.0,

  // Gameplay (server-authoritative)
  // An aimed arc reaches speed² / gravity: 1080 u/s against ~930 u/s² carries
  // 30% farther than 900 against ~840, and the fuse lasts as much longer
  speed: 1080,
  damage: 80,
  splashDamage: 15,
  splashRadius: 125,
  lifetime: 1.625,
  gravity: 1.163,
  bounces: 3, // Bounces before explode
  bounceFactor: 0.45,

  // Light
  lightColor: { r: 0.3, g: 0.5, b: 1.0 },
  lightIntensity: 6,
  lightRange: 20,

  // Impact: the procedural explosion (ExplosionEffect), not a model

  trailEffect: "grenade_trail",
  impactEffect: "grenade_impact",
};
