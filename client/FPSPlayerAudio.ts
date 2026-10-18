import { Cvar } from "../../../engine/core/Cvar";
import type { GameState } from "../../../engine/network/core/GameState";
import { getPlayerTeamSlot } from "./PlayerModelVisualSettings";

export const PLAYER_VOICE_SETS = ["male", "female", "bobot"] as const;
export type PlayerVoiceSet = (typeof PLAYER_VOICE_SETS)[number];
export type PlayerVoiceSide = "ally" | "enemy";
const VOICE_CVARS = { ally: "cl_team_ally_sounds", enemy: "cl_team_enemy_sounds" } as const;
const DEFAULTS: Record<PlayerVoiceSide, PlayerVoiceSet> = { ally: "male", enemy: "bobot" };
const CUES = ["pain25", "pain50", "pain75", "pain100", "death", "jump_1", "jump_2", "drown"] as const;
export type PlayerVoiceCue = (typeof CUES)[number];

export function registerPlayerAudioCvars(): void {
  for (const side of ["ally", "enemy"] as const) {
    Cvar.register(VOICE_CVARS[side], DEFAULTS[side], {
      type: "string",
      description: `${side === "ally" ? "Your side" : "Enemy"} player sounds: male, female, bobot`,
    });
  }
}

export function playerVoiceSet(side: PlayerVoiceSide): PlayerVoiceSet {
  const value = String(Cvar.get(VOICE_CVARS[side]) ?? DEFAULTS[side])
    .trim()
    .toLowerCase();
  return PLAYER_VOICE_SETS.includes(value as PlayerVoiceSet) ? (value as PlayerVoiceSet) : DEFAULTS[side];
}

export function setPlayerVoiceSet(side: PlayerVoiceSide, voice: PlayerVoiceSet): void {
  Cvar.set(VOICE_CVARS[side], voice);
}

/** Match the colour allegiance, relative to the local or followed POV. */
export function playerVoiceForEntity(state: GameState, entityId: string, viewEntityId?: string): PlayerVoiceSet {
  if (entityId === viewEntityId) return playerVoiceSet("ally");
  let team: string | undefined;
  let viewerTeam: string | undefined;
  for (const player of state.players.values()) {
    if (player.entityId === entityId) team = player.team;
    if (player.entityId === viewEntityId) viewerTeam = player.team;
  }
  return playerVoiceSet(getPlayerTeamSlot(team, viewerTeam) === "ally" ? "ally" : "enemy");
}

export function playerVoiceSound(cue: PlayerVoiceCue, voice: PlayerVoiceSet): string {
  return `sounds/players/${voice}/${cue}.ogg`;
}

export const FPS_PLAYER_SOUND_PATHS = PLAYER_VOICE_SETS.flatMap((voice) =>
  CUES.map((cue) => playerVoiceSound(cue, voice)),
);
