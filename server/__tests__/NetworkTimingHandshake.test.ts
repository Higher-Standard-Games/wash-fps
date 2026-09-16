import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { NetworkGameHost } from "../../../../engine/network/client/hosts/NetworkGameHost";
import { WebSocketTransport } from "../../../../engine/network/client/transport/WebSocketTransport";
import { Simulation } from "../../../../engine/network/core/Simulation";
import { GameState } from "../../../../shared/net/GameState";
import { GameServer } from "../GameServer";
import { Deathmatch } from "../gametypes/Deathmatch";

vi.mock("../../../../engine/AudioManager", () => ({
  AudioManager: { getInstance: () => ({ loadPlaylist: () => {} }) },
}));

class EmptySimulation extends Simulation {
  protected createInitialState(): GameState {
    return new GameState();
  }
  protected registerSystems(): void {}
  protected registerCommandHandlers(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FPS timing contract over a real WebSocket", () => {
  it.each([60, 125, 250])("accepts only 125Hz from a real %iHz GameServer", async (tickRate) => {
    vi.stubGlobal("WebSocket", WebSocket);
    const server = new GameServer(
      {
        port: 0,
        serverName: "timing",
        mapName: "test",
        maxClients: 8,
        tickRate,
        snapshotRate: tickRate === 60 ? 30 : tickRate / 5,
        certPath: "",
        keyPath: "",
      },
      new Deathmatch(),
    );
    const transport = new WebSocketTransport();
    const host = new NetworkGameHost(
      transport,
      { tickRate: 125, tickDuration: 8, maxPlayers: 8, gameRules: {} },
      EmptySimulation,
    );
    host.setExternalPrediction(true);
    const mapLoad = vi.fn();
    const publish = vi.fn();
    host.onServerInfo(mapLoad);
    host.onStateUpdate(publish);
    try {
      await server.start();
      const connecting = host.connect(`ws://127.0.0.1:${server.getPort()}`, "timing-tester");
      if (tickRate === 125) {
        await connecting;
        expect(host.isConnected()).toBe(true);
        expect(mapLoad).toHaveBeenCalledOnce();
        expect(host.getServerInfo()?.tickRate).toBe(125);
        const deadline = Date.now() + 2000;
        while (publish.mock.calls.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(publish).toHaveBeenCalled();
      } else {
        await expect(connecting).rejects.toThrow(`Unsupported server tick rate: ${tickRate}Hz`);
        expect(host.isConnected()).toBe(false);
        expect(mapLoad).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(transport.isConnected()).toBe(false);
      }
    } finally {
      await host.disconnect();
      await server.stop();
    }
  });
});
