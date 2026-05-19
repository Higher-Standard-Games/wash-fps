/**
 * DemoCommand — Load a demo by list number or filename
 *
 * Usage:
 *   demo 1                                    — load #1 from last demolist
 *   demo aerowalk_duel_20260319.shagdemo      — load by filename
 */

import { Command, type CommandDef } from "../../../../engine/console/Command";
import { DemoService } from "../../client/DemoService";

export default class DemoCommand extends Command {
  readonly definition: CommandDef = {
    name: "demo",
    description: "Load a demo by number (from demolist) or filename",
    usage: "demo <number|filename>",
  };

  async execute(args: string[]): Promise<string> {
    const arg = args[0];
    if (!arg) {
      return "Usage: demo <number|filename>\nUse 'demolist' to see available demos.";
    }

    const service = DemoService.getInstance();

    // Numeric → look up in cached demolist
    const num = parseInt(arg, 10);
    let filename: string;

    if (!isNaN(num)) {
      const entry = service.cachedDemoList[num - 1];
      if (!entry) {
        const count = service.cachedDemoList.length;
        if (count === 0) {
          return `No cached demo list. Run 'demolist' first.`;
        }
        return `Demo #${num} not found. List has ${count} demos (#1–#${count}).`;
      }
      filename = entry.filename;
    } else {
      filename = arg;
    }

    try {
      const summary = await service.fetchAndLoad(filename);
      return `${summary}\nUse 'demoplay' to start playback.`;
    } catch (err) {
      return `demo: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  getCompletions(_input: string, _args: string[]): string[] {
    const service = DemoService.getInstance();
    return service.cachedDemoList.map((_d, i) => String(i + 1));
  }
}
