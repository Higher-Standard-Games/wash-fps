// @vitest-environment jsdom

/**
 * The settings screen in a document: its pages, its resets that ask once, the
 * key menu, press-to-bind, and nothing left behind when it goes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cvar } from "../../../../../engine/core/Cvar";
import { InputSystem } from "../../../../../engine/input/InputSystem";
import { FPS } from "../../FPSActions";
import { FPSSettingsView } from "../FPSSettingsView";

let view: FPSSettingsView;
const input = InputSystem.getInstance();

const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  (element as HTMLElement).click();
};
const byText = (root: ParentNode, selector: string, text: string) =>
  [...root.querySelectorAll<HTMLElement>(selector)].find((element) => element.textContent?.trim().startsWith(text));

beforeEach(() => {
  view = new FPSSettingsView();
  document.body.append(view.getElement());
  input.resetAllBindings();
  void view.refresh();
});

afterEach(() => {
  view.destroy();
  view.getElement().remove();
  input.resetAllBindings();
});

describe("FPSSettingsView", () => {
  it("keeps slider values live while coalescing saved preferences until release", () => {
    Cvar.set("cl_fov", 90);
    const save = vi.spyOn(Storage.prototype, "setItem");
    try {
      const input = view.getElement().querySelector<HTMLInputElement>('input[aria-label="Field of view"]')!;
      for (const value of [95, 100]) {
        input.value = String(value);
        input.dispatchEvent(new Event("input"));
        expect(Cvar.getNumber("cl_fov")).toBe(value);
      }
      expect(save).not.toHaveBeenCalled();
      input.dispatchEvent(new Event("change"));
      expect(save).toHaveBeenCalledTimes(2);
      expect(JSON.parse(localStorage.getItem("engine_cvars")!).cl_fov).toBe(100);
    } finally {
      save.mockRestore();
    }
  });

  it("offers FPS and speed toggles and restores both with Gameplay reset", async () => {
    const root = view.getElement();
    click(root.querySelector('[data-settings-page="gameplay"]'));
    for (const [label, cvar] of [
      ["FPS counter", "show_fps"],
      ["Movement speed", "cl_showspeed"],
    ]) {
      const group = root.querySelector(`[role="group"][aria-label="${label}"]`)!;
      click(byText(group, "button", "Off"));
      await Promise.resolve();
      expect(Cvar.getNumber(cvar)).toBe(0);
      expect(byText(group, "button", "Off")?.getAttribute("aria-pressed")).toBe("true");
    }
    const reset = byText(root, ".raised-key--reset", "Reset page");
    click(reset);
    click(reset);
    expect(Cvar.getNumber("show_fps")).toBe(1);
    expect(Cvar.getNumber("cl_showspeed")).toBe(1);
  });

  it("shows one page at a time, named in its title", () => {
    const root = view.getElement();
    expect(root.querySelector("h1")?.textContent).toBe("Controls");

    click(root.querySelector('[data-settings-page="video"]'));

    expect(view.currentPage).toBe("video");
    expect(root.querySelector("h1")?.textContent).toBe("Video");
    expect(root.querySelector<HTMLElement>('[data-settings-pane="video"]')?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-settings-pane="controls"]')?.hidden).toBe(true);
    expect(root.querySelector('[data-settings-page="video"]')?.getAttribute("aria-current")).toBe("page");
  });

  it("hands its page keys to a host that shows them elsewhere", () => {
    const nav = view.takePageNav();
    expect(nav.querySelectorAll("[data-settings-page]")).toHaveLength(4);
    expect(view.getElement().classList.contains("fps-set-view--nav-outside")).toBe(true);
  });

  it("resets only on the second press", () => {
    Cvar.set("m_sensitivity", 4);
    const reset = byText(view.getElement(), ".raised-key--reset", "Reset page");

    click(reset);
    expect(Cvar.getNumber("m_sensitivity")).toBe(4);
    expect(reset?.textContent).toContain("Sure? Controls");

    click(reset);
    expect(Cvar.getNumber("m_sensitivity")).toBe(1);
    expect(reset?.textContent).toContain("Reset page");
    expect(document.querySelector(".fps-set-toast")?.textContent).toBe("Controls back to defaults");
  });

  it("gives a key an action from its menu", () => {
    click(view.getElement().querySelector('.fps-set-cap[data-code="KeyH"]'));
    const menu = document.querySelector<HTMLElement>(".fps-set-pop");
    expect(menu?.hidden).toBe(false);

    click(byText(menu!, ".fps-set-opt", "Jump"));

    expect(menu?.hidden).toBe(true);
    expect(input.getBindingsForAction(FPS.JUMP)).toEqual([{ key: "Space" }, { key: "KeyH" }]);
    expect(view.getElement().querySelector('.fps-set-cap[data-code="KeyH"]')?.classList.contains("is-bound")).toBe(
      true,
    );
  });

  it("takes the next key pressed for a waiting action, and Esc gives up", () => {
    const row = () => view.getElement().querySelector(`.fps-set-act[data-action="${FPS.RELOAD}"]`);
    click(row());
    expect(row()?.classList.contains("is-listening")).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyG" }));
    expect(input.getBindingsForAction(FPS.RELOAD)).toEqual([{ key: "KeyR" }, { key: "KeyG" }]);
    expect(row()?.classList.contains("is-listening")).toBe(false);

    click(row());
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyV" }));
    expect(input.getBindingsForAction(FPS.RELOAD)).toEqual([{ key: "KeyR" }, { key: "KeyG" }]);
  });

  it("says a fixed key cannot be changed rather than opening its menu", () => {
    click(view.getElement().querySelector('.fps-set-cap[data-code="Tab"]'));
    expect(document.querySelector<HTMLElement>(".fps-set-pop")?.hidden).toBe(true);
    expect(document.querySelector(".fps-set-toast")?.textContent).toContain("Tab always opens the scoreboard");
  });

  it("marks the preset in use, and a mix of one's own", () => {
    click(view.getElement().querySelector('[data-settings-page="video"]'));
    const smooth = byText(view.getElement(), ".raised-key--preset", "Smooth");
    click(smooth);
    expect(Cvar.getNumber("r_bloom")).toBe(0);
    expect(smooth?.getAttribute("aria-pressed")).toBe("true");
    expect(view.getElement().querySelector(".fps-set-preset-status")?.textContent).toBe("Using Smooth");

    click(byText(view.getElement(), ".raised-key--preset", "Balanced"));
    expect(Cvar.getNumber("r_bloom")).toBe(1);
  });

  it("leaves nothing in the document when it goes", () => {
    click(view.getElement().querySelector('.fps-set-cap[data-code="Tab"]'));
    view.destroy();
    expect(document.querySelector(".fps-set-pop")).toBeNull();
    expect(document.querySelector(".fps-set-toast")).toBeNull();

    // Its key listeners are gone too
    const before = input.exportBindings();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyG" }));
    expect(input.exportBindings()).toEqual(before);
    view = new FPSSettingsView();
  });
});
