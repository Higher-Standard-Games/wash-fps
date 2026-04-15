/**
 * FPS Game Simulation
 *
 * Server-side simulation for FPS game mode.
 */

export { type FPSInputCommand, FPSSimulation } from "./FPSSimulation";
export type { AdvancedMovementResult, MovementConfig, MovementConfig as FPSMovementConfig } from "./MovementConfig";
// Movement profile — game-agnostic names with backward-compat aliases
export { MovementProfile, MovementProfile as FPSMovementProfile } from "./MovementProfile";
