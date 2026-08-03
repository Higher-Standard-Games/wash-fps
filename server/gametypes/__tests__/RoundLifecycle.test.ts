/**
 * Round-based match lifecycle (docs/research/Search_And_Destroy.md §5.1, §4.3).
 *
 * A round is NOT a new state machine — it is the existing phase cycle looping:
 * `Countdown` is the round freeze, `Active` is the live round, and a decided
 * round goes to `RoundEnd` (the intermission, where the detonation is watched)
 * before the next freeze. These tests pin that, the side-swap format, and the
 * tennis rule.
 *
 * They also pin the thing most likely to break by accident: **non-round modes
 * must behave exactly as before**, since this touches code every gametype uses.
 */

import { MatchPhase } from "@shared/server/gametype";
import { describe, expect, it } from "vitest";
import { MatchState } from "../MatchState";

/** Warsow-shaped S&D config: 10 to win, lead by 2, swap after 9. */
const SND = {
  warmupTimeout: 0,
  countdownDuration: 5,
  timeLimit: 90,
  scoreLimit: 10,
  postGameDuration: 15,
  respawnDelay: 3,
  selfDamage: 1,
  roundBased: true,
  roundsPerHalf: 9,
  leadRequired: 2,
  roundEndDuration: 5,
};

/** Run out the round-end intermission, landing on the next freeze. */
function skipIntermission(m: MatchState): void {
  while (m.phase === MatchPhase.RoundEnd) m.update(1);
}

/** Drive a match to its first live round. */
function liveMatch(config = SND): MatchState {
  const m = new MatchState("Search & Destroy", config, true);
  m.addPlayer(1 as never);
  m.addPlayer(2 as never);
  m.transition(MatchPhase.Countdown);
  m.transition(MatchPhase.Active);
  return m;
}

/** Play `count` rounds, all won by `winner`. */
function playRounds(m: MatchState, count: number, winner: "udon" | "soba"): void {
  for (let i = 0; i < count; i++) {
    if (m.phase !== MatchPhase.Active) m.transition(MatchPhase.Active);
    m.endRound(winner);
    skipIntermission(m);
  }
}

// ── The loop ─────────────────────────────────────────────────────────

describe("round loop", () => {
  it("returns to Countdown at round end instead of ending the match", () => {
    const m = liveMatch();
    expect(m.phase).toBe(MatchPhase.Active);
    expect(m.round).toBe(1);

    m.endRound("udon");
    // The intermission first — the round is decided, and the result is watched
    // before the next freeze begins.
    expect(m.phase).toBe(MatchPhase.RoundEnd);
    skipIntermission(m);
    expect(m.phase).toBe(MatchPhase.Countdown);

    m.transition(MatchPhase.Active);
    expect(m.round).toBe(2);
  });

  it("keeps scores across rounds — only the first round starts a fresh match", () => {
    // Active resets scores, which is correct once per match and catastrophic
    // once per round.
    const m = liveMatch();
    m.endRound("udon");
    skipIntermission(m);
    m.transition(MatchPhase.Active);
    m.endRound("udon");
    expect(m.teamScores.get("udon")).toBe(2);
  });

  it("clears the round counter when a rematch warms up", () => {
    const m = liveMatch();
    m.endRound("udon");
    m.transition(MatchPhase.Warmup);
    expect(m.round).toBe(0);
  });

  it("clears stat-derived scores before a continuous rematch", () => {
    const m = liveMatch();
    m.setScoreFormula((stats) => stats.damageGiven);
    m.recordStat(1 as never, (stats) => {
      stats.damageGiven = 25;
    });
    expect(m.getScore(1 as never)).toBe(25);

    m.transition(MatchPhase.PostGame);
    m.transition(MatchPhase.Warmup);
    m.transition(MatchPhase.Countdown);
    m.transition(MatchPhase.Active);

    expect(m.getScore(1 as never)).toBe(0);
    expect(m.getStats(1 as never).damageGiven).toBe(0);
    m.recordStat(1 as never, (stats) => {
      stats.damageGiven = 1;
    });
    expect(m.getScore(1 as never)).toBe(1);
  });

  it("does not award a round to a null winner", () => {
    const m = liveMatch();
    m.endRound(null);
    expect(m.teamScores.get("udon")).toBe(0);
    expect(m.teamScores.get("soba")).toBe(0);
    skipIntermission(m);
    expect(m.phase).toBe(MatchPhase.Countdown);
  });

  it("ignores endRound outside the live phase", () => {
    const m = liveMatch();
    m.endRound("udon");
    expect(m.phase).toBe(MatchPhase.RoundEnd);
    m.endRound("udon"); // already between rounds
    skipIntermission(m);
    m.endRound("udon"); // and again during the freeze
    expect(m.teamScores.get("udon")).toBe(1);
  });
});

// ── The round timer ──────────────────────────────────────────────────

