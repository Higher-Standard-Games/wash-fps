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
});
