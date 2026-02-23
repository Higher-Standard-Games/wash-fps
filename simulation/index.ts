/**
 * FPS Game Simulation
 *
 * Server-side simulation for FPS game mode.
 */

export { FPSSimulation, type FPSInputCommand } from './FPSSimulation';

// Movement profile — game-agnostic names with backward-compat aliases
export { MovementProfile, MovementProfile as FPSMovementProfile } from './MovementProfile';
export { type MovementConfig, type MovementConfig as FPSMovementConfig, type AdvancedMovementResult } from './MovementConfig';
