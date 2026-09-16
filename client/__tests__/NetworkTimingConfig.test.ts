// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { TransportFactory } from "../../../../engine/network/client/transport/Transport";
import { Game, type PlayerInputState } from "../../Game";

afterEach(() => vi.restoreAllMocks());

it.each([
  0,
  60,
  250,
  Number.NaN,
])("rejects FPS network config %sHz before transport or game setup", async (tickRate) => {
  const create = vi.spyOn(TransportFactory, "create");
  const game = Object.create(Game.prototype) as Game;
  const shutdown = vi.spyOn(game, "shutdown");
  await expect(game.initializeNetwork("ws://test", { tickRate })).rejects.toThrow("Unsupported FPS network tick rate");
  expect(create).not.toHaveBeenCalled();
  expect(shutdown).not.toHaveBeenCalled();
});

it("does not predict inputs while the timing handshake is unconfirmed", () => {
  const processInput = vi.fn();
  const sendCommand = vi.fn();
  const game = Object.assign(Object.create(Game.prototype), {
    isRunning: true,
    isNetworkMode: true,
    playerState: "playing",
    gameHost: { isConnected: () => false, sendCommand },
    v2Client: { processInput },
  }) as Game;
  game.sendInput({ forward: true } as PlayerInputState);
  expect(processInput).not.toHaveBeenCalled();
  expect(sendCommand).not.toHaveBeenCalled();
});

it("accepts default config and cleans up if connecting fails", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const create = vi.spyOn(TransportFactory, "create").mockRejectedValue(new Error("open failed"));
  const shutdown = vi.fn();
  const game = Object.assign(Object.create(Game.prototype), {
    resetServerProjectiles: vi.fn(),
    shutdown,
    v2Client: {},
  });
  await expect(game.initializeNetwork("ws://test")).rejects.toThrow("open failed");
  expect(create).toHaveBeenCalledWith("ws://test");
  expect(shutdown).toHaveBeenCalledOnce();
  expect(game.v2Client).toBeNull();
});
