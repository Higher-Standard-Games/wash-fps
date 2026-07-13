import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { PlayerModelVisualStyle } from "../../../engine/animation/PlayerModelManager";
import { Cvar } from "../../../engine/core/Cvar";

export type PlayerTeamSlot = "alpha" | "beta" | "ffa";

const TEAM_COLOR_CVARS: Record<PlayerTeamSlot, string> = {
  alpha: "cl_team_alpha_color",
  beta: "cl_team_beta_color",
  ffa: "cl_team_ffa_color",
};

const TEAM_OUTLINE_CVARS: Record<PlayerTeamSlot, string> = {
  alpha: "cl_team_alpha_outline_color",
  beta: "cl_team_beta_outline_color",
  ffa: "cl_team_ffa_outline_color",
};

export const PLAYER_MODEL_VISUAL_DEFAULTS: Record<PlayerTeamSlot, Color3> = {
  alpha: new Color3(0.1, 1.15, 1.85),
  beta: new Color3(1.55, 0.2, 1.35),
  ffa: new Color3(0.1, 1.15, 1.85),
};

export const PLAYER_MODEL_OUTLINE_DEFAULTS: Record<PlayerTeamSlot, Color3> = {
  alpha: new Color3(0.16, 1.35, 2.2),
  beta: new Color3(1.85, 0.28, 1.65),
  ffa: new Color3(0.16, 1.35, 2.2),
};

const DEFAULT_OUTLINE_COLOR = PLAYER_MODEL_OUTLINE_DEFAULTS.ffa;
let cvarsRegistered = false;

function rgbToCvar(color: Color3): string {
  return `${color.r} ${color.g} ${color.b}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function parseRgbCvar(value: string, fallback: Color3): Color3 {
  const parts = value
    .trim()
    .split(/\s+/)
    .map((part) => Number(part));
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) {
    return fallback.clone();
  }
  return new Color3(parts[0], parts[1], parts[2]);
}

export function rgbCvarToHexValue(value: string, fallback: Color3 = DEFAULT_OUTLINE_COLOR): string {
  const color = parseRgbCvar(value, fallback);
  const toHex = (channel: number) => Math.round(clamp01(channel) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

export function hexToRgbCvar(hex: string): string {
  const normalized = hex.replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return "1 1 1";
  const r = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const g = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const b = Number.parseInt(normalized.slice(4, 6), 16) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`;
}

export function registerPlayerModelVisualCvars(): void {
  if (cvarsRegistered) return;
  cvarsRegistered = true;

  Cvar.register("cl_team_alpha_color", rgbToCvar(PLAYER_MODEL_VISUAL_DEFAULTS.alpha), {
    description: "Team Udon player model tint color as RGB floats.",
    persist: true,
  });
  Cvar.register("cl_team_beta_color", rgbToCvar(PLAYER_MODEL_VISUAL_DEFAULTS.beta), {
    description: "Team Soba player model tint color as RGB floats.",
    persist: true,
  });
  Cvar.register("cl_team_ffa_color", rgbToCvar(PLAYER_MODEL_VISUAL_DEFAULTS.ffa), {
    description: "FFA enemy player model tint color as RGB floats.",
    persist: true,
  });

  Cvar.register("cl_team_alpha_outline_color", rgbToCvar(PLAYER_MODEL_OUTLINE_DEFAULTS.alpha), {
    description: "Team Udon player model outline color as RGB floats.",
    persist: true,
  });
  Cvar.register("cl_team_beta_outline_color", rgbToCvar(PLAYER_MODEL_OUTLINE_DEFAULTS.beta), {
    description: "Team Soba player model outline color as RGB floats.",
    persist: true,
  });
  Cvar.register("cl_team_ffa_outline_color", rgbToCvar(PLAYER_MODEL_OUTLINE_DEFAULTS.ffa), {
    description: "FFA enemy player model outline color as RGB floats.",
    persist: true,
  });

  Cvar.register("cl_player_outline", 1, {
    type: "int",
    min: 0,
    max: 1,
    description: "Enable third-person player model outlines.",
    persist: true,
  });
  Cvar.register("cl_player_outline_size", 25, {
    type: "int",
    min: 0,
    max: 100,
    description: "Third-person player model outline size, 0-100.",
    persist: true,
  });
  Cvar.register("cl_player_fullbright", 0, {
    type: "int",
    min: 0,
    max: 1,
    description: "Enable a gentle emissive boost for third-person player models.",
    persist: true,
  });
  Cvar.register("cl_player_fullbright_intensity", 0.25, {
    type: "float",
    min: 0,
    max: 1,
    description: "Third-person player model fullbright boost intensity, 0-1.",
    persist: true,
  });
}

export function getPlayerTeamSlot(teamId: string | null | undefined): PlayerTeamSlot {
  if (teamId === "udon" || teamId === "alpha") return "alpha";
  if (teamId === "soba" || teamId === "beta" || teamId === "bravo") return "beta";
  return "ffa";
}

export function getPlayerModelVisualStyle(slot: PlayerTeamSlot, modelScale: number): PlayerModelVisualStyle {
  registerPlayerModelVisualCvars();

  const tintColor = parseRgbCvar(Cvar.getString(TEAM_COLOR_CVARS[slot]), PLAYER_MODEL_VISUAL_DEFAULTS[slot]);
  const outlineColor = parseRgbCvar(Cvar.getString(TEAM_OUTLINE_CVARS[slot]), PLAYER_MODEL_OUTLINE_DEFAULTS[slot]);
  const outlineSize = Math.max(0, Cvar.getNumber("cl_player_outline_size"));

  return {
    tintColor,
    fullbrightEnabled: Cvar.getBool("cl_player_fullbright"),
    fullbrightIntensity: Math.max(0, Math.min(1, Cvar.getNumber("cl_player_fullbright_intensity"))),
    outlineEnabled: Cvar.getBool("cl_player_outline") && outlineSize > 0,
    outlineColor,
    outlineWidth: outlineSize / Math.max(1, modelScale * 16),
  };
}

export function getPlayerModelVisualStyleKey(slot: PlayerTeamSlot): string {
  registerPlayerModelVisualCvars();
  return [
    slot,
    Cvar.getString(TEAM_COLOR_CVARS[slot]),
    Cvar.getString(TEAM_OUTLINE_CVARS[slot]),
    Cvar.get("cl_player_outline"),
    Cvar.get("cl_player_outline_size"),
    Cvar.get("cl_player_fullbright"),
    Cvar.get("cl_player_fullbright_intensity"),
  ].join("|");
}