describe("round timer", () => {
  it("flags expiry instead of ending the match, so the gametype can decide", () => {
    // "Defenders win if nothing was planted" is an S&D rule; MatchState must
    // not assume it.
    const m = liveMatch();
    m.update(SND.timeLimit + 1);
    expect(m.roundTimeExpired).toBe(true);
    expect(m.phase).toBe(MatchPhase.Active);
  });

  it("clears the flag once the round ends", () => {
    const m = liveMatch();
    m.update(SND.timeLimit + 1);
    m.endRound("soba");
    expect(m.roundTimeExpired).toBe(false);
  });
});

// ── Sides ────────────────────────────────────────────────────────────

describe("attacking side", () => {
  it("keeps one side attacking for the whole first half", () => {
    const m = liveMatch();
    for (let round = 1; round <= 9; round++) {
      expect(m.round, `round ${round}`).toBe(round);
      expect(m.attackingTeam, `round ${round}`).toBe("udon");
      m.endRound("soba");
      skipIntermission(m);
      if (round < 9) m.transition(MatchPhase.Active);
    }
  });

  it("swaps sides for the second half", () => {
    const m = liveMatch();
    playRounds(m, 9, "soba"); // soba reaches 9 — not decisive without the lead
    m.transition(MatchPhase.Active);
    expect(m.round).toBe(10);
    expect(m.attackingTeam).toBe("soba");
    expect(m.defendingTeam).toBe("udon");
  });

  it("alternates every round once overtime begins", () => {
    // By then each side has had its nine attacking rounds, and a win needs a
    // two-round lead — which spans one attack round each however sides fall.
    const m = liveMatch();
    for (let i = 0; i < 18; i++) {
      if (m.phase !== MatchPhase.Active) m.transition(MatchPhase.Active);
      m.endRound(i % 2 === 0 ? "udon" : "soba"); // 9-9
      skipIntermission(m);
    }
    expect(m.teamScores.get("udon")).toBe(9);
    expect(m.teamScores.get("soba")).toBe(9);

    m.transition(MatchPhase.Active);
    expect(m.round).toBe(19);
    expect(m.inOvertime).toBe(true);
    expect(m.attackingTeam).toBe("udon");

    m.endRound(null);
    skipIntermission(m);
    m.transition(MatchPhase.Active);
    expect(m.attackingTeam).toBe("soba");
  });

  it("honours a chosen starting attacker", () => {
    const m = new MatchState("Search & Destroy", SND, true);
    m.setStartingAttacker("soba");
    m.addPlayer(1 as never);
    m.addPlayer(2 as never);
    m.transition(MatchPhase.Countdown);
    m.transition(MatchPhase.Active);
    expect(m.attackingTeam).toBe("soba");
  });
});

// ── Tennis rule ──────────────────────────────────────────────────────

describe("tennis rule", () => {
  it("does not end the match at the limit without the lead", () => {
    const m = liveMatch();
    playRounds(m, 9, "udon");
    playRounds(m, 9, "soba");
    // 9-9, then udon takes one: 10-9 is the limit but only a one-round lead.
    m.transition(MatchPhase.Active);
    m.endRound("udon");
    expect(m.teamScores.get("udon")).toBe(10);
    expect(m.phase).toBe(MatchPhase.RoundEnd);
    expect(m.hasDecisiveLead()).toBe(false);
  });

  it("ends the match once the lead is reached", () => {
    const m = liveMatch();
    playRounds(m, 9, "udon");
    playRounds(m, 1, "udon"); // 10-0
    expect(m.hasDecisiveLead()).toBe(true);
    expect(m.phase).toBe(MatchPhase.PostGame);
  });

  it("cannot be won before the swap — the limit is out of reach in one half", () => {
    // 9 rounds per half against a limit of 10: nobody can win without playing
    // both sides.
    const m = liveMatch();
    playRounds(m, 9, "udon");
    expect(m.teamScores.get("udon")).toBe(9);
    expect(m.phase).toBe(MatchPhase.Countdown);
  });

  it("treats leadRequired 1 as no requirement", () => {
    const m = liveMatch({ ...SND, leadRequired: 1, roundsPerHalf: 99 });
    playRounds(m, 10, "udon");
    expect(m.phase).toBe(MatchPhase.PostGame);
  });
});

// ── Non-round modes are untouched ────────────────────────────────────

describe("non-round modes keep today's behaviour", () => {
  const DM = {
    warmupTimeout: 0,
    countdownDuration: 3,
    timeLimit: 60,
    scoreLimit: 20,
    postGameDuration: 15,
    respawnDelay: 3,
    selfDamage: 1,
  };

  it("ends the match when the timer expires, as before", () => {
    const m = new MatchState("Deathmatch", DM, false);
    m.addPlayer(1 as never);
    m.addPlayer(2 as never);
    m.transition(MatchPhase.Countdown);
    m.transition(MatchPhase.Active);
    m.update(DM.timeLimit + 1);
    expect(m.phase).toBe(MatchPhase.PostGame);
    expect(m.roundTimeExpired).toBe(false);
  });

  it("reports no round context and ignores endRound", () => {
    const m = new MatchState("Deathmatch", DM, false);
    m.addPlayer(1 as never);
    m.addPlayer(2 as never);
    m.transition(MatchPhase.Countdown);
    m.transition(MatchPhase.Active);
    m.endRound("udon");
    expect(m.phase).toBe(MatchPhase.Active);
    expect(m.roundBased).toBe(false);

    const snap = m.toSnapshot();
    expect(snap.round).toBeUndefined();
    expect(snap.teamRoles).toBeUndefined();
  });

  it("still resets scores when Active begins", () => {
    const m = new MatchState("Deathmatch", DM, true);
    m.addPlayer(1 as never);
    m.addPlayer(2 as never);
    m.addTeamScore("udon", 5);
    m.transition(MatchPhase.Countdown);
    m.transition(MatchPhase.Active);
    expect(m.teamScores.get("udon")).toBe(0);
  });
});

