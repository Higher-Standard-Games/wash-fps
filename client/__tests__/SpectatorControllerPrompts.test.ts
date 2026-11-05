// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { InputDevice } from "../../../../engine/input/InputDevice";
import { InputSystem } from "../../../../engine/input/InputSystem";
import { PLAY_CHANGE } from "../../../../engine/input/PlayCapture";
import { FPS, getActionKeyLabel, registerFPSActions } from "../FPSActions";
import { SpectatorOverlay } from "../SpectatorOverlay";
import { assignControllerButton, registerControllerSettings, resetController } from "../settings/ControllerModel";

let overlay: SpectatorOverlay;
beforeEach(() => {
  Cvar.set("in_touch", -1);
  registerFPSActions();
  registerControllerSettings();
  resetController();
  InputDevice.getInstance().select("keyboard_mouse");
  overlay = new SpectatorOverlay();
  overlay.setMode("freefly");
});
afterEach(() => {
  overlay.destroy();
  resetController();
  InputSystem.getInstance().resetAllBindings();
  InputDevice.getInstance().select("keyboard_mouse");
});

describe("spectator controller prompts", () => {
  const cue = () => [...document.querySelectorAll(".fps-spectator-key")].map((node) => node.textContent);
  it("refreshes when choosing controller mode and after remapping before resuming", () => {
    expect(cue()).toContain("MOUSE");
    InputDevice.getInstance().select("gamepad");
    expect(cue()).toContain("Right stick");
    expect(cue()).toContain("A");
    assignControllerButton(FPS.JUMP, 2);
    Cvar.set("in_pad_swap", 1);
    document.dispatchEvent(new Event(PLAY_CHANGE));
    expect(getActionKeyLabel(FPS.MOVE_FORWARD)).toBe("Right stick");
    expect(cue()).toContain("X");
    expect(cue()).not.toContain("A");
    expect(cue().slice(0, 2)).toEqual(["Right stick", "B"]);
    expect(cue()).toContain("Left stick");
  });
  it("shows remapped previous/next buttons while chasing a player", () => {
    InputDevice.getInstance().select("gamepad");
    assignControllerButton(FPS.WEAPON_PREV, 2);
    overlay.setMode("first-person");
    expect([...document.querySelectorAll(".fps-spectator-bar-key")].map((node) => node.textContent)).toEqual([
      "X",
      "RB",
    ]);
    assignControllerButton(FPS.WEAPON_NEXT, 3);
    overlay.setSpectatingTarget("Player");
    expect([...document.querySelectorAll(".fps-spectator-bar-key")].map((node) => node.textContent)).toEqual([
      "X",
      "Y",
    ]);
  });
});
