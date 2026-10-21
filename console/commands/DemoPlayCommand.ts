/**
 * DemoPlayCommand — Playback control for loaded demos
 *
 * Usage:
 *   demoplay                    — normal playback
 *   demoplay cinematic <min>    — highlight reel for <min> minutes (at most 3)
 *   demoplay analyze            — print highlight analysis to console
 *   demoplay hud <mode>         — show, hide, or toggle demo overlays
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

const MAX_REEL_MINUTES = 3;

export default class DemoPlayCommand extends Command {
  readonly definition: CommandDef = {
    name: "demoplay",
    description: "Control demo playback (normal, cinematic, HUD, analyze, stop)",
    usage: "demoplay [cinematic <minutes> | hud <on|off|toggle> | analyze | stop]",
  };

  async execute(args: string[]): Promise<string> {
    const service = DemoService.getInstance();
    const subcommand = args[0]?.toLowerCase();

    // ── demoplay hud <on|off|toggle> ──────────────────────────────
    if (subcommand === "hud") {
      if (!service.hasActivePlayback()) {
        return "No demo playback is active.";
      }
      const action = args[1]?.toLowerCase();
      let visible: boolean;
      if (action === "on") visible = service.setDemoOverlayVisible(true);
      else if (action === "off") visible = service.setDemoOverlayVisible(false);
      else if (action === "toggle") visible = service.toggleDemoOverlay();
      else return "Usage: demoplay hud <on|off|toggle>";
      return `Demo HUD ${visible ? "on" : "off"}.`;
    }

    // ── demoplay stop ─────────────────────────────────────────────
    if (subcommand === "stop") {
      // Guard like `hud` does: stopAll() tears down shared live infrastructure
      // (WeaponViewManager view, spectator target provider) — invoking it with
      // no demo running would destroy a LIVE session's viewmodel/chase-cam.
      if (!service.hasActivePlayback()) {
        service.cancelPendingLoad();
        return "No demo playback is active.";
      }
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
      const asked = parseFloat(minutesArg ?? "");
      if (Number.isNaN(asked) || asked <= 0) {
        return "Usage: demoplay cinematic <minutes>\nExample: demoplay cinematic 2";
      }
      // A highlight reel is a short video: longer stops being highlights
      const minutes = Math.min(asked, MAX_REEL_MINUTES);

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

    return `Unknown subcommand '${args[0]}'. Usage: demoplay [cinematic <minutes> | hud <on|off|toggle> | analyze | stop]`;
  }

  override getCompletions(_input: string, args: string[]): string[] {
    if (args[0]?.toLowerCase() === "hud") {
      return ["on", "off", "toggle"];
    }
    if (args.length <= 1) {
      return ["cinematic", "hud", "analyze", "stop"];
    }
    return [];
  }
}
