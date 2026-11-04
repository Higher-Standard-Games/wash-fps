// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { InputSystem } from "../../../../engine/input/InputSystem";
import { setTouchPlay } from "../../../../engine/input/PlayCapture";
import { FPS } from "../FPSActions";
import { edgeSpin, lookBoost, TouchControls } from "../TouchControls";

describe("touch look curves", () => {
  it("turns slow drags as dragged and fast ones up to 2.8 times as far", () => {
    expect(lookBoost(0.5, 1)).toBe(1);
    expect(lookBoost(10, 1)).toBeCloseTo(2.8);
    expect(lookBoost(10, 0)).toBe(1);
  });

  it("spins at the look side's edges, leftward only for a look drag", () => {
    expect(edgeSpin(0.7, true)).toBe(0);
    expect(edgeSpin(1, true)).toBe(1);
    expect(edgeSpin(0.965, false)).toBeCloseTo(0.5);
    expect(edgeSpin(0.42, true)).toBe(-1);
    expect(edgeSpin(0.42, false)).toBe(0);
  });
});

describe("touch controls", () => {
  const hud = { openChat: vi.fn(), showScoreboard: vi.fn(), hideScoreboard: vi.fn() };
  let controls: TouchControls;
  const root = () => document.querySelector<HTMLElement>(".touch-controls");
  const pointer = (type: string, target: Element, id = 1) =>
    target.dispatchEvent(
      Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        pointerId: id,
        pointerType: "touch",
        clientX: 0,
        clientY: 0,
      }),
    );

  beforeEach(() => {
    Cvar.set("in_touch", 1);
    controls = new TouchControls(hud);
  });

  afterEach(() => {
    controls.destroy();
    setTouchPlay(false);
    Cvar.set("in_touch", -1);
    vi.restoreAllMocks();
  });

  it("shows only in touch play, and not while the HUD is hidden", () => {
    expect(root()?.hidden).toBe(true);
    setTouchPlay(true);
    expect(root()?.hidden).toBe(false);
    controls.setHudHidden(true);
    expect(root()?.hidden).toBe(true);
    controls.setHudHidden(false);
    Cvar.set("in_touch", 0);
    expect(root()?.hidden).toBe(true);
  });

  it("holds fire while pressed, toggles aim on a tap and lets go of everything when hidden", () => {
    const held = vi.spyOn(InputSystem.getInstance(), "setVirtualAction");
    setTouchPlay(true);
    const fire = document.querySelector(".touch-btn--fire") as HTMLElement;
    const aim = document.querySelector(".touch-btn--aim") as HTMLElement;

    pointer("pointerdown", fire);
    expect(held).toHaveBeenLastCalledWith(FPS.FIRE, true);
    expect(fire.classList.contains("down")).toBe(true);
    pointer("pointerup", fire);
    expect(held).toHaveBeenLastCalledWith(FPS.FIRE, false);

    pointer("pointerdown", aim, 2);
    pointer("pointerup", aim, 2);
    expect(held).toHaveBeenLastCalledWith(FPS.AIM, true);
    expect(aim.classList.contains("on")).toBe(true);

    pointer("pointerdown", fire, 3);
    setTouchPlay(false);
    expect(held).toHaveBeenCalledWith(FPS.FIRE, false);
    expect(held).toHaveBeenLastCalledWith(FPS.AIM, false);
    expect(aim.classList.contains("on")).toBe(false);
  });
});
