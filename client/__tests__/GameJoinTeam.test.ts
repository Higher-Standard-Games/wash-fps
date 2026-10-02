// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { SnapshotBuffer } from "../../../../engine/network/client/SnapshotBuffer";
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
  gameHost: { sendJoinGame: (team?: string, manualPick?: boolean, admissionTicket?: string) => void };
  _joinPending: boolean;
  _joinGametypeWaits: number;
  _preferredTeam: string | undefined;
  _teamWasPicked: boolean;
  _joinPendingTimeout?: ReturnType<typeof setTimeout>;
  joinGame(teamId?: string): Promise<void>;
}

function joinableGame(
  sendJoinGame: (team?: string, manualPick?: boolean, admissionTicket?: string) => void,
): JoinableGame {
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
  game._teamWasPicked = false;
  return game;
}

afterEach(() => MatchStateManager.destroy());

it("clears live projectile ids and accepts the next server's earlier ticks", () => {
  const buffer = new SnapshotBuffer();
  buffer.push(10000, new Map());
  const game = Object.assign(Object.create(Game.prototype), {
    projectileBuffer: buffer,
    activeServerProjectiles: new Set(["proj_1"]),
    serverProjectileDefIds: new Map([["proj_1", "rocket"]]),
    forgetProjectileLiquid: vi.fn(),
  });
  game.resetServerProjectiles();
  expect(game.activeServerProjectiles.size).toBe(0);
  expect(game.serverProjectileDefIds.size).toBe(0);
  expect(game.forgetProjectileLiquid).toHaveBeenCalledWith("proj_1");
  expect(buffer.getBufferSize()).toBe(0);
  expect(buffer.push(10, new Map())).toBe(true);
});

describe("Game team selection", () => {
  it("sends the explicit team button choice, flagged as picked in-game", async () => {
    const sendJoinGame = vi.fn();
    const game = joinableGame(sendJoinGame);

    await game.joinGame("soba");

    // The flag is the point: the server balances a side a player CHOSE, and
    // delivers a side the lobby assigned untouched.
    expect(sendJoinGame).toHaveBeenCalledWith("soba", true, undefined);
    clearTimeout(game._joinPendingTimeout);
  });

  it("sends the lobby handoff unflagged, so the server does not rebalance it", async () => {
    const sendJoinGame = vi.fn();
    const game = joinableGame(sendJoinGame);

    // No argument — this is the lobby's assignment, carried in `_preferredTeam`.
    await game.joinGame();

    expect(sendJoinGame).toHaveBeenCalledWith("udon", false, undefined);
    clearTimeout(game._joinPendingTimeout);
  });
});
