// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUDState, type ScoreboardEntry } from "../HUDState";
import { FPSScoreboard } from "../hud/widgets/Scoreboard";
import { MatchStateManager } from "../MatchStateManager";

/**
 * The post-game result screen. The winner plate shook between sizes: every ping
 * change rebuilt the board, and each rebuild put the plate back in and restarted
 * its stamp, which starts at twice the size. The local player's row was never
 * marked (the board's own id was never set), so both sides of a duel showed the
 * enemy colour. A 1v1 listed each name twice, with the plate's rounds and the
 * row's frags side by side and unlabelled.
 */

const WARMUP = 0;

function matchState(over: Record<string, unknown>): void {
  const manager = MatchStateManager.getInstance();
  manager.reset();
  manager.processEvent({
    type: "match_state",
    phase: WARMUP,
    timeRemaining: 0,
    readyCount: 0,
    totalPlayers: 2,
    gametypeName: "Amphi",
    scoreLimit: 0,
    teamBased: true,
    standings: [],
    spectators: [],
    ...over,
  } as never);
}

function entry(over: Partial<ScoreboardEntry>): ScoreboardEntry {
  return { playerId: "", entityId: "", name: "", score: 0, deaths: 0, ping: 0, ...over };
}

function duelHud(): HUDState {
  const hud = HUDState.getInstance();
  hud.teamBased = true;
  hud.teamNames = { soba: "WRAITH", udon: "SUNDFLUX" };
  hud.teamScores = { soba: 0, udon: 2 };
  hud.localPlayerId = "player_1";
  hud.scoreboard = [
    entry({ playerId: "player_1", name: "sundflux", score: 10, deaths: 13, ping: 4, teamId: "udon" }),
    entry({ playerId: "player_2", name: "Wraith", score: 5, deaths: 9, ping: 30, teamId: "soba" }),
  ];
  return hud;
}

describe("post-game scoreboard", () => {
  it("keeps objective score separate from frags and never invents K/D for older snapshots", () => {
    const hud = duelHud();
    Object.assign(hud.scoreboard[0], { score: 250, frags: 4, deaths: 2 });
    board.setPostGame("SUNDFLUX WINS!", "player_1", "sundflux");
    const text = document.querySelector(".fps-postgame-stats")!.textContent;
    expect(text).toContain("Score250");
    expect(text).toContain("Frags4");
    expect(text).toContain("K/D2.00");
    delete hud.scoreboard[0].frags;
    hud.scoreboard[0].score++;
    hud.scoreboard = [...hud.scoreboard]; // a snapshot replaces the array
    board.refresh();
    expect(document.querySelector(".fps-postgame-stats")!.textContent).not.toContain("K/D");
  });
  let board: FPSScoreboard;

  beforeEach(() => {
    HUDState.getInstance().reset();
    matchState({ round: 2 });
    board = new FPSScoreboard();
  });

  afterEach(() => {
    board.destroy();
  });

  it("does no work between snapshots, while the scoreboard array is the same one", () => {
    const hud = duelHud();
    board.setPostGame("SUNDFLUX WINS!", "player_1", "sundflux");
    board.refresh();
    const stringify = vi.spyOn(JSON, "stringify");
    board.refresh();
    board.refresh();
    expect(stringify).not.toHaveBeenCalled();
    hud.scoreboard = [...hud.scoreboard];
    board.refresh();
    expect(stringify).toHaveBeenCalledOnce();
    stringify.mockRestore();
  });

  it("keeps the winner plate while pings change", () => {
    const hud = duelHud();
    board.setPostGame("SUNDFLUX WINS!", "player_1", "sundflux");
    const plate = document.querySelector(".fps-scoreboard-title");
    const versus = document.querySelector(".fps-scoreboard-versus");
    expect(plate?.textContent).toBe("SUNDFLUX WINS!");

    for (let ping = 5; ping < 15; ping++) {
      hud.scoreboard[0].ping = ping;
      hud.scoreboard = [...hud.scoreboard]; // a snapshot replaces the array
      board.refresh();
    }

    expect(document.querySelector(".fps-scoreboard-title")).toBe(plate);
    expect(document.querySelector(".fps-scoreboard-versus")).toBe(versus);
    expect(document.querySelector('[data-ping-for="player_1"]')?.textContent).toBe("14ms");
  });

  it("shows a 1v1 as a head-to-head, winner first, with what the figure counts", () => {
    duelHud();
    board.setPostGame("SUNDFLUX WINS!", "player_1", "sundflux");

    expect(document.querySelector(".fps-scoreboard-teams")).toBeNull();
    const names = [...document.querySelectorAll(".fps-versus-name")].map((el) => el.textContent);
    expect(names).toEqual(["sundflux", "Wraith"]);
    expect(document.querySelector(".fps-versus-figure")?.textContent).toBe("2 — 0");
    expect(document.querySelector(".fps-versus-label")?.textContent).toBe("Rounds");
    // The round counter is for the Tab board; the match is over.
    expect(document.querySelector(".fps-scoreboard-round")).toBeNull();
  });

  it("marks the local player's side as theirs", () => {
    duelHud();
    board.setPostGame("SUNDFLUX WINS!", "player_1", "sundflux");

    const self = document.querySelector(".fps-versus-side--self");
    expect(self?.querySelector(".fps-versus-name")?.textContent).toBe("sundflux");
    expect(self?.classList.contains("fps-versus-side--ally")).toBe(true);
  });

  it("counts frags in a 1v1 without rounds", () => {
    matchState({ round: 0 });
    duelHud();
    board.setPostGame("SUNDFLUX WINS!", "player_1", "sundflux");

    expect(document.querySelector(".fps-versus-figure")?.textContent).toBe("10 — 5");
    expect(document.querySelector(".fps-versus-label")?.textContent).toBe("Frags");
  });

  it("keeps team columns when a side has more than one player, with the local row marked", () => {
    const hud = duelHud();
    hud.scoreboard.push(entry({ playerId: "player_3", name: "Ghost", score: 3, teamId: "udon" }));
    board.show();

    expect(document.querySelector(".fps-scoreboard-versus")).toBeNull();
    expect(document.querySelectorAll(".fps-scoreboard-team")).toHaveLength(2);
    expect(document.querySelector(".fps-scoreboard-row--self .fps-scoreboard-col-name")?.textContent).toBe("sundflux");
    expect(document.querySelector(".fps-scoreboard-team--ally .fps-scoreboard-team-name")?.textContent).toBe(
      "SUNDFLUX",
    );
  });

  it("keeps a player who left on the board, reading LEFT", () => {
    const hud = duelHud();
    board.setPostGame("SUNDFLUX WINS!", "player_1", "sundflux");
    hud.scoreboard = hud.scoreboard.filter((e) => e.playerId !== "player_2");
    board.refresh();

    expect(document.querySelector(".fps-versus-side--departed .fps-versus-name")?.textContent).toBe("Wraith");
    expect(document.querySelector('[data-ping-for="player_2"]')?.textContent).toBe("LEFT");
  });
});
