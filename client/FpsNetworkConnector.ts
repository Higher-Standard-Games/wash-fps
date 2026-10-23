/**
 * FpsNetworkConnector — bridges the engine's `NetworkConnector` lobby
 * interface to the FPS `Game` singleton.
 *
 * The engine's `ConnectingOverlay` and `join` command call the registered
 * `NetworkConnector` to connect or request participation without knowing
 * anything about the FPS module. This file is the FPS-side
 * implementation; `src/main.ts` registers it at boot after the engine
 * commands and fps commands are wired up.
 */

import type { NetworkConnectOptions, NetworkConnector } from "../../../engine/ui/components/NetworkConnector";
import { Game } from "../Game";

export const fpsNetworkConnector: NetworkConnector = {
  isConnected(): boolean {
    return Game.getInstance().isConnectedToServer();
  },

  async connect(serverUrl: string, options: NetworkConnectOptions = {}): Promise<void> {
    await Game.getInstance().initializeNetwork(serverUrl, {
      autoJoin: options.autoJoin,
      watchOnly: options.watchOnly,
      admissionTicket: options.admissionTicket,
      requestSeat: options.requestSeat,
    });
  },

  async join(): Promise<void> {
    await Game.getInstance().joinGame();
  },

  claimSeat(serverUrl: string, admissionTicket: string): boolean {
    return Game.getInstance().claimSeat(serverUrl, admissionTicket);
  },
};
