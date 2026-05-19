import { Command } from "../../../../engine/console/Command";
import { Game } from "../../Game";

/**
 * Connect command - connects to a multiplayer game server
 * Usage: connect <server_url>
 *
 * Examples:
 *   connect localhost:7777
 *   connect ws://192.168.1.100:7777
 */
export default class ConnectCommand extends Command {
  readonly definition = {
    name: "connect",
    description: "Connect to a game server",
    usage: "connect <server_url>",
  };

  async execute(args: string[]): Promise<string> {
    const serverUrl = args[0];

    if (!serverUrl) {
      return "Usage: connect <server_url>\nExample: connect localhost:7777\nExample: connect ws://192.168.1.100:7777";
    }

    // Add ws:// prefix if not present
    let url = serverUrl;
    if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
      url = `ws://${url}`;
    }

    try {
      const gameManager = Game.getInstance();

      // Check if already connected
      if (gameManager.isConnectedToServer()) {
        const currentUrl = gameManager.getServerUrl();
        return `Already connected to ${currentUrl}. Use 'disconnect' first.`;
      }

      await gameManager.initializeNetwork(url);
      // Note: FPS controller setup is now done in Game.onServerInfo callback
      // AFTER the map loads, to prevent race conditions with scene setup
      return `Connecting to ${url}... Map will load shortly.`;
    } catch (error) {
      return `Failed to connect: ${error}`;
    }
  }
}
