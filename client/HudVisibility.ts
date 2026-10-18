import { Cvar } from "../../../engine/core/Cvar";

function applyHudVisibility(value: unknown): void {
  if (typeof document !== "undefined") document.documentElement.dataset.clHud = Number(value) === 0 ? "0" : "1";
}

Cvar.register("cl_hud", 1, {
  type: "int",
  min: 0,
  max: 1,
  persist: false,
  description: "Show the game HUD (0 hides overlays for screenshots, 1 restores them)",
  onChange: applyHudVisibility,
});

applyHudVisibility(Cvar.get("cl_hud"));
