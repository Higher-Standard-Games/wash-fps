/**
 * Plasma Bolt - Projectile Definition
 *
 * Fast-moving plasma projectile with cyan glow and trail.
 */

import { EntityType } from "../../../../../../shared/entities/EntityType";
import type { ProjectileDef } from "../../../../../../shared/entities/ProjectileDef";

export const PLASMA_BOLT: ProjectileDef = {
  // Identity
  id: "plasma_bolt",
  name: "Plasma Bolt",
  type: EntityType.PROJECTILE,
  classname: "projectile_plasma",

  // Projectile model - actual MD3 from objects folder!
  modelPath: "models/objects/projectile/plasmagun/proj_plasmagun.md3",
  // Explicit texture (plnew1.tga in same folder)
  texturePaths: ["models/objects/projectile/plasmagun/plnew1.tga"],
  scale: 1.0,

  // Gameplay (server-authoritative)
  speed: 3750, // Units per second (50% faster than original 2500)
  damage: 15,
  splashDamage: 5,
  splashRadius: 40,
  lifetime: 5.0, // Despawn after 5 seconds
  gravity: 0, // No drop
  bounces: 0, // Explode on first hit

  // Light
  lightColor: { r: 0.3, g: 1.0, b: 0.3 }, // Plasma green (matches gun model)
  lightIntensity: 8,
  lightRange: 25,

  // Impact: the procedural explosion (ExplosionEffect), not a model

  trailEffect: "plasma_trail",
  impactEffect: "plasma_impact",
};
