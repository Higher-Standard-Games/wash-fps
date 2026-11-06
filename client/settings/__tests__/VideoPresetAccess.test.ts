// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Cvar } from "../../../../../engine/core/Cvar";
import { RenderVars } from "../../../../../engine/rendering/RenderVars";
import { VIDEO_PRESETS } from "../SettingsModel";

beforeEach(() => {
  localStorage.clear();
  Reflect.set(Cvar, "cvars", new Map());
  Reflect.set(Cvar, "initialized", false);
  Reflect.set(Cvar, "consoleIntegration", null);
  Reflect.set(RenderVars, "instance", undefined);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 0),
  );
  Cvar.register("developer", 0);
});
afterEach(() => vi.unstubAllGlobals());

it.each(VIDEO_PRESETS)("keeps renderer choices in the $label preset writable at developer 0", (preset) => {
  const render = RenderVars.getInstance();
  for (const [name, value] of Object.entries(preset.values)) {
    if (!render.getVar(name)) continue;
    expect(Cvar.canEdit(name), name).toBe(true);
    expect(Cvar.set(name, value), name).toBe(true);
    expect(render.get(name), name).toBe(Number(value));
  }
});

it.each(["r_ambient", "r_wireframe", "r_water_debug", "r_ktx2", "r_daynight_time", "r_water_reflection"])(
  "blocks raw renderer tuning at developer 0: %s",
  (name) => {
    const render = RenderVars.getInstance();
    const before = render.get(name);
    expect(Cvar.set(name, 0)).toBe(false);
    expect(render.get(name)).toBe(before);
  },
);
