import { LoginError, logIn, restoreAccount } from "../../../lobby/AccountSession";
import { LobbyClient } from "../../../lobby/LobbyClient";
import { normalizeKey } from "../../../lobby/PlayerIdentity";
import type { WelcomeMessage } from "../../../lobby/types";
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
        // Every player has an account: the stored key opens it, or the lobby makes one
        await logIn(client);
        authenticated = true;
      }

      return client;
    })().finally(() => {
      connectPromise = null;
    });
  }

  return connectPromise;
}

/**
 * Switch this browser to the account a pasted key opens. A connection logs in
 * once, so this reconnects. If the lobby refuses the key (LoginError, usually
 * "unknown_key"), this logs back in with the key already stored, then rejects.
 */
export async function switchFpsAccount(pastedKey: string, url: string = DEFAULT_LOBBY_URL): Promise<WelcomeMessage> {
  if (!normalizeKey(pastedKey)) throw new LoginError("unknown_key");
  const client = getFpsLobbyClient();
  // Let a login already under way finish, so it can't answer for the new connection
  await connectPromise?.catch(() => undefined);

  console.log("[FpsLobbyService] Switching account: reconnecting to", url);
  client.disconnect();
  await client.connect(url);
  try {
    const welcome = await restoreAccount(client, pastedKey);
    authenticated = true;
    return welcome;
  } catch (err) {
    if (err instanceof LoginError && client.connected) {
      try {
        await logIn(client);
        authenticated = true;
      } catch (loginErr) {
        console.warn("[FpsLobbyService] Could not log back in after a refused key:", loginErr);
      }
    }
    throw err;
  }
}

export function resetFpsLobbyConnectionForTests(): void {
  sharedClient?.disconnect();
  sharedClient = null;
  connectPromise = null;
  authenticated = false;
}
