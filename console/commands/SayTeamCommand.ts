import { Command } from "../../../../engine/console/Command";
import { Game } from "../../Game";

export default class SayTeamCommand extends Command {
  readonly definition = {
    name: "say_team",
    description: "Send a message to your teammates",
    usage: "say_team <message>",
  };

  async execute(args: string[]): Promise<string> {
    const text = args.join(" ").trim();
    if (!text) return "Usage: say_team <message>";
    const game = Game.getInstance();
    if (!game.isConnectedToServer()) return "Not connected to a game server";
    game.sendChat(text, true);
    return "Team message submitted.";
  }
}
