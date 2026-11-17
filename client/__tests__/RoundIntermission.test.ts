// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { FPSRoundResult } from "../hud/widgets/RoundResult";
import { MatchPhase, MatchStateManager } from "../MatchStateManager";

function matchState(fields: Record<string, unknown>) {
  MatchStateManager.getInstance().processEvent({
    type: "match_state",
    timeRemaining: 0,
    readyCount: 0,
    totalPlayers: 2,
    gametypeName: "Amphi",
    scoreLimit: 2,
    teamBased: true,
    teamScores: { udon: 1, soba: 0, spectator: 0 },
    teamNames: { udon: "Player_5937", soba: "Cartel_King", spectator: "Spectator" },
    ...fields,
  } as never);
}

describe("round intermission", () => {
  it("shows who won and counts to the next round through the round end and the freeze", () => {
    MatchStateManager.getInstance().reset();
    const overlay = new FPSRoundResult();
    const shown = () => overlay.getElement().classList.contains("fps-round-result--shown");
    const text = () => overlay.getElement().textContent ?? "";

    matchState({ phase: MatchPhase.Active, round: 1, timeRemaining: 100 });
    overlay.update({} as never);
    expect(shown()).toBe(false);

    const roundResult = { winner: "udon", winnerName: "Player_5937", reason: "eliminated", round: 1 };
    matchState({ phase: MatchPhase.RoundEnd, round: 1, timeRemaining: 4, roundResult, nextRoundIn: 9 });
    overlay.update({} as never);
    expect(shown()).toBe(true);
    expect(text()).toContain("Player_5937");
    expect(text()).toContain("won the round!");
    expect(overlay.getElement().querySelector(".fps-round-result-count")?.textContent).toBe("9");

    // The server clears the result at the next freeze; the overlay keeps it
    matchState({ phase: MatchPhase.Countdown, round: 2, timeRemaining: 4.2, nextRoundIn: 4.2 });
    overlay.update({} as never);
    expect(shown()).toBe(true);
    expect(overlay.getElement().querySelector(".fps-round-result-count")?.textContent).toBe("5");

    matchState({ phase: MatchPhase.Active, round: 2, timeRemaining: 180 });
    overlay.update({} as never);
    expect(shown()).toBe(false);
    overlay.destroy();
  });

  it("says a round with no winner was drawn", () => {
    MatchStateManager.getInstance().reset();
    const overlay = new FPSRoundResult();
    const roundResult = { winner: null, winnerName: "Nobody", reason: "timeout", round: 3 };
    matchState({ phase: MatchPhase.RoundEnd, round: 3, timeRemaining: 4, roundResult, nextRoundIn: 9 });
    overlay.update({} as never);
    expect(overlay.getElement().textContent).toContain("Round drawn");
    expect(overlay.getElement().textContent).not.toContain("Nobody");
    overlay.destroy();
  });

  it("puts Soba left and Udon right, as the scoreboard does", () => {
    MatchStateManager.getInstance().reset();
    const overlay = new FPSRoundResult();
    const roundResult = { winner: "soba", winnerName: "Cartel_King", reason: "eliminated", round: 6 };
    matchState({
      phase: MatchPhase.RoundEnd,
      round: 6,
      timeRemaining: 4,
      roundResult,
      nextRoundIn: 9,
      teamScores: { udon: 2, soba: 4, spectator: 0 },
    });
    overlay.update({} as never);
    const score = overlay.getElement().querySelector(".fps-round-result-score")?.textContent;
    expect(score).toBe("Cartel_King4:2Player_5937");
    overlay.destroy();
  });
});
