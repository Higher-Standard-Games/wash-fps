/**
 * Entity Initialization - Register all entity definitions
 *
 * Call this on startup to populate the EntityRegistry.
 */

import { getEntityRegistry } from "../../../../shared/entities/EntityRegistry";
// Ammo
import {
  BOLT_AMMO,
  BULLET_AMMO,
  GRENADE_AMMO,
  PLASMA_AMMO,
  ROCKET_AMMO,
  SHELL_AMMO,
  VOLTAIC_AMMO,
} from "./definitions/ammo/index";
// Armor, health & powerups
import { ARMOR_DEFS, HEALTH_DEFS, POWERUP_DEFS } from "./definitions/items";
// Projectiles
import { BLADE_BLAST, GRENADE, PLASMA_BOLT, ROCKET } from "./definitions/projectiles/index";
// Weapons
import {
  BLADE,
  ELECTROBOLT,
  GRENADE_LAUNCHER,
  MACHINEGUN,
  PLASMAGUN,
  RIOTGUN,
  ROCKET_LAUNCHER,
  VOLTAIC,
} from "./definitions/weapons/index";

/**
 * Register all entity definitions with the registry. Safe to call from every
 * path that needs them (network start, map load, joining); only the first
 * call into a registry registers.
 */
export function initializeEntityDefs(): void {
  const registry = getEntityRegistry();
  if (registry.get(MACHINEGUN.id) === MACHINEGUN) return;

  console.log("[EntityDefs] Registering entity definitions...");

  // Weapons
  registry.register(MACHINEGUN);
  registry.register(RIOTGUN);
  registry.register(GRENADE_LAUNCHER);
  registry.register(ROCKET_LAUNCHER);
  registry.register(PLASMAGUN);
  // weapon_lasergun is a classname alias on the one canonical Voltaic def.
  registry.register(VOLTAIC);
  registry.register(ELECTROBOLT);
  registry.register(BLADE);

  // Projectiles
  registry.register(PLASMA_BOLT);
  registry.register(GRENADE);
  registry.register(ROCKET);
  registry.register(BLADE_BLAST);

  // Ammo
  registry.register(PLASMA_AMMO);
  registry.register(BULLET_AMMO);
  registry.register(SHELL_AMMO);
  registry.register(GRENADE_AMMO);
  registry.register(ROCKET_AMMO);
  registry.register(VOLTAIC_AMMO);
  registry.register(BOLT_AMMO);

  // Armor, health & powerup pickups
  for (const def of ARMOR_DEFS) registry.register(def);
  for (const def of HEALTH_DEFS) registry.register(def);
  for (const def of POWERUP_DEFS) registry.register(def);

  console.log(`[EntityDefs] Registered ${registry.getCount()} definitions`);
}
