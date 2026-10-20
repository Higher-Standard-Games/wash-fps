/**
 * FPS Game Commands - Auto-discovery loader
 *
 * Mirror of the engine's command auto-discovery (src/engine/console/commands/index.ts)
 * scoped to the fps submodule. The host application calls `registerFpsCommands()`
 * after `registerEngineCommands()` so fps-specific commands (connect, disconnect,
 * demo*, netsim) join the shared `CommandRegistry`.
 *
 * To add a new fps-specific command:
 *   1. Create FooCommand.ts in this directory's commands/ subdir
 *   2. Export default class extending the engine Command
 *   3. It will be auto-registered on startup
 */

import type { Command } from "../../../engine/console/Command";
import { CommandRegistry } from "../../../engine/console/CommandRegistry";
import { devLog } from "../../../engine/core/DevLog";

/**
 * Register all fps-specific commands.
 *
 * Must be called after `registerEngineCommands()` from the engine — the engine
 * registers cross-game commands (map, audio, scene, etc.) and the fps module
 * adds its own (connect, disconnect, demo*, netsim) into the same registry.
 */
export async function registerFpsCommands(): Promise<void> {
  const registry = CommandRegistry.getInstance();

  // Vite glob import — discovers all *Command.ts files in commands/.
  // Eager so registration is deterministic at boot.
  const modules = import.meta.glob<{ default: new () => Command }>("./commands/*Command.ts", { eager: true });

  let count = 0;
  for (const [path, module] of Object.entries(modules)) {
    if (module.default) {
      try {
        const command = new module.default();
        registry.register(command);
        count++;
      } catch (error) {
        console.error(`[FPS Console] Failed to register command from ${path}:`, error);
      }
    }
  }

  devLog(`[FPS Console] Registered ${count} fps commands`);
}
