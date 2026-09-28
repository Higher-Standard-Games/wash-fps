/**
 * Who the scoreboard files under a side, and who under spectators.
 *
 * The server's roster calls every player "spectator" until a team mode gives
 * them a side, and a free-for-all never does. Read as-is, a deathmatch board
 * listed everyone fragging as a spectator and had no score rows at all.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { GameState } from "../../../../engine/network/core/GameState";
import { toClientKey } from "../../ClientEntityKey";
import { HUDState } from "../HUDState";
import { MatchStateManager } from "../MatchStateManager";

function matchState(teamBased: boolean, playerTeams: Record<string, string>, spectators = [] as never[]) {
  const manager = MatchStateManager.getInstance();
  manager.reset();
  manager.processEvent({
    type: "match_state",
    phase: 2,
    timeRemaining: 90,
    gametypeName: teamBased ? "Team Deathmatch" : "Deathmatch",
    teamBased,
    playerTeams,
    spectators,
  } as never);
}

function players(...rows: Array<[id: string, name: string, score: number]>): GameState {
  const map = new Map(
    rows.map(([id, name, score]) => [toClientKey(id), { entityId: `e${id}`, name, score, deaths: 0, ping: 10 }]),
  );
  return { players: map } as unknown as GameState;
}

afterEach(() => MatchStateManager.getInstance().reset());

describe("scoreboard sides", () => {
  it("counts everyone in a free-for-all as playing, whatever the roster calls them", () => {
    matchState(false, { "14": "spectator", "15": "spectator" });
    const hud = HUDState.getInstance();
    hud.updateScoreboard(players(["14", "Phantom", 7], ["15", "Wraith", 6]));

    expect(hud.scoreboard.map((row) => [row.name, row.teamId])).toEqual([
      ["Phantom", undefined],
      ["Wraith", undefined],
    ]);
  });

  it("still lists a free-for-all's real spectators apart", () => {
    matchState(false, { "14": "spectator" }, [{ playerId: toClientKey("21"), name: "Watcher", ping: 20 }] as never[]);
    const hud = HUDState.getInstance();
    hud.updateScoreboard(players(["14", "Phantom", 7]));

    expect(hud.scoreboard.find((row) => row.name === "Watcher")?.teamId).toBe("spectator");
    expect(hud.scoreboard.find((row) => row.name === "Phantom")?.teamId).toBeUndefined();
  });

  it("keeps the server's sides in a team mode", () => {
    matchState(true, { "14": "udon", "15": "soba" });
    const hud = HUDState.getInstance();
    hud.updateScoreboard(players(["14", "Phantom", 7], ["15", "Wraith", 6]));

    expect(hud.scoreboard.map((row) => row.teamId)).toEqual(["udon", "soba"]);
  });
});
