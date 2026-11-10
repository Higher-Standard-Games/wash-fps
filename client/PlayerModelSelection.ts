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

/** A setting that draws a different model each game: enemies only. */
export type PlayerModelSetting = PlayerModelChoice | "random";

export function registerPlayerModelSelection(): void {
  Cvar.register(KEYS.ally, "police", {
    type: "string",
    persist: true,
    description: "Your side player model and voice: police, female, cartel, riotkitty, robot",
  });
  Cvar.register(KEYS.enemy, "random", {
    type: "string",
    persist: true,
    description: "Enemy player model and voice: random (a new one each game), police, female, cartel, riotkitty, robot",
  });
}

/** What the setting says, random included. */
export function playerModelSetting(side: PlayerModelSide): PlayerModelSetting {
  const value = Cvar.getString(KEYS[side]).trim().toLowerCase();
  if (side === "enemy" && value === "random") return "random";
  return PLAYER_MODELS.includes(value as PlayerModelChoice) ? (value as PlayerModelChoice) : "police";
}

let randomPick: PlayerModelChoice | null = null;

/** Deal the random enemy model again; each game you join draws its own. */
export function rerollRandomEnemyModel(): void {
  randomPick = null;
}

/** The model a side is drawn with; random is drawn once a game, never your own side's model. */
export function playerModelChoice(side: PlayerModelSide): PlayerModelChoice {
  const setting = playerModelSetting(side);
  if (setting !== "random") return setting;
  const own = playerModelChoice("ally");
  if (randomPick === null || randomPick === own) {
    const others = PLAYER_MODELS.filter((model) => model !== own);
    randomPick = others[Math.floor(Math.random() * others.length)];
  }
  return randomPick;
}

export function setPlayerModelChoice(side: PlayerModelSide, choice: PlayerModelSetting): void {
  Cvar.set(KEYS[side], choice);
}
