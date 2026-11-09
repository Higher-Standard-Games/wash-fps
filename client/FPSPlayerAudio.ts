import type { GameState } from "../../../engine/network/core/GameState";
import {
  PLAYER_MODEL_VOICES,
  playerModelChoice,
  registerPlayerModelSelection,
  setPlayerModelChoice,
} from "./PlayerModelSelection";
import { getPlayerTeamSlot } from "./PlayerModelVisualSettings";

export const PLAYER_VOICE_SETS = ["male", "female", "bobot"] as const;
export type PlayerVoiceSet = (typeof PLAYER_VOICE_SETS)[number];
export type PlayerVoiceSide = "ally" | "enemy";
const CUES = ["pain25", "pain50", "pain75", "pain100", "death", "jump_1", "jump_2", "drown"] as const;
export type PlayerVoiceCue = (typeof CUES)[number];

export function registerPlayerAudioCvars(): void {
  registerPlayerModelSelection();
}

export function playerVoiceSet(side: PlayerVoiceSide): PlayerVoiceSet {
  return PLAYER_MODEL_VOICES[playerModelChoice(side)];
}

export function setPlayerVoiceSet(side: PlayerVoiceSide, voice: PlayerVoiceSet): void {
  setPlayerModelChoice(side, voice === "female" ? "female" : voice === "bobot" ? "robot" : "police");
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
