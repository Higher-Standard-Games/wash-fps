/**
 * Post-game screen server behavior:
 *  - winner computation (FFA top score, team score, ties → draw)
 *  - winner lifecycle (set entering PostGame, in snapshot, cleared on warmup)
 *  - input freeze while the post-game screen is up
 */

import type { PlayerId } from "@engine/server/ecs/types";
import { MatchPhase } from "@shared/server/gametype";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Deathmatch } from "../Deathmatch";
import { GametypeController } from "../GametypeController";
import { MatchState } from "../MatchState";

const P1 = 1 as PlayerId;
const P2 = 2 as PlayerId;

/** Drive a MatchState into the Active phase (so addScore counts). */
function activate(ms: MatchState): void {
  ms.transition(MatchPhase.Countdown);
  ms.transition(MatchPhase.Active);
}

describe("MatchState.computeWinner", () => {
  let ms: MatchState;

  beforeEach(() => {
    ms = new MatchState("Test");
    ms.addPlayer(P1);
    ms.addPlayer(P2);
    activate(ms);
  });

  it("FFA: top scorer wins with resolved name", () => {
    ms.addScore(P1, 12);
    ms.addScore(P2, 7);
    const w = ms.computeWinner(false, (pid) => (pid === P1 ? "Wraith" : "Other"));
    expect(w).toEqual({ kind: "player", id: "1", name: "Wraith" });
  });

  it("FFA: tied top score is a draw", () => {
    ms.addScore(P1, 5);
    ms.addScore(P2, 5);
    expect(ms.computeWinner(false).kind).toBe("draw");
  });

  it("FFA: negative scores still produce a winner (selfkill duels)", () => {
    ms.addScore(P1, -1);
    ms.addScore(P2, -3);
    const w = ms.computeWinner(false);
    expect(w.kind).toBe("player");
    expect(w.id).toBe("1");
  });

  it("team: higher team score wins with team name", () => {
    ms.setPlayerTeam(P1, "udon");
    ms.setPlayerTeam(P2, "soba");
    ms.addTeamScore("udon", 10);
    ms.addTeamScore("soba", 4);
    const w = ms.computeWinner(true);
    expect(w).toEqual({ kind: "team", id: "udon", name: "Team Udon" });
  });

  it("team: equal team scores are a draw", () => {
    ms.addTeamScore("udon", 6);
    ms.addTeamScore("soba", 6);
    expect(ms.computeWinner(true).kind).toBe("draw");
  });
});

describe("winner lifecycle", () => {
  it("is exposed in the snapshot during PostGame and cleared on warmup restart", () => {
    const ms = new MatchState("Test");
    ms.addPlayer(P1);
    ms.addPlayer(P2);
    activate(ms);
    ms.addScore(P1, 3);

    ms.endMatch();
    ms.computeWinner(false, () => "Wraith");
    expect(ms.phase).toBe(MatchPhase.PostGame);
    expect(ms.toSnapshot().winner).toEqual({ kind: "player", id: "1", name: "Wraith" });

    ms.restart(); // PostGame → Warmup
    expect(ms.winner).toBeNull();
    expect(ms.toSnapshot().winner).toBeUndefined();
  });
});

describe("bot auto-ready", () => {
  it("a registered bot readies up immediately (no waiting out warmup)", () => {
    const controller = new GametypeController(new Deathmatch());
    const ms = controller.getMatchState();
    ms.addPlayer(P1); // human
    ms.addPlayer(P2); // bot
    expect(ms.readyCount).toBe(0);

    controller.registerBot(P2);
    expect(ms.readyCount).toBe(1); // bot ready on join; match starts once the human readies
  });

  it("bots re-ready when post-game rolls over to a new warmup", () => {
    const controller = new GametypeController(new Deathmatch());
    const ms = controller.getMatchState();
    ms.addPlayer(P1);
    ms.addPlayer(P2);
    controller.registerBot(P2);

    ms.transition(MatchPhase.PostGame); // simulate a finished match
    const emptyState = { allEntities: () => [], getEntity: () => null, entitiesByType: () => [] } as never;
    // Tick past postGameDuration → restart() → Warmup (clears ready set),
    // then the controller's phase-change hook re-readies bots.
    controller.postTick(emptyState, ms.getConfig().postGameDuration + 1, 1 as never);

    expect(ms.phase).toBe(MatchPhase.Warmup);
    expect(ms.readyCount).toBe(1); // bot ready again for match #2
  });
});

