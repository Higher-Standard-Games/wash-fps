import { MatchPhase } from "@shared/server/gametype";
import type { LoadoutChoice } from "@shared/server/gametype/Loadout";
import { describe, expect, it } from "vitest";
import { Amphi } from "../Amphi";
import type { GametypeTickContext } from "../BaseGametype";
import { MatchState } from "../MatchState";

interface Fighter {
  ownerId: number;
  team: "udon" | "soba";
  health: number;
  armor: number;
  dead?: boolean;
}

function arena(fighters: Fighter[]) {
  const state = {
    entitiesByType: () =>
      fighters.map((fighter) => ({
        ownerId: fighter.ownerId,
        health: { health: fighter.health, armor: fighter.armor, dead: fighter.dead ?? false },
      })),
  } as never;
  const teams = new Map(fighters.map((fighter) => [fighter.ownerId, fighter.team]));
  const context: GametypeTickContext = {
    tick: 1 as never,
    round: 1,
    live: true,
    attackingTeam: "udon",
    defendingTeam: "soba",
    teamOf: (id) => teams.get(id) ?? "spectator",
    credit: () => {},
  };
  return { state, context };
}

describe("Amphi", () => {
  it("uses three-minute no-respawn rounds, first to three, with round-reset pickups", () => {
    const mode = new Amphi();
    expect(mode.getMatchConfig()).toMatchObject({ roundBased: true, timeLimit: 180, scoreLimit: 3, leadRequired: 1 });
    expect(mode.getItemSpawnRules()).toMatchObject({ spawnFromBsp: true, respawnMode: "round" });
    expect(mode.getSpawnStrategy()).toBe("furthest");

    const match = new MatchState(mode.name, mode.getMatchConfig(), mode.teamBased);
    match.addPlayer(1 as never);
    match.addPlayer(2 as never);
    match.setPlayerTeam(1 as never, "udon");
    match.setPlayerTeam(2 as never, "soba");
    for (let round = 1; round <= 3; round++) {
      match.transition(MatchPhase.Countdown);
      match.transition(MatchPhase.Active);
      match.endRound("udon");
      expect(match.teamScores.get("udon")).toBe(round);
    }
    expect(match.phase).toBe(MatchPhase.PostGame);
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
    const { state, context } = arena([]);
    mode.onRoundStart(state, context);
    expect(mode.getSpawnLoadout(1 as never).weapons).toContain("electrobolt");
    mode.onPlayerLeave(1 as never);
    expect(mode.hasChosenLoadout(1 as never)).toBe(false);
  });

  it("awards elimination, including a simultaneous draw, after both players appear", () => {
    const mode = new Amphi();
    const fighters: Fighter[] = [{ ownerId: 1, team: "udon", health: 100, armor: 100 }];
    const { state, context } = arena(fighters);
    expect(mode.onTick(state, context)).toBeNull(); // Opponent has not loaded yet.
    fighters.push({ ownerId: 2, team: "soba", health: 100, armor: 100 });
    // Refresh context's team lookup for the new entrant.
    const both = arena(fighters);
    expect(mode.onTick(both.state, both.context)).toBeNull();
    fighters[1].dead = true;
    expect(mode.onTick(both.state, both.context)).toMatchObject({ winner: "udon", resultKey: "eliminated" });

    mode.onRoundStart(both.state, both.context);
    fighters[0].dead = true;
    expect(mode.onTick(both.state, both.context)).toMatchObject({ winner: null, resultKey: "eliminated" });
  });

  it("uses remaining health and armor as the timeout tiebreaker", () => {
    const mode = new Amphi();
    const fighters: Fighter[] = [
      { ownerId: 1, team: "udon", health: 70, armor: 30 },
      { ownerId: 2, team: "soba", health: 80, armor: 10 },
    ];
    const { state, context } = arena(fighters);
    mode.onTick(state, context);
    expect(mode.onRoundTimeExpired(state)).toMatchObject({ winner: "udon", resultKey: "timeout" });
    fighters[1].armor = 20;
    mode.onTick(state, context);
    expect(mode.onRoundTimeExpired(state)).toMatchObject({ winner: null, resultKey: "timeout" });
  });
});
