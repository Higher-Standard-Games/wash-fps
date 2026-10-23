/**
 * FPS Game - Entry Point
 *
 * This is the main entry point for the FPS game.
 * It exports the game manager and shared types/utilities.
 */

export { fpsFreeflyInput } from "./client/FPSActions";
export { fpsMapLauncher } from "./client/FpsMapLauncher";
export { fpsNetworkConnector } from "./client/FpsNetworkConnector";
export { registerFpsCommands } from "./console";
export { registerFpsEditorCatalog } from "./editor/FpsEditorCatalog";
export { Game } from "./Game";
export { canonicalWeaponId } from "./shared/entities/definitions/weapons/WeaponsTable";
export { fpsMapEntities } from "./world/FpsMapEntities";
