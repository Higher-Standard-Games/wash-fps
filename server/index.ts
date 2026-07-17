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

export { WEAPONS } from "../../../shared/entities/definitions/weapons/WeaponsTable";
// Weapon defs/table live in shared (QA-14); re-export for existing consumers.
export type { WeaponDef } from "../../../shared/entities/WeaponDef";
export { FPSServerGame } from "./FPSServerGame";
export * from "./gametypes";
export * from "./systems";
