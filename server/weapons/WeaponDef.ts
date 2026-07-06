/**
 * Weapon Definition (Server-side adapter)
 *
 * Imports weapon definitions from shared and re-exports them
 * as a WEAPONS lookup map keyed by weapon ID.
 *
 * All weapon stats live in src/shared/entities/definitions/weapons/*.ts
 * This file is the single bridge between shared defs and server systems.
 */

import {
  BLADE,
  ELECTROBOLT,
  GRENADE_LAUNCHER,
  GUNBLADE,
  INSTAGUN,
  LASERGUN,
  MACHINEGUN,
  PLASMAGUN,
  RIOTGUN,
  ROCKET_LAUNCHER,
  VOLTAIC,
} from "../../../../shared/entities/definitions/weapons";
import type { CrosshairConfig, WeaponDef } from "../../../../shared/entities/WeaponDef";

// Re-export types for consumers
export type { CrosshairConfig, WeaponDef };

/**
 * WEAPONS lookup map keyed by weapon ID.
 * All stats come from shared definitions — single source of truth.
 */
export const WEAPONS: Record<string, WeaponDef> = {
  [GUNBLADE.id]: GUNBLADE,
  [MACHINEGUN.id]: MACHINEGUN,
  [RIOTGUN.id]: RIOTGUN,
  [GRENADE_LAUNCHER.id]: GRENADE_LAUNCHER,
  [ROCKET_LAUNCHER.id]: ROCKET_LAUNCHER,
  [PLASMAGUN.id]: PLASMAGUN,
  [VOLTAIC.id]: VOLTAIC,
  [LASERGUN.id]: LASERGUN,
  [ELECTROBOLT.id]: ELECTROBOLT,
  [INSTAGUN.id]: INSTAGUN,
  [BLADE.id]: BLADE,
  // ── Projectile aliases (F8) ──
  // Projectiles register under their own `projectileId` (not the firing weapon's id),
  // so ProjectileSystem's WEAPONS[defId] damage/splash lookup and the client's
  // impact/model selection key off a single, stable projectile identity. Each alias
  // carries the owning weapon's stats (a projectile inherits its weapon's damage/splash).
  rocket: ROCKET_LAUNCHER,
  grenade: GRENADE_LAUNCHER,
  plasma_bolt: PLASMAGUN,
  gunblade_blast: GUNBLADE,
  // Blade's charged blast gets RL-equal knockback (KB = damage × scale: 50×20 = 1000).
  blade_blast: { ...BLADE, knockbackScale: 20.0 },
};
