// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerWeaponStates } from "../SnapshotStateStore";
import { SpectateView } from "../SpectateView";

/**
 * Dying and coming back are tracked every frame, not only while dead.
 *
 * The death camera is driven only while dead, so state kept there never saw a
 * respawn: every death after the first skipped the corpse camera and cut
 * straight to a teammate (S1), and a revive that skipped the "dead, round over"
 * frame left us alive behind a teammate's eyes (S4).
 */
interface Internals {
  _spectatingEntityId: string | null;
  _deathAtMs: number;
  _eyeCamera: { stop: () => void };
}

function view() {
  const life = { dead: false };
  const setHidden = vi.fn();
  const spectate = new SpectateView({
    isPlayerDead: () => life.dead,
    playerState: () => "playing",
    localPlayerId: () => "player_1",
    latestGameState: () => null,
    remoteRenderer: () => ({ setHiddenEntity: setHidden, getRenderedPlayers: () => new Map() }) as never,
    spectatorOverlay: () => ({ setMode: vi.fn() }) as never,
    spectatorCycling: () => null,
    spectatorController: () => null,
    enemyWeapons: () => new Map(),
    playerWeapons: () => new PlayerWeaponStates(),
  });
  const internals = spectate as unknown as Internals;
  internals._eyeCamera = { stop: vi.fn() };
  return { spectate, internals, life, setHidden };
}

describe("life edges seen every frame", () => {
  afterEach(() => vi.restoreAllMocks());

  it("times every death from that death, not the first one", () => {
    const now = vi.spyOn(performance, "now");
    const { spectate, internals, life } = view();

    now.mockReturnValue(1_000);
    life.dead = true;
    spectate.syncFollowedSubject();
    expect(internals._deathAtMs).toBe(1_000);

    // The next round revives us; the death camera is not running now.
    now.mockReturnValue(60_000);
    life.dead = false;
    spectate.syncFollowedSubject();

    now.mockReturnValue(90_000);
    life.dead = true;
    spectate.syncFollowedSubject();
    expect(internals._deathAtMs).toBe(90_000);
  });

  it("stops watching a teammate as soon as we are alive", () => {
    const { spectate, internals, life, setHidden } = view();
    life.dead = true;
    internals._spectatingEntityId = "player_2";
    spectate.syncFollowedSubject();
    expect(internals._spectatingEntityId).toBe("player_2");

    life.dead = false;
    spectate.syncFollowedSubject();
    expect(internals._spectatingEntityId).toBeNull();
    expect(internals._eyeCamera.stop).toHaveBeenCalled();
    expect(setHidden).toHaveBeenCalledWith(null);
  });
});
