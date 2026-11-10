import {
  CARTEL_MODEL_ROOT,
  FEMALE_MODEL_ROOT,
  PLAYER_MODEL_FILE,
  PLAYER_MODEL_ROOT,
  RIOTKITTY_MODEL_ROOT,
  ROBOT_MODEL_ROOT,
} from "../../../engine/animation/PlayerModelAssets";
import { Cvar } from "../../../engine/core/Cvar";
import { LOOK_MODELS, type LookModel } from "../shared/players/PlayerLook";

export const PLAYER_MODELS = LOOK_MODELS;
export type PlayerModelChoice = LookModel;
export type PlayerModelSide = "ally" | "enemy";
export const PLAYER_MODEL_LABELS = {
  police: "Police",
  female: "Female Police",
  cartel: "Cartel",
  riotkitty: "RiotKitty",
  robot: "Robot",
} as const;
export const PLAYER_MODEL_VOICES = {
  police: "male",
  female: "female",
  cartel: "male",
  riotkitty: "female",
  robot: "bobot",
} as const;
export const PLAYER_MODEL_ASSETS = {
  police: { root: PLAYER_MODEL_ROOT, file: PLAYER_MODEL_FILE },
  female: { root: FEMALE_MODEL_ROOT, file: "female.glb" },
  cartel: { root: CARTEL_MODEL_ROOT, file: "cartel.glb" },
  riotkitty: { root: RIOTKITTY_MODEL_ROOT, file: "riotkitty.glb" },
  robot: { root: ROBOT_MODEL_ROOT, file: "robot.glb" },
} as const;
export const PLAYER_MODEL_PREVIEW_IMAGES: Record<PlayerModelChoice, string> = {
  police: "/images/player-models/police.webp",
  female: "/images/player-models/female.webp",
  cartel: "/images/player-models/cartel.webp",
  riotkitty: "/images/player-models/riotkitty.webp",
  robot: "/images/player-models/robot.webp",
};
const KEYS = { ally: "cl_team_ally_model", enemy: "cl_team_enemy_model" } as const;

export function registerPlayerModelSelection(): void {
  for (const side of ["ally", "enemy"] as const) {
    Cvar.register(KEYS[side], "police", {
      type: "string",
      persist: true,
      description: `${side === "ally" ? "Your side" : "Enemy"} player model and voice: police, female, cartel, riotkitty, robot`,
    });
  }
}
export function playerModelChoice(side: PlayerModelSide): PlayerModelChoice {
  const value = Cvar.getString(KEYS[side]).trim().toLowerCase();
  return PLAYER_MODELS.includes(value as PlayerModelChoice) ? (value as PlayerModelChoice) : "police";
}
export function setPlayerModelChoice(side: PlayerModelSide, choice: PlayerModelChoice): void {
  Cvar.set(KEYS[side], choice);
}
