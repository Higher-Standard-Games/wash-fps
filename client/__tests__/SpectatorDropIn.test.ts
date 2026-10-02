// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { Game } from "../../Game";

/**
 * The slice of Game a watcher's Join touches. The test stands an instance on
 * the prototype rather than booting an engine; past the seat branch the real
 * joinGame needs a server, so the spy stops it there.
 */
interface WatchingGame {
  playerState: "spectator" | "playing";
  serverUrl: string | null;
  _seated: boolean;
  _seatTicket: string | null;
  _seatRequest: (() => Promise<void>) | null;
  _seatRequesting: boolean;
  _preferredTeam: string | undefined;
  _teamWasPicked: boolean;
  isConnectedToServer(): boolean;
  showNotice(text: string): void;
  joinGame(teamId?: string): Promise<void>;
  claimSeat(serverUrl: string, admissionTicket: string): boolean;
}

function watcher(request: () => Promise<void>): WatchingGame {
  const game = Object.create(Game.prototype) as WatchingGame;
  game.playerState = "spectator";
  game.serverUrl = "ws://localhost:7781";
  game._seated = false;
  game._seatTicket = null;
  game._seatRequest = request;
  game._seatRequesting = false;
  game._teamWasPicked = false;
  game.isConnectedToServer = () => true;
  game.showNotice = vi.fn();
  return game;
}

describe("a watcher pressing Join", () => {
  it("asks the lobby for a seat once, however often the key repeats", async () => {
    let answer: () => void = () => {};
    const request = vi.fn(() => new Promise<void>((resolve) => (answer = resolve)));
    const game = watcher(request);

    await game.joinGame();
    await game.joinGame();
    expect(request).toHaveBeenCalledTimes(1);

    answer();
    await vi.waitFor(() => expect(game._seatRequesting).toBe(false));
    await game.joinGame();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("says why when the lobby has no seat", async () => {
    const game = watcher(() => Promise.reject(new Error("This match is full.")));
    await game.joinGame();
    await vi.waitFor(() => expect(game.showNotice).toHaveBeenCalledWith("This match is full."));
  });

  it("takes the seat on the server it is watching, without reconnecting", () => {
    const game = watcher(vi.fn(() => Promise.resolve()));
    const join = vi.spyOn(game, "joinGame").mockResolvedValue();

    expect(game.claimSeat("ws://LOCALHOST:7781/", "ticket-1")).toBe(true);
    expect(game._seatTicket).toBe("ticket-1");
    expect(join).toHaveBeenCalledTimes(1);
  });

  it("leaves a seat on another server to a fresh connection", () => {
    const game = watcher(vi.fn(() => Promise.resolve()));
    const join = vi.spyOn(game, "joinGame").mockResolvedValue();

    expect(game.claimSeat("ws://localhost:7790", "ticket-1")).toBe(false);
    game.playerState = "playing";
    expect(game.claimSeat("ws://localhost:7781", "ticket-1")).toBe(false);
    expect(join).not.toHaveBeenCalled();
    expect(game._seatTicket).toBeNull();
  });
});
