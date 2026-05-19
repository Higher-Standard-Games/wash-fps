/**
 * DemoPlayCommand — Playback control for loaded demos
 *
 * Usage:
 *   demoplay                    — normal playback
 *   demoplay cinematic <min>    — highlight reel for <min> minutes
 *   demoplay analyze            — print highlight analysis to console
 *   demoplay stop               — stop any active playback
 *
 * Requires a demo to be loaded via `demo <number|filename>` first.
 * For rendering to work, a frame callback must be registered with the
 * DemoViewer before calling this — typically done by the game setup code.
 */

import { CameraSystem } from "../../../../engine/camera/CameraSystem";
import { Command, type CommandDef } from "../../../../engine/console/Command";
import { DemoService } from "../../client/DemoService";
import { DemoViewer } from "../../client/DemoViewer";

export default class DemoPlayCommand extends Command {
  readonly definition: CommandDef = {
    name: "demoplay",
    description: "Control demo playback (normal, cinematic, analyze, stop)",
    usage: "demoplay [cinematic <minutes> | analyze | stop]",
  };

  async execute(args: string[]): Promise<string> {
    const service = DemoService.getInstance();
    const subcommand = args[0]?.toLowerCase();

    // ── demoplay stop ─────────────────────────────────────────────
    if (subcommand === "stop") {
      service.stopAll();
      return "Demo playback stopped.";
    }

    // ── demoplay analyze ──────────────────────────────────────────
    if (subcommand === "analyze") {
      try {
        return await service.analyzeLoadedDemo();
      } catch (err) {
        return `demoplay analyze: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // ── demoplay cinematic <minutes> ──────────────────────────────
    if (subcommand === "cinematic") {
      const minutesArg = args[1];
      const minutes = parseFloat(minutesArg ?? "");
      if (isNaN(minutes) || minutes <= 0) {
        return "Usage: demoplay cinematic <minutes>\nExample: demoplay cinematic 2";
      }

      try {
        const viewer = new DemoViewer();
        const cameraSystem = CameraSystem.getInstance();
        await service.loadAndPlayCinematic(viewer, cameraSystem, minutes);
        return `Playing cinematic highlight reel (${minutes} min)…`;
      } catch (err) {
        return `demoplay cinematic: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // ── demoplay (no args) — normal playback ──────────────────────
    if (!subcommand) {
      try {
        const viewer = new DemoViewer();
        await service.loadAndPlayNormal(viewer);
        return "Demo playback started. Use 'demoplay stop' to stop.";
      } catch (err) {
        return `demoplay: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return `Unknown subcommand '${args[0]}'. Usage: demoplay [cinematic <minutes> | analyze | stop]`;
  }

  getCompletions(_input: string, args: string[]): string[] {
    if (args.length <= 1) {
      return ["cinematic", "analyze", "stop"];
    }
    return [];
  }
}
