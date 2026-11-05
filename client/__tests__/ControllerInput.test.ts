// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { GamepadInput, type PadState } from "../../../../engine/input/GamepadInput";
import { InputDevice } from "../../../../engine/input/InputDevice";
import { InputSystem } from "../../../../engine/input/InputSystem";
import { enterPlay, inPlay, leavePlay } from "../../../../engine/input/PlayCapture";
import { UINavigation } from "../../../../engine/ui/navigation/UINavigation";
import { ControllerInput } from "../ControllerInput";
import { FPS, registerFPSActions } from "../FPSActions";

const camera = vi.hoisted(() => ({ setMoveAxis: vi.fn(), controllerLook: vi.fn() }));
vi.mock("../../../../engine/camera/CameraSystem", () => ({
  CameraSystem: { getInstance: () => ({ getActiveController: () => camera }) },
}));
vi.mock("../../../../engine/ui/MapLoadingOverlay", () => ({ MapLoadingOverlay: { isShowing: () => false } }));
const pad = GamepadInput.getInstance();
const snapshot = (held: number[] = [], axes = [0, 0, 0, 0]): PadState => ({
  index: 0,
  id: "Xbox",
  mapping: "standard",
  axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ value: held.includes(i) ? 1 : 0, pressed: held.includes(i) })),
});
let adapter: ControllerInput;
const frames = InputSystem.getInstance() as unknown as {
  updateActionStates(): void;
  clearPerFrameState(): void;
  releaseHeldInput(): void;
};
function tick(held: number[] = [], axes = [0, 0, 0, 0], seconds = 1 / 60): void {
  pad.sample([snapshot(held, axes)]);
  adapter.update(seconds);
  frames.updateActionStates();
}
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Cvar.set("in_touch", -1);
  InputDevice.getInstance().select("keyboard_mouse");
  pad.sample([]);
  pad.sample([snapshot()]);
  registerFPSActions();
  InputSystem.getInstance().resetAllBindings();
  adapter = new ControllerInput();
  adapter.start();
  Cvar.set("in_pad_move_deadzone", 0.15);
  Cvar.set("in_pad_look_deadzone", 0.12);
  Cvar.set("in_pad_swap", 0);
  tick();
  camera.controllerLook.mockClear();
  camera.setMoveAxis.mockClear();
});
afterEach(() => {
  adapter.stop();
  leavePlay();
  frames.releaseHeldInput();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("controller runtime", () => {
  it.each([false, true])("rearms after a menu using the configured stick dead zones (swap=%s)", (swap) => {
    Cvar.set("in_pad_move_deadzone", 0.3);
    Cvar.set("in_pad_look_deadzone", 0.2);
    Cvar.set("in_pad_swap", swap ? 1 : 0);
    InputDevice.getInstance().select("gamepad");
    enterPlay(null);
    tick();
    const axes = swap ? [0.18, 0, 0.25, 0] : [0.25, 0, 0.18, 0];
    const root = document.createElement("div");
    document.body.append(root);
    const off = UINavigation.getInstance().push({ root });
    tick([7], axes);
    off();
    root.remove();
    tick([7], axes);
    tick([], axes);
    tick([7], axes);
    expect(InputSystem.getInstance().isActive(FPS.FIRE)).toBe(true);
  });
  it("only backs out when Confirm and Back are pressed together", () => {
    InputDevice.getInstance().select("gamepad");
    const root = document.createElement("div");
    document.body.append(root);
    const back = vi.fn();
    const button = document.createElement("button");
    const confirm = vi.fn();
    button.onclick = confirm;
    root.append(button);
    const off = UINavigation.getInstance().push({ root, back });
    const rects = vi
      .spyOn(HTMLElement.prototype, "getClientRects")
      .mockImplementation(() => [document.body.getBoundingClientRect()] as unknown as DOMRectList);
    try {
      tick();
      tick([0, 1]);
      expect(back).toHaveBeenCalledOnce();
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      off();
      rects.mockRestore();
    }
  });
  it("releases gameplay and leaves play if an adapter subscriber fails", () => {
    adapter.stop();
    let callback: ((seconds: number) => void) | undefined;
    vi.spyOn(pad, "subscribe").mockImplementation((listener) => {
      callback = listener;
      return () => {};
    });
    adapter.start();
    InputDevice.getInstance().select("gamepad");
    enterPlay(null);
    tick();
    tick([7]);
    expect(InputSystem.getInstance().isActive(FPS.FIRE)).toBe(true);
    camera.controllerLook.mockImplementationOnce(() => {
      throw new Error("Camera failure");
    });
    expect(() => callback?.(1 / 60)).toThrow("Camera failure");
    frames.updateActionStates();
    expect(inPlay()).toBe(false);
    expect(InputSystem.getInstance().isActive(FPS.FIRE)).toBe(false);
    expect(camera.setMoveAxis).toHaveBeenLastCalledWith(null);
  });
  it("does not activate from connection or later input when the player started with keyboard", () => {
    tick([0]);
    expect(InputDevice.getInstance().current).toBe("keyboard_mouse");
    expect(InputSystem.getInstance().isActive(FPS.JUMP)).toBe(false);
    expect(inPlay()).toBe(false);
  });
  it("keeps controller mode through mouse movement and typing, with explicit selection to leave", () => {
    InputDevice.getInstance().start();
    InputDevice.getInstance().select("gamepad");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "w" }));
    const motion = Object.assign(new Event("pointermove"), { pointerType: "mouse", movementX: 40, movementY: 0 });
    window.dispatchEvent(motion);
    expect(InputDevice.getInstance().current).toBe("gamepad");
    InputDevice.getInstance().select("keyboard_mouse");
    expect(InputDevice.getInstance().current).toBe("keyboard_mouse");
  });
  it("starts play without pointer lock and releases held fire on disconnect", () => {
    InputDevice.getInstance().select("gamepad");
    enterPlay(null);
    tick();
    tick([7]);
    expect(inPlay()).toBe(true);
    expect(document.pointerLockElement).toBeFalsy();
    expect(InputSystem.getInstance().isActive(FPS.FIRE)).toBe(true);
    pad.sample([]);
    adapter.update(1 / 60);
    frames.updateActionStates();
    expect(inPlay()).toBe(false);
    expect(InputSystem.getInstance().isActive(FPS.FIRE)).toBe(false);
  });
  it("releases gameplay while typing and requires release before firing afterward", () => {
    InputDevice.getInstance().select("gamepad");
    enterPlay(null);
    tick();
    tick([7]);
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    tick([7]);
    expect(InputSystem.getInstance().isActive(FPS.FIRE)).toBe(false);
    field.blur();
    tick([7]);
    expect(InputSystem.getInstance().isActive(FPS.FIRE)).toBe(false);
    tick();
    tick([7]);
    expect(InputSystem.getInstance().isActive(FPS.FIRE)).toBe(true);
  });

  it("leaves play if a replacement pad takes the disconnected pad's place", () => {
    InputDevice.getInstance().select("gamepad");
    enterPlay(null);
    tick();
    tick([7]);
    pad.sample([{ ...snapshot([7]), index: 1, id: "Replacement pad" }]);
    adapter.update(1 / 60);
    frames.updateActionStates();
    expect(inPlay()).toBe(false);
    expect(InputSystem.getInstance().isActive(FPS.FIRE)).toBe(false);
  });

  it("does not carry a held confirm/fire through a UI scope", () => {
    InputDevice.getInstance().select("gamepad");
    enterPlay(null);
    tick();
    tick([7]);
    const root = document.createElement("div");
    document.body.append(root);
    const off = UINavigation.getInstance().push({ root });
    tick([7]);
    expect(InputSystem.getInstance().isActive(FPS.FIRE)).toBe(false);
    off();
    root.remove();
    tick([7]);
    tick([7]);
    expect(InputSystem.getInstance().isActive(FPS.FIRE)).toBe(false);
    tick();
    tick([7]);
    expect(InputSystem.getInstance().isActive(FPS.FIRE)).toBe(true);
  });
  it("turns by the same angle over one second at 30, 60, and 144 FPS", () => {
    InputDevice.getInstance().select("gamepad");
    enterPlay(null);
    tick();
    const totals = [30, 60, 144].map((fps) => {
      camera.controllerLook.mockClear();
      for (let i = 0; i < fps; i++) tick([], [0, 0, 1, 0], 1 / fps);
      return camera.controllerLook.mock.calls.reduce((total, [yaw]) => total + yaw, 0);
    });
    expect(totals[0]).toBeCloseTo((240 * Math.PI) / 180);
    expect(totals[1]).toBeCloseTo(totals[0]);
    expect(totals[2]).toBeCloseTo(totals[0]);
  });
});