// ── Snapshot ─────────────────────────────────────────────────────────

describe("snapshot", () => {
  it("publishes round and per-team roles for round modes", () => {
    // Public information — everyone in a bomb round knows who is attacking —
    // so it rides the broadcast snapshot. Bots read it to select a profile.
    const m = liveMatch();
    const snap = m.toSnapshot();
    expect(snap.round).toBe(1);
    expect(snap.teamRoles).toEqual({ udon: "attacker", soba: "defender" });
  });

  it("reflects the swap", () => {
    const m = liveMatch();
    playRounds(m, 9, "soba");
    m.transition(MatchPhase.Active);
    expect(m.toSnapshot().teamRoles).toEqual({ soba: "attacker", udon: "defender" });
  });
});

// ── The round-end intermission ───────────────────────────────────────

describe("round-end intermission", () => {
  it("holds for its full duration before the next freeze", () => {
    // The beat exists so a detonation is watched rather than cut away from,
    // which means nothing may shorten it.
    const m = liveMatch();
    m.endRound("udon");
    expect(m.phase).toBe(MatchPhase.RoundEnd);

    m.update(SND.roundEndDuration - 1);
    expect(m.phase).toBe(MatchPhase.RoundEnd);
    m.update(2);
    expect(m.phase).toBe(MatchPhase.Countdown);
  });

  it("reports how the round was won, for the banner", () => {
    const m = liveMatch();
    m.endRound("soba", { reason: "defused", focus: { x: 1, y: 2, z: 3 } });

    const result = m.roundResult;
    expect(result?.reason).toBe("defused");
    expect(result?.winner).toBe("soba");
    expect(result?.round).toBe(1);
    expect(result?.focus).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("names the winning team, so the banner needs no lookup", () => {
    const m = liveMatch();
    m.endRound("udon", { reason: "detonated" });
    expect(m.roundResult?.winnerName).toBeTruthy();
  });

  it("clears the result when the next round starts", () => {
    const m = liveMatch();
    m.endRound("udon", { reason: "detonated" });
    expect(m.roundResult).not.toBeNull();
    skipIntermission(m);
    expect(m.roundResult).toBeNull();
  });

  it("is skipped when the round decides the match", () => {
    // A match-winning round goes straight to the post-game screen; two result
    // banners stacked on each other would be worse than one.
    const m = liveMatch({ ...SND, roundsPerHalf: 99 });
    playRounds(m, 9, "udon");
    m.transition(MatchPhase.Active);
    m.endRound("udon"); // 10-0
    expect(m.phase).toBe(MatchPhase.PostGame);
  });

  it("puts the result in the snapshot only while the intermission runs", () => {
    const m = liveMatch();
    m.endRound("udon", { reason: "detonated" });
    expect(m.roundResult).not.toBeNull();
    skipIntermission(m);
    m.transition(MatchPhase.Active);
    expect(m.roundResult).toBeNull();
  });
});

// ── Starting the match ───────────────────────────────────────────────

describe("the ready gate", () => {
  function botMatch(humans: number, bots: number): MatchState {
    const m = new MatchState("Search & Destroy", SND, true);
    m.setHumanClients(humans);
    const botIds = new Set<never>();
    for (let i = 0; i < bots; i++) {
      const id = (100 + i) as never;
      m.addPlayer(id);
      botIds.add(id);
    }
    m.setBotPlayers(botIds);
    for (const id of botIds) m.playerReady(id);
    return m;
  }

  it("does not start on bots alone while a human is connected", () => {
    // Bots ready the instant they join, so in a lobby match they reached the
    // threshold among themselves while the human was still loading. The match
    // began without them: no warmup, and they arrived inside a live round.
    const m = botMatch(1, 3);
    m.update(1);
    expect(m.phase).toBe(MatchPhase.Warmup);
  });

  it("starts once that human readies", () => {
    const m = botMatch(1, 3);
    const human = 1 as never;
    m.addPlayer(human);
    m.playerReady(human);
    m.update(1);
    expect(m.phase).toBe(MatchPhase.Countdown);
  });

  it("still starts on bots alone when nobody is watching", () => {
    // Headless testing depends on it.
    const m = botMatch(0, 3);
    m.update(1);
    expect(m.phase).toBe(MatchPhase.Countdown);
  });
});
