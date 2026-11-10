import { Command } from "../../../../engine/console/Command";
import { Game } from "../../Game";

export default class TimeinCommand extends Command {
  readonly definition = {
    name: "timein",
    description: "End a timeout: play resumes after a three-second count",
    usage: "timein",
  };

  async execute(): Promise<string> {
    const game = Game.getInstance();
    if (!game.isConnectedToServer()) return "Not connected to a game server";
    game.callPause(false);
    return "Time in called.";
  }
}
