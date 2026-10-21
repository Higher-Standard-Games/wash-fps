// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { CommandRegistry } from "../../../../engine/console/CommandRegistry";
import { Cvar } from "../../../../engine/core/Cvar";
import { isGecko } from "../HudBlur";

afterEach(() => {
  Cvar.reset("hud_blur");
  vi.unstubAllGlobals();
});

it("detects Firefox by its -moz-appearance support", () => {
  vi.stubGlobal("CSS", { supports: (prop: string) => prop === "-moz-appearance" });
  expect(isGecko()).toBe(true);
  vi.stubGlobal("CSS", { supports: () => false });
  expect(isGecko()).toBe(false);
});

it("keeps blur on outside Firefox and lets the console turn it off and back on", async () => {
  const root = document.documentElement;
  expect(Cvar.getNumber("hud_blur")).toBe(1);
  expect(root.classList.contains("no-backdrop-blur")).toBe(false);
  expect(document.getElementById("hud-blur-style")?.textContent).toContain("backdrop-filter: none !important");

  const registry = CommandRegistry.getInstance();
  expect((await registry.executeChecked("hud_blur 0")).ok).toBe(true);
  expect(root.classList.contains("no-backdrop-blur")).toBe(true);
  expect((await registry.executeChecked("hud_blur 1")).ok).toBe(true);
  expect(root.classList.contains("no-backdrop-blur")).toBe(false);
});
