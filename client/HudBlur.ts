/**
 * `hud_blur`: the frosted-glass blur (`backdrop-filter`) behind HUD panels,
 * menus and dialogs.
 *
 * Firefox's compositor re-blurs the game canvas behind every blurred panel on
 * every frame, and the in-game HUD alone has about ten of them. So it is off
 * by default on Firefox (Gecko) and on everywhere else; `hud_blur 1` brings it
 * back for an A/B. Panels keep their tinted background without it.
 */

import { Cvar } from "../../../engine/core/Cvar";

const CLASS = "no-backdrop-blur";

/** Gecko is the only engine that still understands -moz-appearance. */
export function isGecko(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("-moz-appearance", "none");
}

export function applyHudBlur(on: boolean, root: HTMLElement = document.documentElement): void {
  root.classList.toggle(CLASS, !on);
}

function installStyle(): void {
  if (document.getElementById("hud-blur-style")) return;
  const style = document.createElement("style");
  style.id = "hud-blur-style";
  // a little more opaque, since nothing behind the panel is softened any more
  style.textContent = `html.${CLASS} * { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
html.${CLASS} { --w-bg-card: hsla(240, 15%, 10%, 0.68); }`;
  document.head.appendChild(style);
}

if (typeof document !== "undefined") {
  installStyle();
  Cvar.register("hud_blur", isGecko() ? 0 : 1, {
    type: "int",
    min: 0,
    max: 1,
    description: "Blur behind HUD panels and menus. Off by default on Firefox, where it costs frame rate",
    onChange: (value) => applyHudBlur(Number(value) > 0),
  });
  applyHudBlur(Cvar.getNumber("hud_blur") > 0);
}
