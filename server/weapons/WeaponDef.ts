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
    GUNBLADE,
    MACHINEGUN,
    RIOTGUN,
    GRENADE_LAUNCHER,
    ROCKET_LAUNCHER,
    PLASMAGUN,
    VOLTAIC,
    LASERGUN,
    ELECTROBOLT,
    INSTAGUN,
    BLADE,
} from '../../../../shared/entities/definitions/weapons';
import type { WeaponDef, CrosshairConfig } from '../../../../shared/entities/WeaponDef';

// Re-export types for consumers
export type { WeaponDef, CrosshairConfig };

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
    // Alias: ProjectileSystem looks up WEAPONS[defId] and blade_blast is the projectile defId
    // KB force = damage × knockbackScale. RL: 100×10=1000. Blade blast max: 50×20=1000 (RL-equal)
    'blade_blast': { ...BLADE, knockbackScale: 20.0 },
};
