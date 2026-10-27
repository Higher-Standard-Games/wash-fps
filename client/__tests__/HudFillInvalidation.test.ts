// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { HUDState } from "../HUDState";
import { FPSAmmoCounter } from "../hud/widgets/AmmoCounter";
import { FPSVitalsBlock } from "../hud/widgets/VitalsBlock";

function ammoState() {
  const state = new HUDState();
  state.currentWeapon = "machinegun";
  state.ammo = { machinegun: { clip: 15, reserve: 0 }, plasmagun: { clip: 15, reserve: 0 } };
  return state;
}

function ammoFill(widget: FPSAmmoCounter) {
  return widget.getElement().querySelector<HTMLElement>(".fps-value-bar-fill")!;
}

describe("ammo fill invalidation", () => {
  it("uses the new weapon's capacity even when clip and reserve match", () => {
    const widget = new FPSAmmoCounter();
    const state = ammoState();
    widget.update(state);
    expect(ammoFill(widget).style.transform).toBe("scaleX(0.5)");

    state.currentWeapon = "plasmagun";
    widget.update(state);
    expect(ammoFill(widget).style.transform).toBe("scaleX(0.3)");
    expect(widget.getElement().querySelector(".fps-ammo-weapon")?.textContent).toBe("PLASMAGUN");

    state.currentWeapon = "machinegun";
    widget.update(state);
    expect(ammoFill(widget).style.transform).toBe("scaleX(0.5)");
  });

  it("clamps empty, full and over-cap clips without changing layout width", () => {
    const widget = new FPSAmmoCounter();
    const state = ammoState();
    for (const [clip, fraction] of [
      [0, 0],
      [30, 1],
      [90, 1],
      [15, 0.5],
    ]) {
      state.ammo.machinegun = { clip, reserve: 90 };
      widget.update(state);
      expect(ammoFill(widget).style.transform).toBe(`scaleX(${fraction})`);
      expect(ammoFill(widget).style.width).toBe("");
      expect(widget.getElement().querySelector(".fps-ammo-number")?.textContent).toBe(String(clip));
    }
  });

  it("handles pooled ammo and an unlimited weapon after a clip weapon", () => {
    const widget = new FPSAmmoCounter();
    const state = ammoState();
    widget.update(state);
    state.currentWeapon = "rlauncher";
    state.ammo.rlauncher = 0;
    widget.update(state);
    expect(ammoFill(widget).style.transform).toBe("scaleX(0)");
    expect(widget.getElement().querySelector<HTMLElement>(".fps-ammo-reserve")?.style.display).toBe("none");

    state.currentWeapon = "blade";
    widget.update(state);
    expect(ammoFill(widget).style.transform).toBe("scaleX(1)");
    expect(widget.getElement().querySelector(".fps-ammo-number")?.textContent).toBe("INF");
  });

  it("flashes for spending ammo in the same weapon, not for switching weapons", () => {
    const widget = new FPSAmmoCounter();
    const state = ammoState();
    widget.update(state);
    state.ammo.plasmagun = { clip: 10, reserve: 0 };
    state.currentWeapon = "plasmagun";
    widget.update(state);
    expect(widget.getElement().classList.contains("fps-flash-loss")).toBe(false);

    state.ammo.plasmagun = { clip: 9, reserve: 0 };
    widget.update(state);
    expect(widget.getElement().classList.contains("fps-flash-loss")).toBe(true);
  });

  it("leaves unchanged ammo and vitals alone after a hidden-state catch-up", () => {
    const widgets = [new FPSAmmoCounter(), new FPSVitalsBlock()];
    const state = ammoState();
    state.armor = 63;
    for (const widget of widgets) {
      widget.update(state);
      widget.hide();
      state.health = 83;
      widget.show();
      widget.update(state);
      const observer = new MutationObserver(() => {});
      observer.observe(widget.getElement(), { subtree: true, childList: true, attributes: true, characterData: true });
      for (let tick = 0; tick < 5; tick++) widget.update(state);
      expect(observer.takeRecords()).toEqual([]);
      observer.disconnect();
      widget.destroy();
    }
  });
});

describe("armor plate fills", () => {
  it("fills each plate from the left and clamps armor while keeping fixed layout width", () => {
    const widget = new FPSVitalsBlock();
    const state = new HUDState();
    for (const [armor, expected] of [
      [-5, [0, 0, 0, 0]],
      [63, [1, 1, 0.52, 0]],
      [100, [1, 1, 1, 1]],
      [150, [1, 1, 1, 1]],
      [0, [0, 0, 0, 0]],
    ] as const) {
      state.armor = armor;
      widget.update(state);
      const fills = [...widget.getElement().querySelectorAll<HTMLElement>(".fps-vitals-armor-fill")];
      expect(fills.map((fill) => fill.style.transform)).toEqual(expected.map((fraction) => `scaleX(${fraction})`));
      expect(fills.map((fill) => fill.style.width)).toEqual(["", "", "", ""]);
    }
    widget.destroy();
  });
});
