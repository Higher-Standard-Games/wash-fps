/**
 * Weapon Definition Interface (Server-side gameplay)
 * 
 * All weapon stats from Warsow gs_weapondefs.c
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

    /** Number of pellets per shot (for shotguns) */
    pelletCount?: number;

    /** Spread angle (for hitscan with spread) */
    spread?: number;

    /** Splash radius */
    splashRadius?: number;

    /** Splash damage */
    splashDamage?: number;

    /** Knockback scale (multiplied by damage to get impulse force) */
    knockbackScale?: number;

    /** Ammo given on pickup (defaults to ammoCapacity if unset) */
    pickupAmmo?: number;
}

// Warsow weapon definitions — stats from gs_weapondefs.c
export const WEAPONS: Record<string, WeaponDef> = {
    gunblade: {
        id: 'gunblade',
        name: 'Gunblade',
        type: 'projectile',
        damage: 35,
        fireRate: 1.67,          // 600ms reload
        ammoCapacity: 1,
        reloadTime: 0.6,
        projectileSpeed: 3000,
        splashRadius: 80,
        splashDamage: 8,
        knockbackScale: 8.0,   // Strong melee KB
        useLagCompensation: false,
    },
    machinegun: {
        id: 'machinegun',
        name: 'Machinegun',
        type: 'hitscan',
        damage: 10,
        fireRate: 10,            // 100ms reload
        ammoCapacity: 100,
        reloadTime: 0.1,
        maxRange: 6000,
        spread: 10,
        knockbackScale: 2.0,   // Bullet pushback
        useLagCompensation: true,
    },
    riotgun: {
        id: 'riotgun',
        name: 'Riotgun',
        type: 'hitscan',
        damage: 5,               // per pellet
        fireRate: 1.11,          // 900ms reload
        ammoCapacity: 20,
        reloadTime: 0.9,
        maxRange: 8192,
        pelletCount: 20,
        spread: 160,
        knockbackScale: 2.5,   // Shotgun spread push
        useLagCompensation: true,
    },
    glauncher: {
        id: 'glauncher',
        name: 'Grenade Launcher',
        type: 'projectile',
        damage: 80,
        fireRate: 1.25,          // 800ms reload
        ammoCapacity: 20,
        reloadTime: 0.8,
        projectileSpeed: 1000,
        splashRadius: 125,
        splashDamage: 15,
        knockbackScale: 10.0,  // Grenade launcher — dramatic launches
        pickupAmmo: 10,
        useLagCompensation: false,
    },
    rlauncher: {
        id: 'rlauncher',
        name: 'Rocket Launcher',
        type: 'projectile',
        damage: 80,
        fireRate: 1.05,          // 950ms reload
        ammoCapacity: 20,
        reloadTime: 0.95,
        projectileSpeed: 1150,
        splashRadius: 125,
        splashDamage: 15,
        knockbackScale: 10.0,  // Rocket launcher — dramatic launches
        pickupAmmo: 10,
        useLagCompensation: false,
    },
    plasmagun: {
        id: 'plasmagun',
        name: 'Plasma Gun',
        type: 'projectile',
        damage: 15,
        fireRate: 10,            // 100ms reload
        ammoCapacity: 150,
        reloadTime: 0.1,
        projectileSpeed: 2500,
        splashRadius: 45,
        splashDamage: 5,
        knockbackScale: 4.5,   // Plasma push
        useLagCompensation: false,
    },
    lasergun: {
        id: 'lasergun',
        name: 'Lasergun',
        type: 'hitscan',
        damage: 7,
        fireRate: 20,            // 50ms reload (beam)
        ammoCapacity: 150,
        reloadTime: 0.05,
        maxRange: 850,
        knockbackScale: 1.5,   // Lasergun beam push
        useLagCompensation: true,
    },
    electrobolt: {
        id: 'electrobolt',
        name: 'Electrobolt',
        type: 'hitscan',
        damage: 75,
        fireRate: 0.8,           // 1250ms reload
        ammoCapacity: 10,
        reloadTime: 1.25,
        maxRange: 10000,
        knockbackScale: 3.5,   // Electrobolt sniper push
        pickupAmmo: 5,
        useLagCompensation: true,
    },
    instagun: {
        id: 'instagun',
        name: 'Instagun',
        type: 'hitscan',
        damage: 200,
        fireRate: 0.77,          // 1300ms reload
        ammoCapacity: 5,
        reloadTime: 1.3,
        maxRange: 8024,
        splashRadius: 80,
        knockbackScale: 12.0,  // Instagun — massive KB
        useLagCompensation: true,
    },
};
