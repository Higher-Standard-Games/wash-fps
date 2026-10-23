// @vitest-environment jsdom
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FullscreenKeyboardLock } from "../../../../engine/input/FullscreenKeyboardLock";
import { InputSystem } from "../../../../engine/input/InputSystem";
import { FPS, registerFPSActions } from "../FPSActions";

const input = InputSystem.getInstance();
let engine: NullEngine, scene: Scene, canvas: HTMLCanvasElement;
let fullscreen: Element | null, pointer: Element | null;
const keyboard = { lock: vi.fn<(keys: string[]) => Promise<void>>(), unlock: vi.fn() };
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const frame = () => scene.onBeforeRenderObservable.notifyObservers(scene);
const changePointer = (element: Element | null) => {
  pointer = element;
  document.dispatchEvent(new Event("pointerlockchange"));
};
const enter = async () => {
  fullscreen = document.documentElement;
  document.dispatchEvent(new Event("fullscreenchange"));
  changePointer(canvas);
  await flush();
};

beforeEach(() => {
  input.dispose();
  document.body.replaceChildren();
  fullscreen = pointer = null;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
  Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => pointer });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(navigator, "keyboard", { configurable: true, value: keyboard });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  keyboard.lock.mockReset().mockResolvedValue();
  keyboard.unlock.mockReset();
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
  delete (navigator as unknown as { keyboard?: unknown }).keyboard;
  vi.restoreAllMocks();
});

it("captures movement shortcuts only with fullscreen and canvas mouse capture", async () => {
  changePointer(canvas);
  await flush();
  expect(keyboard.lock).not.toHaveBeenCalled();
  await enter();
  expect(keyboard.lock).toHaveBeenCalledExactlyOnceWith(["KeyA", "KeyD", "KeyS", "KeyW"]);
  const press = new KeyboardEvent("keydown", { code: "KeyW", ctrlKey: true, cancelable: true });
  document.dispatchEvent(press);
  expect(press.defaultPrevented).toBe(true);
  expect(input.isKeyDown("KeyW")).toBe(true);
  frame();
  frame();
  expect(keyboard.lock).toHaveBeenCalledTimes(1);
  changePointer(null);
  expect(keyboard.unlock).toHaveBeenCalled();
});

it.each(["fullscreen", "menu", "chat", "blur", "hidden", "dispose"])("releases capture on %s", async (reason) => {
  await enter();
  if (reason === "fullscreen") {
    fullscreen = null;
    document.dispatchEvent(new Event("fullscreenchange"));
  }
  if (reason === "menu") input.pushContext("menu");
  if (reason === "chat") document.body.appendChild(document.createElement("input")).focus();
  if (reason === "blur") window.dispatchEvent(new Event("blur"));
  if (reason === "hidden") {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }
  if (reason === "dispose") input.dispose();
  expect(keyboard.unlock).toHaveBeenCalled();
  frame();
  await flush();
  expect(keyboard.lock).toHaveBeenCalledTimes(1);
});

it("uses rebound movement keys, preserves Escape and resumes after closing a menu", async () => {
  input.rebind(FPS.MOVE_FORWARD, [{ key: "KeyP" }]);
  input.rebind(FPS.MOVE_BACKWARD, [{ key: "Escape" }]);
  await enter();
  expect(keyboard.lock).toHaveBeenLastCalledWith(["KeyA", "KeyD", "KeyP"]);
  input.pushContext("menu");
  input.popContext();
  await flush();
  expect(keyboard.lock).toHaveBeenCalledTimes(2);
  input.rebind(FPS.MOVE_FORWARD, [{ key: "KeyW" }]);
  frame();
  await flush();
  expect(keyboard.lock).toHaveBeenLastCalledWith(["KeyA", "KeyD", "KeyW"]);
});

it("tolerates an unsupported API and explains denied protection without retrying each frame", async () => {
  delete (navigator as unknown as { keyboard?: unknown }).keyboard;
  await enter();
  expect(keyboard.lock).not.toHaveBeenCalled();
  Object.defineProperty(navigator, "keyboard", { configurable: true, value: keyboard });
  changePointer(null);
  keyboard.lock.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
  changePointer(canvas);
  await flush();
  frame();
  frame();
  expect(keyboard.lock).toHaveBeenCalledTimes(1);
  expect(document.getElementById("browser-control-feedback")?.textContent).toContain("Ctrl+W");
});

it("releases stale async acquisitions and serializes a later request", async () => {
  let resolve!: () => void;
  keyboard.lock.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const lock = new FullscreenKeyboardLock(vi.fn());
  lock.update(["KeyW"]);
  lock.update([]);
  lock.update(["KeyP"]);
  expect(keyboard.lock).toHaveBeenCalledTimes(1);
  resolve();
  await flush();
  await flush();
  expect(keyboard.lock).toHaveBeenCalledTimes(2);
  expect(keyboard.lock).toHaveBeenLastCalledWith(["KeyP"]);
  expect(lock.captures("KeyW")).toBe(false);
  expect(lock.captures("KeyP")).toBe(true);
  lock.dispose();
  expect(lock.captures("KeyP")).toBe(false);
});
