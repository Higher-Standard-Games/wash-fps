// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioManager } from "../../../../engine/AudioManager";
import { getExplosionEffect } from "../../../../engine/weapon/ExplosionEffect";
import { getHitscanEffects } from "../../../../engine/weapon/HitscanEffects";
import { Game } from "../../Game";
import { isLocalPowerupActive, setLocalPowerup } from "../LocalPowerupState";
import { MatchPhase, MatchStateManager } from "../MatchStateManager";
import { ServerProjectiles } from "../ServerProjectiles";

/**
 * Leaving a game leaves nothing for the next one in the same page.
 *
 * Shutdown destroyed the match state with Game's phase listener on it, so no
 * later match ended with the winner showcase or its music (S2). It kept the
 * dead flag and the teammate view (S3), quad and air (L6), and ragdolls,
 * gibs, tracers and explosions that went on to expire in the next map (E8).
 */
interface ShutdownGame {
  shutdown(): void;
  _isPlayerDead: boolean;
}

const statics = Game as unknown as { instance: Game | null };

function connectedGame() {
  const spectate = { reset: vi.fn() };
  const liquid = { resetAir: vi.fn(), forgetLocal: vi.fn() };
  const effects = { clearWorld: vi.fn() };
  const instance = Object.assign(Object.create(Game.prototype), {
    _isPlayerDead: true,
    _respawnRequested: true,
    projectiles: new ServerProjectiles(),
    matchInput: { unbind: vi.fn() },
    playerWeapons: new Map(),
    enemyWeapons: new Map(),
    chargingPlayers: new Set(["player_3"]),
    chargingGlows: new Map(),
    onStateUpdateCallbacks: [],
    spectate,
    liquid,
    effects,
  }) as ShutdownGame;
  statics.instance = instance as unknown as Game;
  return { game: instance, spectate, liquid, effects };
}

afterEach(() => {
  statics.instance = null;
  MatchStateManager.destroy();
  vi.restoreAllMocks();
});

describe("a session ending", () => {
  it("leaves the next match its winner showcase and endgame music", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const loadPlaylist = vi.spyOn(AudioManager.getInstance(), "loadPlaylist").mockResolvedValue(undefined as never);
    const { game } = connectedGame();

    game.shutdown();
    MatchStateManager.getInstance().processEvent({ type: "match_state", phase: MatchPhase.PostGame, round: 1 });

    expect(loadPlaylist).toHaveBeenCalledWith("data/endgame.playlist.json");
  });

  it("forgets the player's death, the watched teammate, quad and air", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { game, spectate, liquid } = connectedGame();
    setLocalPowerup("quad", 30);

    game.shutdown();

    expect(game._isPlayerDead).toBe(false);
    expect(spectate.reset).toHaveBeenCalled();
    expect(isLocalPowerupActive("quad")).toBe(false);
    expect(liquid.resetAir).toHaveBeenCalled();
    expect(liquid.forgetLocal).toHaveBeenCalled();
  });

  it("clears the world's effects: ragdolls, gibs, tracers and explosions", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const hitscan = vi.spyOn(getHitscanEffects(), "clear");
    const explosions = vi.spyOn(getExplosionEffect(), "clear");
    const { game, effects } = connectedGame();

    game.shutdown();

    expect(effects.clearWorld).toHaveBeenCalled();
    expect(hitscan).toHaveBeenCalled();
    expect(explosions).toHaveBeenCalled();
  });
});
