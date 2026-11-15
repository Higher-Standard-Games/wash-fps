import type { WorldState } from "@engine/server/core/WorldState";
import type { PlayerId } from "@engine/server/ecs/types";
import { MatchPhase } from "@shared/server/gametype";
import { describe, expect, it } from "vitest";
import { MatchState } from "../MatchState";
import { DEFAULT_SURVIVAL, Survival } from "../Survival";

/** Entities 1..n: entity 1 is the person, the rest robots; `dead` lists the dead ones. */
function world(robots: number, dead: number[] = []): WorldState {
  const players = Array.from({ length: robots + 1 }, (_, i) => ({
    id: i + 1,
    health: { dead: dead.includes(i + 1), health: 0, armor: 0 },
  }));
  return { players: () => players } as unknown as WorldState;
}

function survival() {
  const mode = new Survival(DEFAULT_SURVIVAL);
  mode.setPersonCheck((entityId) => entityId === 1);
  mode.setBotCheck((playerId) => (playerId as number) !== 1);
  return mode;
}

describe("survival", () => {
  it("keeps 4, 5, 6 then 7 robots, a minute a wave, the last to the end", () => {
    const mode = survival();
    expect([0, 59, 60, 119, 120, 180, 299].map((t) => mode.wave(t).robots)).toEqual([4, 4, 5, 5, 6, 7, 7]);
  });

  it("lets a robot back only while its wave has room, and a person always", () => {
    const mode = survival();
    // Robots 2-5 alive, 6-8 dead: the first wave is full
    const full = world(7, [6, 7, 8]);
    expect(mode.mayRespawn(6, full, 10)).toBe(false);
    expect(mode.mayRespawn(6, full, 70)).toBe(true);
    // One of the four killed: the next comes in
    expect(mode.mayRespawn(6, world(7, [5, 6, 7, 8]), 10)).toBe(true);
    expect(mode.mayRespawn(1, full, 10)).toBe(true);
  });

  it("spawns robots machine gun only, with the health of the wave they spawn in, people with the blade and a machine gun", () => {
    const mode = survival();
    let now = 0;
    mode.setMatchClock(() => now);
    expect(mode.getSpawnLoadout(2 as PlayerId)).toEqual({
      weapons: ["machinegun"],
      ammo: { machinegun: 200 },
      health: 30,
      armor: 0,
    });
    const healthAt = (seconds: number) => {
      now = seconds;
      return mode.getSpawnLoadout(2 as PlayerId).health;
    };
    expect([healthAt(70), healthAt(130), healthAt(200), healthAt(290)]).toEqual([40, 50, 50, 50]);
    expect(mode.getSpawnLoadout(1 as PlayerId).weapons).toEqual(["blade", "machinegun"]);
  });

  it("lets only people pick things up", () => {
    const mode = survival();
    expect(mode.mayPickUp(1)).toBe(true);
    expect(mode.mayPickUp(4)).toBe(false);
  });

  it("plays for its time, with no frag limit", () => {
    const config = survival().getMatchConfig();
    expect(config.timeLimit).toBe(300);
    expect(config.scoreLimit).toBe(0);
  });

  it("wins for the survivors when time runs out, frags or not", () => {
    const state = new MatchState(
      "Survival",
      { warmupTimeout: 0, countdownDuration: 0, timeLimit: 300, scoreLimit: 0 },
      true,
    );
    state.setSurvivors("soba");
    // A person on one side, a robot on the other
    state.addPlayer(1 as PlayerId);
    state.setPlayerTeam(1 as PlayerId, "soba");
    state.addPlayer(2 as PlayerId);
    state.setPlayerTeam(2 as PlayerId, "udon");
    state.transition(MatchPhase.Active);
    state.update(300.1);
    expect(state.phase).toBe(MatchPhase.PostGame);
    expect(state.teamScores.get("soba")).toBe(1);
    expect(state.teamScores.get("udon")).toBe(0);
  });

  it("wins for the survivors even when the other side has more points", () => {
    const state = new MatchState(
      "Survival",
      { warmupTimeout: 0, countdownDuration: 0, timeLimit: 300, scoreLimit: 0 },
      true,
    );
    state.setSurvivors("soba");
    state.addPlayer(1 as PlayerId);
    state.setPlayerTeam(1 as PlayerId, "soba");
    state.addPlayer(2 as PlayerId);
    state.setPlayerTeam(2 as PlayerId, "udon");
    state.transition(MatchPhase.Active);
    state.addTeamScore("soba", -2);
    state.addTeamScore("udon", 3);
    state.update(300.1);
    expect(state.teamScores.get("soba")).toBe(4);
  });

  it("loses for the survivors at their first death, however far ahead", () => {
    const state = new MatchState(
      "Survival",
      { warmupTimeout: 0, countdownDuration: 0, timeLimit: 300, scoreLimit: 0 },
      true,
    );
    state.setSurvivors("soba");
    state.addPlayer(1 as PlayerId);
    state.setPlayerTeam(1 as PlayerId, "soba");
    state.addPlayer(2 as PlayerId);
    state.setPlayerTeam(2 as PlayerId, "udon");
    state.transition(MatchPhase.Active);
    state.addTeamScore("soba", 12);
    // A robot dying settles nothing
    expect(state.survivorsFell(2 as PlayerId)).toBe(false);
    expect(state.survivorsFell(1 as PlayerId)).toBe(true);
    expect(state.phase).toBe(MatchPhase.PostGame);
    expect(state.teamScores.get("udon")).toBe(13);
  });

  it("heals people a point a second up to 100, and not robots", () => {
    const mode = survival();
    const bodies = [
      { id: 1, health: { dead: false, health: 40, armor: 0 } },
      { id: 2, health: { dead: false, health: 40, armor: 0 } },
      { id: 3, health: { dead: false, health: 100, armor: 0 } },
    ];
    const state = {
      players: () => bodies,
      getEntityMut: (id: number) => bodies.find((body) => body.id === id),
    } as unknown as WorldState;
    // Only on whole seconds
    mode.onTick(state, { tick: 61 } as never);
    expect(bodies[0].health.health).toBe(40);
    mode.onTick(state, { tick: 125 } as never);
    expect(bodies[0].health.health).toBe(41);
    expect(bodies[1].health.health).toBe(40);
    bodies[0].health.health = 99.5;
    mode.onTick(state, { tick: 250 } as never);
    expect(bodies[0].health.health).toBe(100);
  });

  it("hands robots their kits in turn: an aiming machine gun, a hipfire one, a grenade launcher", () => {
    const mode = survival();
    const kit = (id: number) => {
      const loadout = mode.getSpawnLoadout(id as PlayerId);
      return `${loadout.weapons.join("+")}${loadout.adsDisabled ? " hip" : ""}`;
    };
    expect([2, 3, 4, 5, 6].map(kit)).toEqual([
      "machinegun",
      "machinegun hip",
      "glauncher",
      "machinegun",
      "machinegun hip",
    ]);
    // A robot keeps its kit at its next spawn, and a person never gets one
    expect(kit(4)).toBe("glauncher");
    expect(mode.getSpawnLoadout(1 as PlayerId).adsDisabled).toBeUndefined();
  });
});
