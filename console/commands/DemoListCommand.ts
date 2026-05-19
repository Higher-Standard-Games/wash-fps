/**
 * DemoListCommand — List available demos from the lobby server
 *
 * Usage:
 *   demolist              — list all recent demos
 *   demolist aerowalk     — filter by map name
 *   demolist player1      — filter by player name
 */

import { Command, type CommandDef } from "../../../../engine/console/Command";
import { DemoService } from "../../client/DemoService";

export default class DemoListCommand extends Command {
  readonly definition: CommandDef = {
    name: "demolist",
    description: "List available demos from the lobby server",
    usage: "demolist [filter]",
  };

  async execute(args: string[]): Promise<string> {
    const filter = args[0];
    const service = DemoService.getInstance();

    let demos;
    try {
      demos = await service.requestDemoList(filter);
    } catch (err) {
      return `demolist: ${err instanceof Error ? err.message : String(err)}`;
    }

    return DemoService.formatDemoTable(demos);
  }

  getCompletions(_input: string, _args: string[]): string[] {
    // Offer cached map/player names as completions
    const service = DemoService.getInstance();
    const maps = [...new Set(service.cachedDemoList.map((d) => d.map))];
    const players = [...new Set(service.cachedDemoList.flatMap((d) => d.players))];
    return [...maps, ...players];
  }
}
