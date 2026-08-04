/**
 * TeamColorBridge — publishes the team colours to CSS.
 *
 * The world reads team colour from cvars; every HUD and lobby surface used to
 * hardcode its own hex. That is two sources of truth for one fact, and they had
 * drifted into contradicting each other: a teammate rendered cyan in the map
 * while the scoreboard drew their side magenta.
 *
 * This publishes the cvars as custom properties on the document root, so the
 * stylesheets can say `var(--team-ally)` and be right by construction — and stay
 * right when the player edits the colours, because the cvars notify on change.
 *
 * Colours are ALLEGIANCE, not team identity: `--team-ally` is your side and
 * `--team-enemy` is anyone you can shoot, whichever names those sides have this
 * half. See `getPlayerTeamSlot`.
 */

import { Cvar } from "../../../engine/core/Cvar";
import {
  PLAYER_MODEL_VISUAL_DEFAULTS,
  parseRgbCvar,
  registerPlayerModelVisualCvars,
} from "./PlayerModelVisualSettings";

const BRIDGED: ReadonlyArray<{ cvar: string; property: string; slot: "ally" | "enemy" | "ffa" }> = [
  { cvar: "cl_team_ally_color", property: "--team-ally", slot: "ally" },
  { cvar: "cl_team_enemy_color", property: "--team-enemy", slot: "enemy" },
  { cvar: "cl_team_ffa_color", property: "--team-ffa", slot: "ffa" },
];

/**
 * Model tints are emissive multipliers and run past 1.0 — the shipped ally
 * colour is `1.55 0.2 1.35`. Clamping those to a byte would flatten every hue
 * toward white, and scaling them down would make a dimmed world tint produce a
 * near-black scoreboard header. The UI wants the HUE the player chose, at a
 * legible brightness, so normalise to the brightest channel and let CSS handle
 * the rest.
 */
function toCssColor(r: number, g: number, b: number): string {
  const peak = Math.max(r, g, b);
  if (!Number.isFinite(peak) || peak <= 0) return "#ffffff";
  const scale = 255 / peak;
  const channel = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * scale)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

let installed = false;

/** Publish the colours now, and keep publishing them when the player edits. */
export function installTeamColorBridge(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  registerPlayerModelVisualCvars();

  for (const { cvar, property, slot } of BRIDGED) {
    const publish = () => {
      const color = parseRgbCvar(Cvar.getString(cvar), PLAYER_MODEL_VISUAL_DEFAULTS[slot]);
      document.documentElement.style.setProperty(property, toCssColor(color.r, color.g, color.b));
    };
    publish();

    // Cvar has no subscribe API — the hook is a property on the instance. Chain
    // rather than assign, so whatever the world rendering already registered
    // keeps working.
    const instance = Cvar.getCvar(cvar);
    if (instance) {
      const previous = instance.onChange;
      instance.onChange = (value, oldValue) => {
        previous?.(value, oldValue);
        publish();
      };
    }
  }
}

/** Exported for tests — the normalisation is the part worth pinning. */
export const __testing = { toCssColor };
