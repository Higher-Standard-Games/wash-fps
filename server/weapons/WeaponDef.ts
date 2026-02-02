/**
 * Weapon Definition Interface
 */

export interface WeaponDef {
    /** Weapon ID */
    id: string;

    /** Display name */
    name: string;

    /** Weapon type */
    type: 'hitscan' | 'projectile';

    /** Base damage */
    damage: number;

    /** Fire rate (shots per second) */
    fireRate: number;

    /** Ammo capacity */
    ammoCapacity: number;

    /** Reload time in seconds */
    reloadTime: number;

    /** For hitscan: max range */
    maxRange?: number;

    /** For projectile: speed in units/sec */
    projectileSpeed?: number;

    /** Whether to use lag compensation */
    useLagCompensation: boolean;
}

// Example weapon definitions
export const WEAPONS: Record<string, WeaponDef> = {
    machinegun: {
        id: 'machinegun',
        name: 'Machine Gun',
        type: 'hitscan',
        damage: 7,
        fireRate: 10,
        ammoCapacity: 100,
        reloadTime: 2,
        maxRange: 5000,
        useLagCompensation: true,
    },
    shotgun: {
        id: 'shotgun',
        name: 'Shotgun',
        type: 'hitscan',
        damage: 10, // per pellet
        fireRate: 1,
        ammoCapacity: 12,
        reloadTime: 1.5,
        maxRange: 800,
        useLagCompensation: true,
    },
    rocketLauncher: {
        id: 'rocketLauncher',
        name: 'Rocket Launcher',
        type: 'projectile',
        damage: 100,
        fireRate: 0.8,
        ammoCapacity: 25,
        reloadTime: 2.5,
        projectileSpeed: 1000,
        useLagCompensation: false, // Projectiles don't use lag comp
    },
    railgun: {
        id: 'railgun',
        name: 'Railgun',
        type: 'hitscan',
        damage: 80,
        fireRate: 0.67, // 1.5s between shots
        ammoCapacity: 10,
        reloadTime: 3,
        maxRange: 10000,
        useLagCompensation: true,
    },
    plasmagun: {
        id: 'plasmagun',
        name: 'Plasma Gun',
        type: 'projectile',
        damage: 20,
        fireRate: 10, // 10 shots per second
        ammoCapacity: 50,
        reloadTime: 2,
        projectileSpeed: 2000, // Fast plasma bolts
        useLagCompensation: false,
    },
};
