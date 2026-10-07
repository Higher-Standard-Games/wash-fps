/**
 * The result screen, after the entities are gone.
 *
 * A match ends by flagging every client as spectating and despawning their
 * entities. The scoreboard read score and deaths off those entities, so at the
 * moment the result mattered most there was nothing left to render and the
 * whole lobby fell through to the SPECTATORS block with no scores.
 *
 * Final standings come from the match's own tally instead, and outlive the
 * entities they describe.
 */

import { describe, expect, it } from "vitest";
import { MatchStateManager } from "../MatchStateManager";

type Standing = { playerId: string; name: string; score: number; deaths: number; ping: number };

function applyMatchState(standings: Standing[], spectators: Array<{ playerId: string; name: string; ping: number }>) {
  const manager = MatchStateManager.getInstance();
  manager.reset();
  manager.processEvent({
    type: "match_state",
    phase: 3,
    timeRemaining: 0,
    readyCount: 0,
    totalPlayers: standings.length,
    gametypeName: "Free For All",
    scoreLimit: 20,
    teamBased: false,
    standings,
    spectators,
  } as never);
  return manager;
}

describe("end-of-match standings", () => {
  it("carries the final tally when no entities remain", () => {
    const manager = applyMatchState(
      [
        { playerId: "p1", name: "Player_q8hh", score: 20, deaths: 0, ping: 12 },
        { playerId: "p2", name: "Phantom", score: 7, deaths: 11, ping: 30 },
      ],
      [],
    );

    expect(manager.standings).toHaveLength(2);
    expect(manager.standings[0].score).toBe(20);
    expect(manager.standings[1].name).toBe("Phantom");
  });

  it("defaults to empty rather than undefined when a server omits them", () => {
    // Older servers, and every snapshot before the match ends, send nothing.
    const manager = MatchStateManager.getInstance();
    manager.reset();
    manager.processEvent({
      type: "match_state",
      phase: 2,
      timeRemaining: 60,
      readyCount: 0,
      totalPlayers: 0,
      gametypeName: "Free For All",
      scoreLimit: 20,
    } as never);

    expect(manager.standings).toEqual([]);
  });

  it("keeps the roster it holds when the server says it left it out", () => {
    const manager = applyMatchState(
      [{ playerId: "p1", name: "Solo", score: 9, deaths: 1, ping: 5 }],
      [{ playerId: "p9", name: "Watcher", ping: 0 }],
    );
    manager.processEvent({ type: "match_state", phase: 2, timeRemaining: 41, rosterOmitted: true } as never);

    expect(manager.timeRemaining).toBe(41);
    expect(manager.standings).toEqual([{ playerId: "p1", name: "Solo", score: 9, deaths: 1, ping: 5 }]);
    expect(manager.spectators).toEqual([{ playerId: "p9", name: "Watcher", ping: 0 }]);
  });

  it("reports free-for-all as teamless, so the board does not render team columns", () => {
    // The other half of the same bug: teamScores ships with both sides present
    // in every gametype, so team-ness cannot be inferred from it.
    const manager = applyMatchState([{ playerId: "p1", name: "Solo", score: 1, deaths: 0, ping: 5 }], []);

    expect(manager.teamBased).toBe(false);
  });

  it("clears standings on reset, so a new match cannot inherit the last result", () => {
    const manager = applyMatchState([{ playerId: "p1", name: "Solo", score: 9, deaths: 1, ping: 5 }], []);
    expect(manager.standings).toHaveLength(1);

    manager.reset();

    expect(manager.standings).toEqual([]);
  });
});
