import type { WorldState } from "@engine/server/core/WorldState";
import type { Entity } from "@engine/server/ecs/Entity";
import { MatchPhase } from "@shared/server/gametype";
import type { LoadoutChoice } from "@shared/server/gametype/Loadout";
import { describe, expect, it } from "vitest";
import { Amphi } from "../Amphi";
import type { GametypeTickContext } from "../BaseGametype";
import { MatchState } from "../MatchState";

const world = {} as WorldState;
const fighter = (ownerId: number) => ({ ownerId }) as Entity;
const context: GametypeTickContext = {
  tick: 1 as never,
  round: 1,
  live: false,
  attackingTeam: "udon",
  defendingTeam: "soba",
  teamOf: (id) => (id === 1 ? "udon" : "soba"),
  credit: () => {},
};

function nextRound(match: MatchState): void {
  match.transition(MatchPhase.Countdown);
  match.transition(MatchPhase.Active);
}

describe("Amphi", () => {
  it("plays three-minute deathmatch rounds with timed player and item respawns", () => {
    const mode = new Amphi();
    expect(mode.getMatchConfig()).toMatchObject({
      roundBased: true,
      roundRespawns: true,
      resetScoresEachRound: true,
      timeLimit: 180,
      scoreLimit: 2,
      maxRounds: 3,
      roundOvertimeOnDraw: true,
      roundOvertimeDuration: 60,
    });
    expect(mode.getItemSpawnRules()).toMatchObject({ spawnFromBsp: true, respawnMode: "timed" });
    expect(mode.getSpawnStrategy()).toBe("furthest");
    expect(mode.onTick(world, { ...context, live: true })).toBeNull();
  });

  it("ends at 2-0 or after a deciding third round", () => {
    const mode = new Amphi();
    const match = new MatchState(mode.name, mode.getMatchConfig(), mode.teamBased);
    match.addPlayer(1 as never);
    match.addPlayer(2 as never);
    match.setPlayerTeam(1 as never, "udon");
    match.setPlayerTeam(2 as never, "soba");
    nextRound(match);
    match.addScore(1 as never, 3);
    expect(match.getScore(1 as never)).toBe(3);
    match.endRound("udon");
    nextRound(match);
    expect(match.getScore(1 as never)).toBe(0);
    match.endRound("udon");
    expect(match.phase).toBe(MatchPhase.PostGame);
    expect(match.round).toBe(2);

    const split = new MatchState(mode.name, mode.getMatchConfig(), mode.teamBased);
    split.addPlayer(1 as never);
    split.addPlayer(2 as never);
    nextRound(split);
    split.endRound("udon");
    nextRound(split);
    split.endRound("soba");
    expect(split.phase).toBe(MatchPhase.RoundEnd);
    nextRound(split);
    split.endRound("udon");
    expect(split.phase).toBe(MatchPhase.PostGame);
    expect(split.computeWinner(true)).toMatchObject({ kind: "team", id: "udon" });
  });

  it("requires a chosen kit and applies changes only at the next round", () => {
    const mode = new Amphi();
    const rocket: LoadoutChoice = { primary: "rlauncher", secondary: "machinegun" };
    const bolt: LoadoutChoice = { primary: "electrobolt", secondary: "riotgun" };
    expect(mode.hasChosenLoadout(1 as never)).toBe(false);
    expect(mode.setPlayerLoadout(1 as never, rocket)).toBe(true);
    expect(mode.hasChosenLoadout(1 as never)).toBe(true);
    expect(mode.getSpawnLoadout(1 as never).weapons).toContain("rlauncher");
    mode.setPlayerLoadout(1 as never, bolt);
    expect(mode.getSpawnLoadout(1 as never).weapons).toContain("rlauncher");
    mode.onRoundStart(world, context);
    expect(mode.getSpawnLoadout(1 as never).weapons).toContain("electrobolt");
    mode.onPlayerLeave(1 as never);
    expect(mode.hasChosenLoadout(1 as never)).toBe(false);
  });

  it("counts only live round frags, allows deaths without ending, and ignores health at time", () => {
    const mode = new Amphi();
    mode.onPlayerJoin(1 as never, "one", world, "udon");
    mode.onPlayerJoin(2 as never, "two", world, "soba");
    mode.onDeath(fighter(2), fighter(1), world); // warmup
    mode.onRoundStart(world, context);
    mode.onMatchPhaseChange(MatchPhase.Active);
    mode.onDeath(fighter(2), fighter(1), world);
    mode.onDeath(fighter(2), fighter(1), world);
    mode.onDeath(fighter(1), fighter(2), world);
    expect(mode.onTick(world, { ...context, live: true })).toBeNull();
    expect(mode.onRoundTimeExpired(world)).toMatchObject({ winner: "udon", resultKey: "timeout" });

    mode.onRoundStart(world, context);
    mode.onMatchPhaseChange(MatchPhase.Active);
    mode.onDeath(fighter(1), fighter(1), world); // suicide costs a frag
    expect(mode.onRoundTimeExpired(world)).toMatchObject({ winner: "soba" });
    mode.onPlayerLeave(2 as never);
  });

  it("extends repeatedly on tied frags, then awards the round to the leader at expiry", () => {
    const mode = new Amphi();
    const match = new MatchState(mode.name, mode.getMatchConfig(), mode.teamBased);
    match.addPlayer(1 as never);
    match.addPlayer(2 as never);
    nextRound(match);
    mode.onPlayerJoin(1 as never, "one", world, "udon");
    mode.onPlayerJoin(2 as never, "two", world, "soba");
    mode.onRoundStart(world, context);
    mode.onMatchPhaseChange(MatchPhase.Active);
    mode.onDeath(fighter(2), fighter(1), world);
    mode.onDeath(fighter(1), fighter(2), world);
    match.update(180);
    expect(match.roundTimeExpired).toBe(true);
    expect(mode.onRoundTimeExpired(world)).toBeNull();
    match.extendRoundOvertime(60);
    expect(match.timeRemaining).toBe(60);
    expect(match.roundTimeExpired).toBe(false);
    expect(match.overtimeCount).toBe(1);
    match.update(60);
    expect(mode.onRoundTimeExpired(world)).toBeNull();
    match.extendRoundOvertime(60);
    expect(match.overtimeCount).toBe(2);
    expect(match.phase).toBe(MatchPhase.Active);
    mode.onDeath(fighter(2), fighter(1), world);
    match.update(60);
    const result = mode.onRoundTimeExpired(world);
    expect(result).toMatchObject({ winner: "udon", resultKey: "timeout" });
    match.endRound(result!.winner);
    expect(match.teamScores.get("udon")).toBe(1);
    expect(match.phase).toBe(MatchPhase.RoundEnd);
  });
});
