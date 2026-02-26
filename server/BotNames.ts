/**
 * Bot Names — themed bot names for the FPS game
 * 
 * Washiki/Washoi culture, Warsow/arena-shooter nods, SHAG engine jokes,
 * and Quake 3 legends.
 */

const BOT_NAMES: string[] = [
    // Washoi culture
    'Washoi', 'Udon', 'Soba', 'Tempura', 'Mochi',
    'Wasabi', 'Tofu', 'Ramen', 'Sashimi', 'Onigiri',
    // Arena shooter legends
    'Sarge', 'Keel', 'Anarki', 'Slash', 'Orbb',
    'Xaero', 'Bones', 'Crash', 'Mynx', 'Major',
    // Warsow nods
    'Padpork', 'Monada', 'Viciious', 'Stermy', 'Maxter',
    // SHAG engine
    'ShagBot', 'FragMaster', 'RailGod', 'BunnyHop', 'StrafJmp',
    'RocketScience', 'PlasmaStorm', 'InstaKill', 'DodgeMaster', 'WallRunner',
    // More arena
    'CampKiller', 'SpawnFrag', 'QuadDamage', 'HolyShit', 'Humiliation',
];

/**
 * Get next available bot name, avoiding duplicates within the current match.
 * Cycles through the list; if all names are used, appends a number.
 */
export function getNextBotName(usedNames: Set<string>): string {
    // Try to find an unused name
    for (const name of BOT_NAMES) {
        if (!usedNames.has(name)) {
            return name;
        }
    }

    // All names used — append number to a random name
    let counter = 2;
    while (true) {
        const base = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
        const candidate = `${base}${counter}`;
        if (!usedNames.has(candidate)) {
            return candidate;
        }
        counter++;
    }
}
