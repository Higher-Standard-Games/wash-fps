import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { PlayerModelVisualStyle } from "../../../engine/animation/PlayerModelManager";
import { Cvar } from "../../../engine/core/Cvar";

/**
 * Who a player is TO YOU, not which team they are on.
 *
 * Team colour is relative on purpose: your own side is pink and everyone you
 * may shoot is cyan, so the question a colour answers in a firefight is "can I
 * shoot this" rather than "which of two names is this". An absolute
 * udon-is-always-X scheme cannot answer that — you would have to remember which
 * side you are on this half, at the exact moment you have no attention to spare.
 *
 * It also makes the UI and the world agree by construction: both derive from
 * the same allegiance, so there is no mapping left to get backwards.
 */
export type PlayerTeamSlot = "ally" | "enemy" | "ffa";

const TEAM_COLOR_CVARS: Record<PlayerTeamSlot, string> = {
  ally: "cl_team_ally_color",
  enemy: "cl_team_enemy_color",
  ffa: "cl_team_ffa_color",
};

const TEAM_OUTLINE_CVARS: Record<PlayerTeamSlot, string> = {
  ally: "cl_team_ally_outline_color",
  enemy: "cl_team_enemy_outline_color",
  ffa: "cl_team_ffa_outline_color",
};

/** Pink for your own side; cyan for anyone you can shoot. */
export const PLAYER_MODEL_VISUAL_DEFAULTS: Record<PlayerTeamSlot, Color3> = {
  ally: new Color3(1.55, 0.2, 1.35),
  enemy: new Color3(0.1, 1.15, 1.85),
  ffa: new Color3(0.1, 1.15, 1.85),
};

export const PLAYER_MODEL_OUTLINE_DEFAULTS: Record<PlayerTeamSlot, Color3> = {
  ally: new Color3(1.85, 0.28, 1.65),
  enemy: new Color3(0.16, 1.35, 2.2),
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
  const toHex = (channel: number) =>
    Math.round(clamp01(channel) * 255)
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

  Cvar.register("cl_team_ally_color", rgbToCvar(PLAYER_MODEL_VISUAL_DEFAULTS.ally), {
    description: "Teammate tint color as RGB floats.",
    persist: true,
  });
  Cvar.register("cl_team_enemy_color", rgbToCvar(PLAYER_MODEL_VISUAL_DEFAULTS.enemy), {
    description: "Enemy tint color as RGB floats.",
    persist: true,
  });
  Cvar.register("cl_team_ffa_color", rgbToCvar(PLAYER_MODEL_VISUAL_DEFAULTS.ffa), {
    description: "FFA enemy player model tint color as RGB floats.",
    persist: true,
  });

  Cvar.register("cl_team_ally_outline_color", rgbToCvar(PLAYER_MODEL_OUTLINE_DEFAULTS.ally), {
    description: "Teammate outline color as RGB floats.",
    persist: true,
  });
  Cvar.register("cl_team_enemy_outline_color", rgbToCvar(PLAYER_MODEL_OUTLINE_DEFAULTS.enemy), {
    description: "Enemy outline color as RGB floats.",
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
  Cvar.register("cl_player_outline_proxy", 0, {
    type: "int",
    min: 0,
    max: 1,
    persist: false,
    description: "Experimental reduced player outline geometry (requires benchmark:outline-proxy:build).",
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

/**
 * Resolve a player to ally / enemy / ffa, from the viewer's side.
 *
 * No local team (spectating, warmup before joining, or a mode without teams)
 * means nobody is an ally, so everyone renders in the FFA colour — which is the
 * enemy colour, and correct: in a free-for-all everyone IS the enemy.
 */
export function getPlayerTeamSlot(teamId: string | null | undefined, localTeamId?: string | null): PlayerTeamSlot {
  const them = canonicalTeam(teamId);
  const me = canonicalTeam(localTeamId);
  if (!me || !them || me === "spectator" || them === "spectator") return "ffa";
  return them === me ? "ally" : "enemy";
}

/** Fold the lobby's and the BSP's team names onto the match's two. */
function canonicalTeam(teamId: string | null | undefined): string | null {
  switch ((teamId ?? "").trim().toLowerCase()) {
    case "udon":
    case "bravo":
      return "udon";
    case "soba":
    case "alpha":
    case "beta":
      return "soba";
    case "spectator":
      return "spectator";
    default:
      return null;
  }
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
