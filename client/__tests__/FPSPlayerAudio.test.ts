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
  setPlayerVoiceSet,
} from "../FPSPlayerAudio";

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
  Cvar.reset("cl_team_ally_sounds");
  Cvar.reset("cl_team_enemy_sounds");
  vi.clearAllMocks();
});
describe("player voice sides", () => {
  it("defaults to Male for self/allies and Bobot for enemies, using colour team aliases", () => {
    const state = roster(["udon", "bravo", "soba"]);
    expect(["p0", "p1", "p2"].map((id) => playerVoiceForEntity(state, id, "p0"))).toEqual(["male", "male", "bobot"]);
    expect(FPS_PLAYER_SOUND_PATHS).toHaveLength(24);
    expect(FPS_PLAYER_SOUND_PATHS.some((path) => path.includes("padpork"))).toBe(false);
  });
  it("treats everyone else in FFA as enemies and follows the watched player's side", () => {
    const ffa = roster(["", ""]);
    expect(playerVoiceForEntity(ffa, "p0", "p0")).toBe("male");
    expect(playerVoiceForEntity(ffa, "p1", "p0")).toBe("bobot");
    const team = roster(["udon", "soba", "alpha"]);
    expect(playerVoiceForEntity(team, "p2", "p1")).toBe("male");
    expect(playerVoiceForEntity(team, "p0", "p1")).toBe("bobot");
    expect(playerVoiceForEntity(team, "p1")).toBe("bobot");
  });
  it("applies Female immediately to pain, death and local drowning", () => {
    setPlayerVoiceSet("ally", "female");
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
  it("falls back safely for invalid console or stored values", () => {
    Cvar.set("cl_team_ally_sounds", "../../padpork");
    Cvar.set("cl_team_enemy_sounds", "missing");
    expect(playerVoiceSet("ally")).toBe("male");
    expect(playerVoiceSet("enemy")).toBe("bobot");
  });
});