describe("match pacing env overrides (dev/test)", () => {
  const ENV_KEYS = ["SHAG_TIMELIMIT", "SHAG_SCORELIMIT", "SHAG_WARMUP"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("SHAG_TIMELIMIT/SCORELIMIT/WARMUP override the gametype config", () => {
    process.env.SHAG_TIMELIMIT = "120";
    process.env.SHAG_SCORELIMIT = "3";
    process.env.SHAG_WARMUP = "10";
    const controller = new GametypeController(new Deathmatch());
    const config = controller.getMatchState().getConfig();
    expect(config.timeLimit).toBe(120);
    expect(config.scoreLimit).toBe(3);
    expect(config.warmupTimeout).toBe(10);
  });

  it("time values accept minute suffixes (Quake g_timelimit habit)", () => {
    process.env.SHAG_TIMELIMIT = "2m";
    process.env.SHAG_WARMUP = "30s";
    const controller = new GametypeController(new Deathmatch());
    const config = controller.getMatchState().getConfig();
    expect(config.timeLimit).toBe(120); // 2 minutes
    expect(config.warmupTimeout).toBe(30);
  });

  it("ignores invalid values and stays inert when unset", () => {
    process.env.SHAG_TIMELIMIT = "banana";
    const controller = new GametypeController(new Deathmatch());
    const config = controller.getMatchState().getConfig();
    expect(config.timeLimit).toBe(new Deathmatch().getMatchConfig().timeLimit);
    expect(config.scoreLimit).toBe(new Deathmatch().getMatchConfig().scoreLimit);
  });
});

describe("PostGame input freeze", () => {
  function makePlayerEntity(id: number) {
    return {
      id,
      ownerId: id as PlayerId,
      input: {
        forward: 1,
        right: -1,
        pitch: 0.2,
        yaw: 1.5,
        jump: true,
        crouch: true,
        attack: true,
        altAttack: true,
        use: true,
        buttons: 0xffff,
        weaponSlot: 2,
        sequence: 41,
        inputQueue: [{ forward: 1, right: 1, pitch: 0.2, yaw: 1.5, buttons: 0xffff, sequence: 42, weaponSlot: 3 }],
        lastProcessedSeq: 40,
        wantsRespawn: false,
      },
    };
  }

  function makeState(entities: ReturnType<typeof makePlayerEntity>[]) {
    return { allEntities: () => entities } as never;
  }

  it("zeroes movement/actions but keeps view angles and sequences", () => {
    const controller = new GametypeController(new Deathmatch());
    const ms = controller.getMatchState();
    ms.transition(MatchPhase.Countdown);
    ms.transition(MatchPhase.Active);
    ms.endMatch(); // → PostGame

    const player = makePlayerEntity(1);
    controller.applyPostGameInputFreeze(makeState([player]));

    expect(player.input.forward).toBe(0);
    expect(player.input.right).toBe(0);
    expect(player.input.buttons).toBe(0);
    expect(player.input.jump).toBe(false);
    expect(player.input.attack).toBe(false);
    expect(player.input.inputQueue[0].forward).toBe(0);
    expect(player.input.inputQueue[0].buttons).toBe(0);
    expect(player.input.inputQueue[0].weaponSlot).toBe(0);
    // Free-look + reconciliation must survive the freeze:
    expect(player.input.pitch).toBe(0.2);
    expect(player.input.yaw).toBe(1.5);
    expect(player.input.inputQueue[0].pitch).toBe(0.2);
    expect(player.input.inputQueue[0].sequence).toBe(42);
  });

  it("does nothing outside PostGame (warmup free-fight stays free)", () => {
    const controller = new GametypeController(new Deathmatch());
    const player = makePlayerEntity(1);
    controller.applyPostGameInputFreeze(makeState([player])); // phase = Warmup

    expect(player.input.forward).toBe(1);
    expect(player.input.buttons).toBe(0xffff);
    expect(player.input.inputQueue[0].buttons).toBe(0xffff);
  });
});
