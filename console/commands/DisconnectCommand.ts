import { Command } from "../../../../engine/console/Command";
import { Game } from "../../Game";

/**
 * Disconnect command - leaves the current game server and returns to the lobby
 * Usage: disconnect
 */
export default class DisconnectCommand extends Command {
  readonly definition = {
    name: "disconnect",
    description: "Disconnect from current game server",
    usage: "disconnect",
  };

  async execute(_args: string[]): Promise<string> {
    try {
      const gameManager = Game.getInstance();
      const serverUrl = gameManager.getServerUrl();

      if (!gameManager.isConnectedToServer()) {
        return "Not connected to any server";
      }

      gameManager.shutdown();
      // Same as the menu's Leave match: reload into the lobby. Shutting down
      // alone left the last frame frozen on screen with sound still playing.
      if (typeof window !== "undefined") window.location.reload();
      return `Disconnected from ${serverUrl}`;
    } catch (error) {
      return `Failed to disconnect: ${error}`;
    }
  }
}
