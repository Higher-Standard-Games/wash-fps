// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { Game } from "../../Game";
import { MatchPhase, MatchStateManager } from "../MatchStateManager";

/**
 * The slice of Game's internals the teammate-spectate camera touches.
 *
 * `updateTeammateSpectate` is private and reads only these fields, so the test
 * stands an instance on the prototype rather than booting an engine.
 */
interface SpectatingGame {
  _isPlayerDead: boolean;
  _spectatingEntityId: string | null;
  _deathCamera: { stop: () => void };
  updateTeammateSpectate(match: MatchStateManager): void;
}

function spectatingGame(stop: () => void): SpectatingGame {
  const game = Object.create(Game.prototype) as SpectatingGame;
  game._isPlayerDead = true;
  // Already following a teammate, as it would be after dying in a live round.
  game._spectatingEntityId = "player_2";
  game._deathCamera = { stop };
  return game;
}

function matchIn(phase: MatchPhase, round: number): MatchStateManager {
  MatchStateManager.destroy();
  const match = MatchStateManager.getInstance();
  match.processEvent({ type: "match_state", phase, round, gametypeName: "Search & Destroy" });
  return match;
}

describe("teammate spectate camera release", () => {
  it("releases the camera when the player is revived for the next round", () => {
    const stop = vi.fn();
    const game = spectatingGame(stop);

    // The round ends while the player is still dead. This drops the follow
    // target but must NOT be treated as the release — they are not alive yet.
    game.updateTeammateSpectate(matchIn(MatchPhase.Countdown, 1));
    expect(game._spectatingEntityId).toBeNull();
    expect(stop).not.toHaveBeenCalled();

    // The freeze revives them. The camera has to come back now, even though the
    // follow target was cleared on an earlier frame.
    game._isPlayerDead = false;
    game.updateTeammateSpectate(matchIn(MatchPhase.Countdown, 2));
    expect(stop).toHaveBeenCalled();
  });

  it("keeps following while dead in a live round", () => {
    const stop = vi.fn();
    const game = spectatingGame(stop);

    game.updateTeammateSpectate(matchIn(MatchPhase.Active, 1));

    expect(game._spectatingEntityId).toBe("player_2");
    expect(stop).not.toHaveBeenCalled();
  });
});
