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
import { resetSideColors, setSideColor, sideColor, sideColorsAreDefault, TEAM_COLORS } from "../SettingsModel";

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
  it("saves player sound selections and restores Male/Bobot with Gameplay reset", async () => {
    const root = view.getElement();
    click(root.querySelector('[data-settings-page="gameplay"]'));
    const own = root.querySelector<HTMLButtonElement>('button[aria-label="Your side sounds"]')!;
    const enemy = root.querySelector<HTMLButtonElement>('button[aria-label="Enemies sounds"]')!;
    // The list opens on the page itself, right under the field, and closes on a pick
    const choose = (field: HTMLButtonElement, label: string) => {
      click(field);
      const list = document.querySelector<HTMLElement>(".fps-set-menu")!;
      expect([...list.querySelectorAll("[role=option]")].map((o) => o.textContent)).toEqual([
        "Male",
        "Female",
        "Bobot",
      ]);
      expect(field.getAttribute("aria-expanded")).toBe("true");
      click(byText(list, "[role=option]", label));
      expect(document.querySelector(".fps-set-menu")).toBeNull();
    };
    choose(own, "Female");
    choose(enemy, "Male");
    await Promise.resolve();
    expect(Cvar.getString("cl_team_ally_sounds")).toBe("female");
    expect(own.textContent).toBe("Female");
    expect(JSON.parse(localStorage.getItem("engine_cvars")!).cl_team_ally_sounds).toBe("female");
    const reset = byText(root, ".raised-key--reset", "Reset page");
    click(reset);
    click(reset);
    expect(own.textContent).toBe("Male");
    expect(enemy.textContent).toBe("Bobot");
  });

  it("works the sound drop-down from the keyboard", () => {
    const root = view.getElement();
    click(root.querySelector('[data-settings-page="gameplay"]'));
    const own = root.querySelector<HTMLButtonElement>('button[aria-label="Your side sounds"]')!;
    const key = (k: string) => own.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("ArrowDown");
    expect(document.querySelector(".fps-set-menu")).not.toBeNull();
    key("End");
    key("Enter");
    expect(document.querySelector(".fps-set-menu")).toBeNull();
    expect(Cvar.getString("cl_team_ally_sounds")).toBe("bobot");
    key("Enter");
    key("Escape");
    expect(document.querySelector(".fps-set-menu")).toBeNull();
  });
  it("swaps default team colors when color blindness turns on, says so, and undoes", () => {
    if (!Cvar.exists("r_colorcorrection")) Cvar.register("r_colorcorrection", 0);
    if (!Cvar.exists("r_colorcorrection_strength")) Cvar.register("r_colorcorrection_strength", 1);
    Cvar.set("r_colorcorrection", 0);
    resetSideColors();
    view.destroy();
    view.getElement().remove();
    view = new FPSSettingsView();
    document.body.append(view.getElement());
    void view.refresh();
    const root = view.getElement();
    click(root.querySelector('[data-settings-page="video"]'));
    const notice = root.querySelector<HTMLElement>(".fps-set-notice");
    expect(notice?.hidden).toBe(true);
    click(root.querySelector('button[aria-label="Color blindness"]'));
    click(byText(document, ".fps-set-menu__option", "Green-weak"));
    expect(Cvar.getInt("r_colorcorrection")).toBe(2);
    expect(sideColor("ally")?.id).toBe("cyan");
    expect(sideColor("enemy")?.id).toBe("orange");
    expect(notice?.hidden).toBe(false);
    expect(notice?.textContent).toContain("Cyan for your side and Orange for enemies");
    click(notice?.querySelector(".fps-set-notice__undo"));
    expect(sideColorsAreDefault()).toBe(true);
    expect(notice?.hidden).toBe(true);

    // A player's own colors are left alone.
    Cvar.set("r_colorcorrection", 0);
    setSideColor("ally", TEAM_COLORS.find((color) => color.id === "lime")!);
    click(root.querySelector('button[aria-label="Color blindness"]'));
    click(byText(document, ".fps-set-menu__option", "Red-weak"));
    expect(sideColor("ally")?.id).toBe("lime");
    expect(notice?.hidden).toBe(true);
    resetSideColors();
    Cvar.set("r_colorcorrection", 0);
  });

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

  it("locks Video over a match, and resets leave video alone there", () => {
    view.destroy();
    view.getElement().remove();
    view = new FPSSettingsView({ inMatch: true });
    document.body.append(view.getElement());
    const root = view.getElement();

    click(root.querySelector('[data-settings-page="video"]'));
    expect(root.querySelector(".fps-set-locked")?.textContent).toContain("Video settings change in the lobby");
    const locked = root.querySelector<HTMLElement>(".fps-set-video__locked");
    expect(locked?.inert).toBe(true);
    expect(locked?.querySelector(".fps-set-presets")).toBeTruthy();
    expect(byText(root, ".raised-key--reset", "Reset page")?.hasAttribute("disabled")).toBe(true);

    Cvar.set("r_ssr", 1);
    Cvar.set("m_sensitivity", 4);
    const all = byText(root, ".raised-key--reset", "Reset all");
    click(all);
    click(all);
    expect(Cvar.getNumber("m_sensitivity")).toBe(1);
    expect(Cvar.getNumber("r_ssr")).toBe(1);
    expect(document.querySelector(".fps-set-toast")?.textContent).toBe("Everything but Video back to defaults");
    Cvar.reset("r_ssr");

    click(root.querySelector('[data-settings-page="controls"]'));
    expect(byText(root, ".raised-key--reset", "Reset page")?.hasAttribute("disabled")).toBe(false);
  });

  it("leaves Video open in the lobby", () => {
    const root = view.getElement();
    click(root.querySelector('[data-settings-page="video"]'));
    expect(root.querySelector(".fps-set-locked")).toBeNull();
    expect(root.querySelector(".fps-set-video__locked")).toBeNull();
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
    expect(Cvar.getNumber("r_picmip")).toBe(1);
    expect(smooth?.getAttribute("aria-pressed")).toBe("true");
    expect(view.getElement().querySelector(".fps-set-preset-status")?.textContent).toBe("Using Smooth");

    click(byText(view.getElement(), ".raised-key--preset", "Balanced"));
    expect(Cvar.getNumber("r_bloom")).toBe(1);
    expect(Cvar.getNumber("r_picmip")).toBe(0);
    click(byText(view.getElement(), ".raised-key--sect", "Advanced"));
    click(byText(view.getElement(), "button", "Flat color"));
    expect(Cvar.getNumber("r_picmip")).toBe(8);
    click(byText(view.getElement(), ".raised-key--preset", "Pretty"));
    expect(Cvar.getNumber("r_picmip")).toBe(0);
    click(byText(view.getElement(), ".raised-key--preset", "Balanced"));
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
