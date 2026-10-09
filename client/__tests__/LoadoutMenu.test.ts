// @vitest-environment jsdom

/**
 * The Loadout key in the match menu, and the kit picker it opens. The key sits
 * right under Resume in a mode with kits; the picker says when a changed kit
 * applies, and Back or Esc returns without choosing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../hud/widgets/WeaponPreview", () => ({
  WeaponPreview: class {
    canvas = document.createElement("canvas");
    show() {
      return Promise.resolve();
    }
    resize() {}
    dispose() {}
  },
}));

import { FPSLoadoutPicker } from "../hud/widgets/LoadoutPicker";
import { FPSPauseMenu } from "../hud/widgets/PauseMenu";

afterEach(() => {
  document.body.replaceChildren();
});

describe("match menu mode keys", () => {
  it("puts the mode's keys right under Resume, and closes before acting", () => {
    const menu = new FPSPauseMenu();
    const onClick = vi.fn();
    menu.setModeKeys([{ id: "loadout", label: "Loadout", hint: "Rocket Launcher + Machinegun", onClick }]);
    menu.open();

    const keys = [...document.querySelectorAll<HTMLElement>(".fps-match-menu__keys > *")];
    const resume = keys.findIndex((key) => key.textContent?.includes("Resume"));
    const slot = keys.findIndex((key) => key.classList.contains("fps-match-menu__mode"));
    expect(slot).toBeGreaterThan(resume);
    expect(keys.slice(resume + 1, slot).every((key) => key.hidden)).toBe(true);

    const loadout = document.querySelector<HTMLButtonElement>('[data-mode-key="loadout"]');
    expect(loadout?.textContent).toContain("Rocket Launcher + Machinegun");
    loadout?.click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(menu.isOpen()).toBe(false);
    menu.destroy();
  });

  it("hides the slot in a mode that brings no keys", () => {
    const menu = new FPSPauseMenu();
    menu.setModeKeys([]);
    expect(document.querySelector<HTMLElement>(".fps-match-menu__mode")?.hidden).toBe(true);
    menu.destroy();
  });
});

describe("kit picker", () => {
  const confirmKey = () => document.querySelector<HTMLButtonElement>(".fps-loadout-confirm");

  it("joins without a way back, and says what it is for", () => {
    const picker = new FPSLoadoutPicker("Deathmatch");
    picker.open(() => {}, undefined, { timing: "respawn" });
    expect(confirmKey()?.textContent).toContain("Enter the match");
    expect(document.querySelector(".fps-loadout-back")).toBeNull();
    expect(document.querySelector(".fps-loadout-note")).toBeNull();
    picker.destroy();
  });

  it("changing a kit says when it applies, and Back or Esc keep the old one", () => {
    const picker = new FPSLoadoutPicker("Deathmatch");
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    picker.open(
      onConfirm,
      { primary: "electrobolt", secondary: "riotgun" },
      {
        timing: "respawn",
        changing: true,
        onCancel,
      },
    );
    expect(document.querySelector(".fps-loadout-note")?.textContent).toBe("Applies from your next spawn");
    expect(confirmKey()?.textContent).toContain("Use this kit");

    document.querySelector<HTMLButtonElement>(".fps-loadout-back")?.click();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(picker.isOpen).toBe(false);

    picker.open(onConfirm, undefined, { timing: "round", changing: true, onCancel });
    expect(document.querySelector(".fps-loadout-note")?.textContent).toBe("Applies from the next round");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
    picker.destroy();
  });

  it("confirms the kit on screen", () => {
    const picker = new FPSLoadoutPicker("Amphi");
    const onConfirm = vi.fn();
    picker.open(onConfirm, { primary: "voltaic", secondary: "plasmagun" }, { timing: "round" });
    confirmKey()?.click();
    expect(onConfirm).toHaveBeenCalledWith({ primary: "voltaic", secondary: "plasmagun" });
    picker.destroy();
  });
});
