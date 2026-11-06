/**
 * Select the local FPS/freefly camera without changing server match membership.
 *
 * Usage:
 *   spectator      - Toggle mode
 *   spectator 0    - FPS mode (gravity, physics, ground movement)
 *   spectator 1    - Spectator mode (freefly camera, fly anywhere)
 */

import { CameraSystem } from "../../../../engine/camera/CameraSystem";
import { FreeflyController } from "../../../../engine/camera/controllers/FreeflyController";
import { Command, type CommandDef, type CommandOutput, fail } from "../../../../engine/console/Command";
import { FPSController } from "../../camera/FPSController";

export default class SpectatorCommand extends Command {
  readonly definition: CommandDef = {
    name: "spectator",
    description: "Toggle the local FPS/freefly camera",
    usage: "spectator [0|1]",
  };

  async execute(args: string[]): Promise<CommandOutput> {
    if (args.length > 1 || (args.length === 1 && args[0] !== "0" && args[0] !== "1")) {
      return fail("Usage: spectator [0|1]");
    }

    const cameraSystem = CameraSystem.getInstance();
    const activeController = cameraSystem.getActiveController();
    const isSpectator = activeController?.type === "freefly";

    // Register FPS controller if not already registered
    if (!cameraSystem.getController("fps")) {
      cameraSystem.registerController("fps", new FPSController());
    }
    // Register freefly controller if not already registered
    if (!cameraSystem.getController("freefly")) {
      cameraSystem.registerController("freefly", new FreeflyController());
    }

    const target = args[0] === "0" || (args.length === 0 && isSpectator) ? "fps" : "freefly";
    if (!cameraSystem.setController(target)) {
      return fail(`Failed to switch to ${target} camera.`);
    }
    return target === "fps" ? "FPS mode (gravity, physics)" : "Spectator mode (freefly)";
  }

  override getCompletions(_input: string, _args: string[]): string[] {
    return ["0", "1"];
  }
}
