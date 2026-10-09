/**
 * camera_audit has to name the value that decides whether a death-camera roll
 * can ever lift: the local entity id. Every combat_state branch that clears the
 * death flag is gated on it, and it resolves to nothing whenever the local
 * player is missing from the snapshot's player map — so the audit must say
 * which of those two it is, not just report the flag.
 */

import { describe, expect, it } from "vitest";
import { Game } from "../../Game";

interface AuditGame {
  _isPlayerDead: boolean;
  spectate: { _spectatingEntityId: string | null };
  localPlayerId: string;
  _latestGameState: { players: Map<string, { entityId: string }> } | null;
  describeCameraOwnershipForAudit(): string;
}

function gameWith(players: Array<[string, string]>, localPlayerId: string): AuditGame {
  const game = Object.create(Game.prototype) as AuditGame;
  game._isPlayerDead = true;
  game.spectate = { _spectatingEntityId: null };
  game.localPlayerId = localPlayerId;
  game._latestGameState = { players: new Map(players.map(([key, entityId]) => [key, { entityId }])) };
  return game;
}

describe("camera_audit ownership line", () => {
  it("resolves the local entity id when the snapshot carries the local player", () => {
    const line = gameWith([["player_1", "1"]], "player_1").describeCameraOwnershipForAudit();

    expect(line).toContain("localEntityId=1");
    expect(line).toContain("dead=true");
  });

  it("says the id is unresolved when the local player is missing from the snapshot", () => {
    const line = gameWith([["player_2", "2"]], "player_1").describeCameraOwnershipForAudit();

    // The death flag can never be cleared in this state, so name it outright
    // and list who the snapshot did carry.
    expect(line).toContain("localEntityId=UNRESOLVED");
    expect(line).toContain("snapshotPlayers=[player_2]");
  });

  it("reports no snapshot at all rather than an empty resolution", () => {
    const game = gameWith([], "player_1");
    game._latestGameState = null;

    expect(game.describeCameraOwnershipForAudit()).toContain("snapshotPlayers=[none]");
  });
});
