import { PlayerProfile } from "../../../engine/player/PlayerProfile";
import { LobbyClient } from "../../../lobby/LobbyClient";
import { DemoService } from "./DemoService";

const DEFAULT_LOBBY_URL = import.meta.env.VITE_LOBBY_URL || "ws://localhost:9000";

let sharedClient: LobbyClient | null = null;
let connectPromise: Promise<LobbyClient> | null = null;
let authenticated = false;

export function getFpsLobbyClient(): LobbyClient {
  if (!sharedClient) {
    sharedClient = new LobbyClient();
    sharedClient.on("_disconnected", () => {
      authenticated = false;
    });
    DemoService.getInstance().setLobbyClient(sharedClient);
  }
  return sharedClient;
}

export async function ensureFpsLobbyConnection(url: string = DEFAULT_LOBBY_URL): Promise<LobbyClient> {
  const client = getFpsLobbyClient();
  if (client.connected && authenticated) {
    return client;
  }

  if (!connectPromise) {
    connectPromise = (async () => {
      if (!client.connected) {
        await client.connect(url);
      }

      if (!authenticated) {
        const profile = PlayerProfile.load();
        client.auth(profile.name);
        authenticated = true;
      }

      return client;
    })().finally(() => {
      connectPromise = null;
    });
  }

  return connectPromise;
}

export function resetFpsLobbyConnectionForTests(): void {
  sharedClient?.disconnect();
  sharedClient = null;
  connectPromise = null;
  authenticated = false;
}
