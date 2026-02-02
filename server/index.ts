/**
 * @module @games/fps/server
 * 
 * FPS Game Server
 * 
 * FPS-specific server code including:
 * - Gametypes (Deathmatch, CTF, Race, etc.)
 * - Systems (Physics, Combat, Weapons)
 * - Weapon definitions
 */
export { FPSServerGame } from './FPSServerGame';
export * from './gametypes';
export * from './systems';
export * from './weapons';
