import { WorldState } from "@engine/server/core/WorldState";
import type { PlayerId } from "@engine/server/ecs/types";
import { MatchPhase } from "@shared/server/gametype";
import { describe, expect, it } from "vitest";
import { Deathmatch } from "../Deathmatch";
import { Duel } from "../Duel";
import { GametypeController } from "../GametypeController";
import { MatchState } from "../MatchState";
import { SearchAndDestroy } from "../SearchAndDestroy";

const P1 = 1 as PlayerId;
const P2 = 2 as PlayerId;
const P3 = 3 as PlayerId;

describe("player lifecycle bookkeeping", () => {
  it("preserves stats across spectate/rejoin and keeps add idempotent", () => {
    const match = new MatchState("Deathmatch");
    match.addPlayer(P1);
    match.addPlayer(P2);
    match.transition(MatchPhase.Countdown);
    match.transition(MatchPhase.Active);
    match.addScore(P1, 4);
    match.addDeath(P1);

    match.spectatePlayer(P1);
    expect(match.totalPlayers).toBe(1);
    match.addPlayer(P1);
    match.addPlayer(P1);

    expect(match.totalPlayers).toBe(2);
    expect(match.getScore(P1)).toBe(4);
    expect(match.getDeaths(P1)).toBe(1);
  });

  it("preserves an S&D loadout while spectating and clears it on disconnect", () => {
    const mode = new SearchAndDestroy();
    const controller = new GametypeController(mode);
    mode.setPlayerLoadout(P1, { primary: "rlauncher", secondary: "machinegun" });
    controller.getMatchState().addPlayer(P1);

    controller.onPlayerSpectate(P1);
    expect(mode.hasChosenLoadout(P1)).toBe(true);

    controller.onPlayerDisconnect(P1);
    expect(mode.hasChosenLoadout(P1)).toBe(false);
  });

  it("rolls back rejected Duel joins, including retries", () => {
    const controller = new GametypeController(new Duel());
    const state = new WorldState();
    controller.onPlayerJoin(P1, 1 as never, state, undefined, "one");
    controller.onPlayerJoin(P2, 2 as never, state, undefined, "two");

    expect(controller.onPlayerJoin(P3, 3 as never, state, undefined, "three")).toBeNull();
    expect(controller.getMatchState().totalPlayers).toBe(2);
    expect(controller.onPlayerJoin(P3, 3 as never, state, undefined, "three")).toBeNull();
    expect(controller.getMatchState().totalPlayers).toBe(2);
  });

  it("removes disconnected bots from readiness and ignores stale callbacks", () => {
    const controller = new GametypeController(new Deathmatch());
    const match = controller.getMatchState();
    match.addPlayer(P1);
    match.addPlayer(P2);
    match.addPlayer(P3);
    controller.registerBot(P2);

    controller.onPlayerDisconnect(P2);
    match.playerReady(P2);
    controller.onPlayerReady(P1);

    expect(match.totalPlayers).toBe(2);
    expect(match.readyCount).toBe(1);
    expect(match.phase).toBe(MatchPhase.Warmup);
  });

  it("puts FFA players on ffa, not spectator, and back to spectator when they watch", () => {
    const controller = new GametypeController(new Deathmatch());
    const state = new WorldState();
    const match = controller.getMatchState();
    controller.onPlayerJoin(P1, 1 as never, state, undefined, "one");
    expect(match.getPlayerTeam(P1)).toBe("ffa");

    controller.onPlayerSpectate(P1);
    expect(match.getPlayerTeam(P1)).toBe("spectator");
    controller.onPlayerJoin(P1, 1 as never, state, undefined, "one");
    expect(match.getPlayerTeam(P1)).toBe("ffa");
  });

  it("protects a fresh spawn from its own side only: two FFA players are enemies", () => {
    const hit = (controller: GametypeController) => {
      const inner = controller as unknown as {
        spawnTick: Map<number, number>;
        lastState: { getEntity(id: number): { ownerId: PlayerId } };
        allowDamage(event: { victimId: number; attackerId: number }, tick: number, window: number): boolean;
      };
      inner.spawnTick.set(2, 0);
      inner.lastState = { getEntity: (id) => ({ ownerId: id as PlayerId }) };
      return inner.allowDamage({ victimId: 2, attackerId: 1 }, 1, 100);
    };

    const ffa = new GametypeController(new Deathmatch());
    ffa.getMatchState().setPlayerTeam(P1, "ffa");
    ffa.getMatchState().setPlayerTeam(P2, "ffa");
    expect(hit(ffa)).toBe(true);

    const teams = new GametypeController(new SearchAndDestroy());
    teams.getMatchState().setPlayerTeam(P1, "udon");
    teams.getMatchState().setPlayerTeam(P2, "udon");
    expect(hit(teams)).toBe(false);
    teams.getMatchState().setPlayerTeam(P2, "soba");
    expect(hit(teams)).toBe(true);
  });
});
