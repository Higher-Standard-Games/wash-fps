import { MatchPhase } from "@shared/server/gametype";
import { describe, expect, it } from "vitest";
import { MatchState } from "../MatchState";

describe("authoritative match totals", () => {
  it("excludes warmup/intermission and retains stats/time across removal and rejoin", () => {
    const match = new MatchState("FFA", { timeLimit: 1000 });
    match.setFlow("single");
    const id = 1 as never;
    match.addPlayer(id);
    match.addPlayer(2 as never);
    match.recordStat(id, (s) => {
      s.frags = 999;
    });
    match.update(1);
    match.transition(MatchPhase.Active);
    match.recordStat(id, (s) => {
      s.frags = 4;
      s.damageGiven = 500;
    });
    match.addScore(id, 3);
    match.update(2);
    expect(match.getResultStats(id)).toMatchObject({ frags: 4, score: 3, activeTimeMs: 2000 });
    match.removePlayer(id);
    match.update(3);
    expect(match.getResultStats(id)).toMatchObject({ frags: 4, score: 3, activeTimeMs: 2000 });
    match.addPlayer(id);
    match.update(1);
    expect(match.getResultStats(id).activeTimeMs).toBe(3000);
    match.transition(MatchPhase.PostGame);
    match.update(2);
    expect(match.getResultStats(id).activeTimeMs).toBe(3000);
  });
});
