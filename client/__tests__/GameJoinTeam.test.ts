// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { Game } from "../../Game";
import { MatchPhase, MatchStateManager } from "../MatchStateManager";

/**
 * The slice of Game's internals this test drives.
 *
 * `joinGame` reads connection state that a real boot would have built, so the
 * test stands an instance on the prototype and sets only those fields rather
 * than constructing an engine.
 */
interface JoinableGame {
  playerState: string;
  isNetworkMode: boolean;
  gameHost: { sendJoinGame: (team?: string) => void };
  _joinPending: boolean;
  _joinGametypeWaits: number;
  _preferredTeam: string | undefined;
  _joinPendingTimeout?: ReturnType<typeof setTimeout>;
  joinGame(teamId?: string): Promise<void>;
}

function joinableGame(sendJoinGame: (team?: string) => void): JoinableGame {
  MatchStateManager.getInstance().processEvent({
    type: "match_state",
    phase: MatchPhase.Warmup,
    gametypeName: "Deathmatch",
  });
  const game = Object.create(Game.prototype) as JoinableGame;
  game.playerState = "spectator";
  game.isNetworkMode = true;
  game.gameHost = { sendJoinGame };
  game._joinPending = false;
  game._joinGametypeWaits = 0;
  game._preferredTeam = "udon";
  return game;
}

afterEach(() => MatchStateManager.destroy());

describe("Game team selection", () => {
  it("sends the explicit team button choice instead of the old lobby preference", async () => {
    const sendJoinGame = vi.fn();
    const game = joinableGame(sendJoinGame);

    await game.joinGame("soba");

    expect(sendJoinGame).toHaveBeenCalledWith("soba");
    clearTimeout(game._joinPendingTimeout);
  });

  it("keeps the connection-local preference for a keyboard rejoin", async () => {
    const sendJoinGame = vi.fn();
    const game = joinableGame(sendJoinGame);

    await game.joinGame();

    expect(sendJoinGame).toHaveBeenCalledWith("udon");
    clearTimeout(game._joinPendingTimeout);
  });
});
