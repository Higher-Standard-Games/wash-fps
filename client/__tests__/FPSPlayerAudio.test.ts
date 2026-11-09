// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { GameState, PlayerState } from "../../../../engine/network/core/GameState";

const audio = { playSfx2D: vi.fn(), playSfx3D: vi.fn() };
vi.mock("../../../../engine/AudioManager", () => ({ AudioManager: { getInstance: () => audio } }));

import { playPlayerDeathSound, playPlayerPainSound } from "../FPSCombatAudio";
import { playDrownGasp } from "../FPSLiquidAudio";
import {
  FPS_PLAYER_SOUND_PATHS,
  playerVoiceForEntity,
  playerVoiceSet,
  registerPlayerAudioCvars,
} from "../FPSPlayerAudio";
import { playerModelChoice, setPlayerModelChoice } from "../PlayerModelSelection";

function roster(teams: string[]): GameState {
  const state = new GameState();
  teams.forEach((team, index) => {
    const player = new PlayerState();
    player.entityId = `p${index}`;
    player.team = team;
    state.players.set(`p${index}`, player);
  });
  return state;
}
beforeEach(() => {
  Cvar.init();
  registerPlayerAudioCvars();
  Cvar.reset("cl_team_ally_model");
  Cvar.reset("cl_team_enemy_model");
  vi.clearAllMocks();
});
describe("player voice sides", () => {
  it("defaults to Male for self/allies and Male for enemies, using colour team aliases", () => {
    const state = roster(["udon", "bravo", "soba"]);
    expect(["p0", "p1", "p2"].map((id) => playerVoiceForEntity(state, id, "p0"))).toEqual(["male", "male", "male"]);
    expect(FPS_PLAYER_SOUND_PATHS).toHaveLength(24);
    expect(FPS_PLAYER_SOUND_PATHS.some((path) => path.includes("padpork"))).toBe(false);
  });
  it("treats everyone else in FFA as enemies and follows the watched player's side", () => {
    setPlayerModelChoice("enemy", "female");
    const ffa = roster(["", ""]);
    expect(playerVoiceForEntity(ffa, "p0", "p0")).toBe("male");
    expect(playerVoiceForEntity(ffa, "p1", "p0")).toBe("female");
    const team = roster(["udon", "soba", "alpha"]);
    expect(playerVoiceForEntity(team, "p2", "p1")).toBe("male");
    expect(playerVoiceForEntity(team, "p0", "p1")).toBe("female");
    expect(playerVoiceForEntity(team, "p1")).toBe("female");
  });
  it("applies Female immediately to pain, death and local drowning", () => {
    setPlayerModelChoice("ally", "female");
    expect(playerModelChoice("ally")).toBe("female");
    const event = { entityId: "voice-test", damage: 30, painTier: 1 };
    playPlayerPainSound(event as never, true, 1000);
    playPlayerDeathSound(event as never, true);
    playDrownGasp();
    expect(audio.playSfx2D.mock.calls.map((call) => call[0])).toEqual([
      "sounds/players/female/pain50.ogg",
      "sounds/players/female/death.ogg",
      "sounds/players/female/drown.ogg",
    ]);
  });
  it("pairs Cartel with male sounds independently on each side", () => {
    Cvar.set("cl_team_ally_model", "cartel");
    Cvar.set("cl_team_enemy_model", "female");
    const state = roster(["udon", "soba"]);
    expect(playerVoiceForEntity(state, "p0", "p0")).toBe("male");
    expect(playerVoiceForEntity(state, "p1", "p0")).toBe("female");
  });

  it("pairs RiotKitty with female sounds while retaining Cartel's male voice", () => {
    setPlayerModelChoice("ally", "riotkitty");
    setPlayerModelChoice("enemy", "cartel");
    const state = roster(["udon", "soba"]);
    expect(playerVoiceForEntity(state, "p0", "p0")).toBe("female");
    expect(playerVoiceForEntity(state, "p1", "p0")).toBe("male");
    playPlayerDeathSound({ entityId: "riotkitty-test" } as never, true);
    expect(audio.playSfx2D).toHaveBeenCalledWith("sounds/players/female/death.ogg", 0.9, 1, "players");
  });

  it("pairs Robot with Bobot for enemies and local player cues", () => {
    setPlayerModelChoice("enemy", "robot");
    expect(playerVoiceForEntity(roster(["udon", "soba"]), "p1", "p0")).toBe("bobot");
    setPlayerModelChoice("ally", "robot");
    playPlayerDeathSound({ entityId: "robot-test" } as never, true);
    expect(audio.playSfx2D).toHaveBeenCalledWith("sounds/players/bobot/death.ogg", 0.9, 1, "players");
    expect(playerVoiceSet("ally")).toBe("bobot");
  });

  it("falls back safely for invalid console or stored values", () => {
    Cvar.set("cl_team_ally_model", "../../padpork");
    Cvar.set("cl_team_enemy_model", "missing");
    expect(playerVoiceSet("ally")).toBe("male");
    expect(playerVoiceSet("enemy")).toBe("male");
  });
});
