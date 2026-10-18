// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { CommandRegistry } from "../../../../engine/console/CommandRegistry";
import { Cvar } from "../../../../engine/core/Cvar";
import "../HudVisibility";

afterEach(() => Cvar.reset("cl_hud"));

it("toggles screenshot HUD visibility through the console without saving the hidden state", async () => {
  const registry = CommandRegistry.getInstance();
  expect((await registry.executeChecked("cl_hud 0")).ok).toBe(true);
  expect(document.documentElement.dataset.clHud).toBe("0");
  expect(Cvar.getCvar("cl_hud")?.flags.persist).toBe(false);
  expect((await registry.executeChecked("cl_hud 1")).ok).toBe(true);
  expect(document.documentElement.dataset.clHud).toBe("1");
});
