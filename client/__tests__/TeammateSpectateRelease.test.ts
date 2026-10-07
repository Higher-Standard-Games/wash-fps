// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { MatchPhase, MatchStateManager } from "../MatchStateManager";
import { SpectateView } from "../SpectateView";

/**
 * The slice of SpectateView's internals the teammate-spectate camera touches.
 *
 * `updateTeammateSpectate` is private, so the test reaches it through a cast
 * and drives the player's state through a fake host rather than booting an engine.
 */
interface SpectatingGame {
  _isPlayerDead: boolean;
  _spectatingEntityId: string | null;
  _deathCamera: { stop: () => void };
  _eyeCamera: { stop: () => void; isActive: boolean };
  updateTeammateSpectate(match: MatchStateManager): void;
}

interface Spies {
  stop: ReturnType<typeof vi.fn>;
  eyeStop: ReturnType<typeof vi.fn>;
  setHidden: ReturnType<typeof vi.fn>;
}

function spectatingGame(): { game: SpectatingGame; spies: Spies } {
  const spies: Spies = { stop: vi.fn(), eyeStop: vi.fn(), setHidden: vi.fn() };
  const remoteRenderer = {
    setHiddenEntity: spies.setHidden,
    // Still alive and still rendered, so the "already following someone" gate
    // holds and nothing re-picks underneath the test.
    getRenderedPlayers: () => new Map([["player_2", { dead: false }]]),
  };
  const spectatorOverlay = { setMode: vi.fn() };
  const state = { _isPlayerDead: true };
  const view = new SpectateView({
    isPlayerDead: () => state._isPlayerDead,
    playerState: () => "playing",
    localPlayerId: () => "player_1",
    latestGameState: () => null,
    remoteRenderer: () => remoteRenderer as never,
    spectatorOverlay: () => spectatorOverlay as never,
    spectatorCycling: () => null,
    spectatorController: () => null,
  });
  const game = Object.assign(view as unknown as SpectatingGame, {
    _deathCamera: { stop: spies.stop },
    _eyeCamera: { stop: spies.eyeStop, isActive: true },
  });
  // Already following a teammate, as it would be after dying in a live round.
  game._spectatingEntityId = "player_2";
  // The player's own state stays on Game; the test flips it through the host.
  Object.defineProperty(game, "_isPlayerDead", {
    get: () => state._isPlayerDead,
    set: (v: boolean) => {
      state._isPlayerDead = v;
    },
  });
  return { game: game as unknown as SpectatingGame, spies };
}

function matchIn(phase: MatchPhase, round: number): MatchStateManager {
  MatchStateManager.destroy();
  const match = MatchStateManager.getInstance();
  match.processEvent({ type: "match_state", phase, round, gametypeName: "Search & Destroy" });
  return match;
}

describe("teammate spectate camera release", () => {
  it("releases the camera when the player is revived for the next round", () => {
    const { game, spies } = spectatingGame();

    // The round ends while the player is still dead. This drops the follow
    // target but must NOT be treated as the release — they are not alive yet.
    game.updateTeammateSpectate(matchIn(MatchPhase.Countdown, 1));
    expect(game._spectatingEntityId).toBeNull();
    expect(spies.stop).not.toHaveBeenCalled();

    // The freeze revives them. The camera has to come back now, even though the
    // follow target was cleared on an earlier frame.
    game._isPlayerDead = false;
    game.updateTeammateSpectate(matchIn(MatchPhase.Countdown, 2));
    expect(spies.stop).toHaveBeenCalled();
  });

  it("keeps following while dead in a live round", () => {
    const { game, spies } = spectatingGame();

    game.updateTeammateSpectate(matchIn(MatchPhase.Active, 1));

    expect(game._spectatingEntityId).toBe("player_2");
    expect(spies.eyeStop).not.toHaveBeenCalled();
  });

  it("makes the watched player visible again when it stops watching them", () => {
    const { game, spies } = spectatingGame();

    // Their model is hidden for as long as the camera is inside their head.
    // Leaving it hidden after the handover means one player is invisible to
    // the spectator for the rest of the match — and only to them.
    game.updateTeammateSpectate(matchIn(MatchPhase.Countdown, 1));

    expect(spies.eyeStop).toHaveBeenCalled();
    expect(spies.setHidden).toHaveBeenCalledWith(null);
  });

  it("releases only once, however many frames run after it", () => {
    const { game, spies } = spectatingGame();

    game.updateTeammateSpectate(matchIn(MatchPhase.Countdown, 1));
    game.updateTeammateSpectate(matchIn(MatchPhase.Countdown, 1));
    game.updateTeammateSpectate(matchIn(MatchPhase.Countdown, 1));

    // Un-hiding every frame would fight the demo viewer for the renderer's one
    // hidden slot, so the release is edge-triggered on the target going away.
    expect(spies.setHidden).toHaveBeenCalledTimes(1);
  });
});
