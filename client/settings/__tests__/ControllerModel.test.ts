// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { InputSystem } from "../../../../../engine/input/InputSystem";
import { FPS, registerFPSActions } from "../../FPSActions";
import {
  applyControllerPreset,
  assignControllerButton,
  controllerButtons,
  controllerKey,
  controllerPreset,
  registerControllerSettings,
  resetController,
} from "../ControllerModel";
import { assignKey, resetPage } from "../SettingsModel";

const input = InputSystem.getInstance();
beforeEach(() => {
  registerFPSActions();
  registerControllerSettings();
  input.resetAllBindings();
});
describe("controller mappings and existing settings", () => {
  it("adds defaults for an existing player's saved keyboard override, including explicit unbound keys", () => {
    input.importBindings({ [FPS.JUMP]: [], [FPS.FIRE]: [{ key: "KeyP" }] });
    expect(controllerButtons(FPS.JUMP)).toEqual([0]);
    expect(controllerButtons(FPS.FIRE)).toEqual([7]);
    expect(input.getBindingsForAction(FPS.JUMP)).toEqual([]);
    applyControllerPreset("bumper");
    expect(controllerPreset()).toBe("bumper");
    expect(input.getBindingsForAction(FPS.FIRE)).toEqual([{ key: "KeyP" }]);
  });
  it("preserves controller bindings when editing or resetting the keyboard, and vice versa", () => {
    assignControllerButton(FPS.JUMP, 3);
    assignKey("KeyP", FPS.JUMP);
    resetPage("controls");
    expect(controllerButtons(FPS.JUMP)).toEqual([3]);
    input.rebind(FPS.JUMP, [{ key: "KeyP" }]);
    resetController();
    expect(input.getBindingsForAction(FPS.JUMP)).toEqual([{ key: "KeyP" }]);
    expect(controllerButtons(FPS.JUMP)).toEqual([0]);
  });
  it("moves a conflicting button, preserves an explicit clear through import, and reserves Menu", () => {
    assignControllerButton(FPS.JUMP, 3);
    expect(controllerButtons(FPS.RELOAD)).toEqual([]);
    expect(controllerPreset()).toBeNull();
    assignControllerButton(FPS.FIRE, null);
    const exported = input.exportBindings();
    input.importBindings(exported);
    expect(controllerButtons(FPS.FIRE)).toEqual([]);
    expect(exported[controllerKey(FPS.FIRE)]).toEqual([]);
    assignControllerButton(FPS.JUMP, 9);
    expect(controllerButtons(FPS.JUMP)).toEqual([3]);
  });
  it("preserves unfamiliar valid bindings when the keyboard editor changes an action", () => {
    input.rebind(FPS.JUMP, [{ key: "KeyP" }, { gamepadButton: 0 }]);
    assignKey("KeyZ", FPS.JUMP);
    expect(input.getBindingsForAction(FPS.JUMP)).toContainEqual({ gamepadButton: 0 });
  });
});
