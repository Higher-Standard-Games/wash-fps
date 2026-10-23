// @vitest-environment jsdom
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FreeflyController } from "../../../../engine/camera/controllers/FreeflyController";
import { clearFreeflyInput, registerFreeflyInput } from "../../../../engine/camera/FreeflyInput";
import { InputSystem } from "../../../../engine/input/InputSystem";
import { FPS, fpsFreeflyInput, registerFPSActions } from "../FPSActions";

const input = InputSystem.getInstance();
let engine: NullEngine;
let scene: Scene;
let camera: FreeCamera;
let controller: FreeflyController;
let canvas: HTMLCanvasElement;
const press = (code: string) => document.dispatchEvent(new KeyboardEvent("keydown", { code }));
const frame = () => scene.onBeforeRenderObservable.notifyObservers(scene);

beforeEach(() => {
  input.resetAllBindings();
  input.setContext("gameplay");
  // Application boot registers the adapter before any Game singleton is needed.
  registerFreeflyInput(fpsFreeflyInput);
  Object.defineProperty(document, "exitPointerLock", { configurable: true, value: vi.fn() });
  engine = new NullEngine();
  vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
  scene = new Scene(engine);
  canvas = document.body.appendChild(document.createElement("canvas"));
  camera = new FreeCamera("fps", new Vector3(0, 100, 0), scene);
  controller = new FreeflyController();
  controller.attach(camera, scene, canvas);
  input.setContext("fps_gameplay");
  Object.defineProperty(document, "pointerLockElement", { configurable: true, value: canvas });
  document.dispatchEvent(new Event("pointerlockchange"));
});

afterEach(() => {
  controller.detach();
  input.dispose();
  input.resetAllBindings();
  engine.dispose();
  canvas.remove();
  clearFreeflyInput();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "pointerLockElement");
});

it.each([
  [FPS.MOVE_FORWARD, "KeyI", "KeyW", "z", 1],
  [FPS.JUMP, "KeyR", "Space", "y", 1],
  [FPS.CROUCH, "KeyV", "KeyC", "y", -1],
] as const)("follows rebinding %s without enabling its old key", (action, code, oldCode, axis, direction) => {
  input.rebind(action, [{ key: code }]);
  const start = camera.position[axis];
  press(oldCode);
  frame();
  expect(camera.position[axis]).toBe(start);
  press(code);
  frame();
  expect((camera.position[axis] - start) * direction).toBeGreaterThan(0);
  expect(input.getActiveContext()).toBe("fps_gameplay");
});

it("uses the player's rebound sprint action for triple speed", () => {
  input.rebind(FPS.SPRINT, [{ key: "KeyP" }]);
  press("KeyW");
  press("ShiftLeft");
  frame();
  const normal = camera.position.z;
  controller.setPosition(new Vector3(0, 100, 0));
  press("KeyP");
  frame();
  expect(camera.position.z).toBeCloseTo(normal * 3);
});

it("preserves the selected spectator context across reattaching the camera", () => {
  input.setContext("fps_spectator");
  controller.detach();
  controller.attach(camera, scene, canvas);
  expect(input.getActiveContext()).toBe("fps_spectator");
});

it("restores the game mapping when game actions are registered again", () => {
  clearFreeflyInput();
  registerFPSActions();
  controller.detach();
  controller.attach(camera, scene, canvas);
  input.rebind(FPS.MOVE_FORWARD, [{ key: "KeyI" }]);
  document.dispatchEvent(new Event("pointerlockchange"));
  press("KeyI");
  frame();
  expect(camera.position.z).toBeGreaterThan(0);
});
