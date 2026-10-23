/**
 * Rocket - Projectile Definition
 *
 * Classic rocket projectile with splash damage.
 * Stats from Warsow gs_weapondefs.c.
 */

import { EntityType } from "../../../../../../shared/entities/EntityType";
import type { ProjectileDef } from "../../../../../../shared/entities/ProjectileDef";

export const ROCKET: ProjectileDef = {
  // Identity
  id: "rocket",
  name: "Rocket",
  type: EntityType.PROJECTILE,
  classname: "projectile_rocket",

  // Projectile model
  modelPath: "models/objects/projectile/rlauncher/rocket_strong.md3",
  scale: 1.0,

  // Gameplay (server-authoritative)
  speed: 1150,
  damage: 80,
  splashDamage: 15,
  splashRadius: 125,
  lifetime: 10.0,
  gravity: 0,
  bounces: 0,

  // Light
  lightColor: { r: 1.0, g: 0.5, b: 0.1 },
  lightIntensity: 10,
  lightRange: 30,

  // Impact: the procedural explosion (ExplosionEffect), not a model

  trailEffect: "rocket_trail",
  impactEffect: "rocket_impact",
};
