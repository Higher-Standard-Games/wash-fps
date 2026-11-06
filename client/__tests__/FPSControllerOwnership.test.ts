import { afterEach, expect, it } from "vitest";
import { CameraSystem } from "../../../../engine/camera";
import { FreeflyController } from "../../../../engine/camera/controllers/FreeflyController";
import { Cvar } from "../../../../engine/core/Cvar";
import { FPSController } from "../../camera/FPSController";

const cvarSpeed = Cvar.get("cam_freefly_speed");
const fpsSpeed = FPSController.getDefaultSpeed();
const freeflySpeed = FreeflyController.getDefaultSpeed();
const developer = Cvar.getBool("developer");

afterEach(() => {
  if (cvarSpeed !== undefined) Cvar.set("cam_freefly_speed", cvarSpeed);
  FPSController.setDefaultSpeed(fpsSpeed);
  FreeflyController.setDefaultSpeed(freeflySpeed);
  Cvar.set("developer", developer);
});

it("keeps cam_freefly_speed owned by freefly when the game controller loads after the engine", () => {
  Cvar.register("developer", 0);
  Cvar.set("developer", 1);
  expect(CameraSystem.getInstance()).toBeDefined();
  Cvar.set("cam_freefly_speed", 333);
  expect(FreeflyController.getDefaultSpeed()).toBe(333);
  expect(FPSController.getDefaultSpeed()).toBe(fpsSpeed);
});
