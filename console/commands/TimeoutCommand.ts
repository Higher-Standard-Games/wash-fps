import { Command } from "../../../../engine/console/Command";
import { Game } from "../../Game";

export default class TimeoutCommand extends Command {
  readonly definition = {
    name: "timeout",
    description: "Pause the match: one timeout per player, up to two minutes (Duel, Amphi, S&D)",
    usage: "timeout",
  };

  async execute(): Promise<string> {
    const game = Game.getInstance();
    if (!game.isConnectedToServer()) return "Not connected to a game server";
    game.callPause(true);
    return "Timeout called.";
  }
}
