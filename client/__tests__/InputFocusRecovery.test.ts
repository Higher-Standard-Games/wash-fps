// @vitest-environment jsdom

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputSystem } from "../../../../engine/input/InputSystem";
import { FPS, registerFPSActions } from "../FPSActions";

describe("input focus recovery", () => {
  const input = InputSystem.getInstance();
  let engine: NullEngine;
  let scene: Scene;
  let canvas: HTMLCanvasElement;
  const key = (type: "keydown" | "keyup", code: string) => document.dispatchEvent(new KeyboardEvent(type, { code }));
  const beginFrame = () => scene.onBeforeRenderObservable.notifyObservers(scene);
  const endFrame = () => scene.onAfterRenderObservable.notifyObservers(scene);
  const pointer = (type: string, buttons: number, target: EventTarget = canvas, pointerType = "mouse") => {
    const event = new MouseEvent(type, { buttons, bubbles: true, cancelable: true });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: pointerType } });
    target.dispatchEvent(event);
  };
  const pointerLock = (element: Element | null) => {
    Object.defineProperty(document, "pointerLockElement", { configurable: true, value: element });
    document.dispatchEvent(new Event("pointerlockchange"));
  };
  const visibility = (value: "hidden" | "visible") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const touch = (type: string, ids: number[]) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, "changedTouches", {
      value: ids.map((identifier) => ({ identifier, clientX: identifier * 10, clientY: 20 })),
    });
    canvas.dispatchEvent(event);
  };

  beforeEach(() => {
    input.dispose();
    document.body.replaceChildren();
    localStorage.clear();
    visibility("visible");
    pointerLock(null);
    engine = new NullEngine();
    scene = new Scene(engine);
    canvas = document.body.appendChild(document.createElement("canvas"));
    input.resetAllBindings();
    registerFPSActions();
    input.setContext("fps_gameplay");
    input.init(scene, canvas);
  });

  afterEach(() => {
    input.dispose();
    scene.dispose();
    engine.dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it.each(["blur", "hidden"])("releases movement and firing after %s without requiring missed keyups", (cause) => {
    key("keydown", "KeyW");
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    beginFrame();
    expect(input.isActive(FPS.MOVE_FORWARD)).toBe(true);
    expect(input.isActive(FPS.FIRE)).toBe(true);
    endFrame();

    if (cause === "blur") window.dispatchEvent(new Event("blur"));
    else visibility("hidden");
    // Reset is immediate, before the next rAF (which may be throttled).
    expect(input.isKeyDown("KeyW")).toBe(false);
    expect(input.isActive(FPS.MOVE_FORWARD)).toBe(false);
    expect(input.isActive(FPS.FIRE)).toBe(false);
    visibility("visible");
    beginFrame();
    expect(input.wasReleased(FPS.MOVE_FORWARD)).toBe(true);
    expect(input.wasReleased(FPS.FIRE)).toBe(true);
    expect(input.wasPressed(FPS.FIRE)).toBe(false);
    endFrame();
    beginFrame();
    expect(input.wasReleased(FPS.MOVE_FORWARD)).toBe(false);
    expect(input.isActive(FPS.MOVE_FORWARD)).toBe(false);
    endFrame();

    key("keydown", "KeyW");
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    beginFrame();
    expect(input.isActive(FPS.MOVE_FORWARD)).toBe(true);
    expect(input.wasPressed(FPS.FIRE)).toBe(true);
  });

  it("clears holds on pointer unlock and does not resurrect them on recapture", () => {
    pointerLock(canvas);
    key("keydown", "KeyW");
    beginFrame();
    endFrame();
    pointerLock(null);
    expect(input.isKeyDown("KeyW")).toBe(false);
    pointerLock(canvas);
    beginFrame();
    expect(input.isActive(FPS.MOVE_FORWARD)).toBe(false);
    expect(input.wasReleased(FPS.MOVE_FORWARD)).toBe(true);
  });

  it("accepts mouse releases outside the canvas even when propagation is stopped", () => {
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    beginFrame();
    endFrame();
    const outside = document.body.appendChild(document.createElement("button"));
    outside.addEventListener("mouseup", (event) => event.stopPropagation());
    outside.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    beginFrame();
    expect(input.isActive(FPS.FIRE)).toBe(false);
    expect(input.wasReleased(FPS.FIRE)).toBe(true);
    endFrame();
    // A UI-only click did not originate on the canvas.
    outside.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    beginFrame();
    expect(input.wasReleased(FPS.FIRE)).toBe(false);
  });

  it("reads fire and aim when Babylon cancels pointerdown and no mousedown arrives", () => {
    canvas.addEventListener("pointerdown", (event) => event.preventDefault());
    pointer("pointerdown", 1);
    beginFrame();
    expect(input.isActive(FPS.FIRE)).toBe(true);
    expect(input.wasPressed(FPS.FIRE)).toBe(true);
    endFrame();
    pointer("pointermove", 3);
    beginFrame();
    expect(input.isActive(FPS.FIRE)).toBe(true);
    expect(input.isActive(FPS.AIM)).toBe(true);
    endFrame();
    pointer("pointermove", 2);
    beginFrame();
    expect(input.isActive(FPS.FIRE)).toBe(false);
    expect(input.wasReleased(FPS.FIRE)).toBe(true);
    expect(input.isActive(FPS.AIM)).toBe(true);
    endFrame();
    pointer("pointerup", 0, window);
    beginFrame();
    expect(input.isActive(FPS.AIM)).toBe(false);
    expect(input.wasReleased(FPS.AIM)).toBe(true);
  });

  it("keeps held fire and aim through locked motion that reports an empty mask", () => {
    pointerLock(canvas);
    pointer("pointerdown", 1);
    pointer("pointermove", 3);
    beginFrame();
    expect(input.isActive(FPS.FIRE)).toBe(true);
    expect(input.isActive(FPS.AIM)).toBe(true);
    endFrame();
    const motion = new MouseEvent("pointermove", { buttons: 0, button: -1, bubbles: true });
    Object.defineProperties(motion, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
    canvas.dispatchEvent(motion);
    beginFrame();
    expect(input.isActive(FPS.FIRE)).toBe(true);
    expect(input.isActive(FPS.AIM)).toBe(true);
    endFrame();
    pointer("pointerup", 0, window);
    beginFrame();
    expect(input.isActive(FPS.FIRE)).toBe(false);
    expect(input.isActive(FPS.AIM)).toBe(false);
  });

  it("still releases on unlocked plain motion with an empty mask", () => {
    pointer("pointerdown", 1);
    const motion = new MouseEvent("pointermove", { buttons: 0, button: -1, bubbles: true });
    Object.defineProperties(motion, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
    window.dispatchEvent(motion);
    beginFrame();
    expect(input.isActive(FPS.FIRE)).toBe(false);
  });

  it("does not repeat a press when compatibility mouse events follow pointer events", () => {
    pointer("pointerdown", 1);
    beginFrame();
    expect(input.wasPressed(FPS.FIRE)).toBe(true);
    endFrame();
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    beginFrame();
    expect(input.isActive(FPS.FIRE)).toBe(true);
    expect(input.wasPressed(FPS.FIRE)).toBe(false);
  });

  it("releases cancelled pointers and never resurrects held buttons after focus loss", () => {
    pointer("pointerdown", 1);
    pointer("pointercancel", 0, window);
    beginFrame();
    expect(input.isActive(FPS.FIRE)).toBe(false);
    endFrame();
    pointer("pointerdown", 1);
    window.dispatchEvent(new Event("blur"));
    pointer("pointermove", 1, window);
    beginFrame();
    expect(input.isActive(FPS.FIRE)).toBe(false);
  });

  it("does not interpret touch pointers or side mouse buttons as fire", () => {
    pointer("pointerdown", 1, canvas, "touch");
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 3 }));
    beginFrame();
    expect(input.isActive(FPS.FIRE)).toBe(false);
  });

  it("reports one release for a modified action across blur and hidden events", () => {
    input.registerAction({
      id: "focus_modified",
      type: "button",
      defaultBindings: [{ key: "KeyX", modifiers: { ctrl: true } }],
    });
    input.registerContext({ id: "focus_test", blocking: true, actions: ["focus_modified"] });
    input.setContext("focus_test");
    key("keydown", "ControlLeft");
    key("keydown", "KeyX");
    beginFrame();
    expect(input.isActive("focus_modified")).toBe(true);
    endFrame();
    window.dispatchEvent(new Event("blur"));
    visibility("hidden");
    beginFrame();
    expect(input.isActive("focus_modified")).toBe(false);
    expect(input.wasReleased("focus_modified")).toBe(true);
    endFrame();
    beginFrame();
    expect(input.wasReleased("focus_modified")).toBe(false);
  });

  it("discards pending presses, wheel movement and touch points when focus is lost", () => {
    key("keydown", "Space");
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
    canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 10 }));
    touch("touchstart", [1, 2]);
    expect(input.getTouchPoints()).toHaveLength(2);
    window.dispatchEvent(new Event("blur"));
    beginFrame();
    expect(input.wasPressed(FPS.JUMP)).toBe(false);
    expect(input.getScrollDelta()).toBe(0);
    expect(input.getMouseDelta()).toEqual({ x: 0, y: 0 });
    expect(input.getTouchPoints()).toEqual([]);
  });

  it("removes only cancelled touches", () => {
    touch("touchstart", [1, 2]);
    touch("touchcancel", [1]);
    expect(input.getTouchPoints().map((point) => point.id)).toEqual([2]);
    touch("touchend", [2]);
    expect(input.getTouchPoints()).toEqual([]);
  });

  it("preserves bindings and contexts while clearing state and listeners on dispose/reinit", () => {
    input.rebind(FPS.MOVE_FORWARD, [{ key: "KeyP" }]);
    key("keydown", "KeyP");
    beginFrame();
    expect(input.isActive(FPS.MOVE_FORWARD)).toBe(true);
    input.dispose();
    key("keydown", "KeyP");
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    beginFrame();
    expect(input.isKeyDown("KeyP")).toBe(false);
    expect(input.isActive(FPS.FIRE)).toBe(false);
    expect(input.getActiveContext()).toBe("fps_gameplay");
    expect(input.getBindingsForAction(FPS.MOVE_FORWARD)).toEqual([{ key: "KeyP" }]);
    input.init(scene, canvas);
    input.init(scene, canvas);
    key("keydown", "KeyP");
    beginFrame();
    expect(input.wasPressed(FPS.MOVE_FORWARD)).toBe(true);
    endFrame();
    window.dispatchEvent(new Event("blur"));
    beginFrame();
    expect(input.wasReleased(FPS.MOVE_FORWARD)).toBe(true);
  });

  it("still suppresses gameplay presses while typing and resumes menu contexts", () => {
    const field = document.body.appendChild(document.createElement("input"));
    field.focus();
    key("keydown", "KeyW");
    beginFrame();
    expect(input.isActive(FPS.MOVE_FORWARD)).toBe(false);
    field.blur();
    input.pushContext("menu");
    key("keydown", "ArrowDown");
    beginFrame();
    expect(input.wasPressed("menu_down")).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(input.isActive("menu_down")).toBe(false);
    input.popContext();
    beginFrame();
    expect(input.isActive(FPS.MOVE_FORWARD)).toBe(false);
  });
});
