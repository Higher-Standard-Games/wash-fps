// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { CameraSystem } from "../../../../engine/camera/CameraSystem";
import type { ICameraController } from "../../../../engine/camera/controllers/ICameraController";
import { CommandRegistry } from "../../../../engine/console/CommandRegistry";
import { registerEngineCommands } from "../../../../engine/console/commands";
import { CommandBindings } from "../../../../engine/input/CommandBindings";
import { registerFpsCommands } from "../index";

afterEach(() => {
  CommandBindings.detach();
  CommandRegistry.getInstance().unregister("spectator");
  CommandRegistry.getInstance().unregister("giveweapon");
  vi.restoreAllMocks();
});

it("discovers the moved commands only in the game and preserves their responses", async () => {
  const registry = CommandRegistry.getInstance();
  await registerEngineCommands();
  expect(registry.getDefinition("spectator")).toBeUndefined();
  expect(registry.getDefinition("giveweapon")).toBeUndefined();
  await registerFpsCommands();
  expect(registry.getDefinition("spectator")?.usage).toBe("spectator [0|1]");
  expect(registry.getDefinition("giveweapon")?.usage).toBe("giveweapon <weapon_id|all> [amount]");

  const cameras = CameraSystem.getInstance();
  const fps = { type: "fps" } as ICameraController;
  const freefly = { type: "freefly" } as ICameraController;
  vi.spyOn(cameras, "getController").mockImplementation((type) => (type === "fps" ? fps : freefly));
  vi.spyOn(cameras, "getActiveController").mockReturnValue(freefly);
  const switchCamera = vi.spyOn(cameras, "setController").mockReturnValue(true);
  await expect(registry.execute("spectator 0")).resolves.toBe("FPS mode (gravity, physics)");
  expect(switchCamera).toHaveBeenLastCalledWith("fps");
  await expect(registry.execute("spectator 1")).resolves.toBe("Spectator mode (freefly)");
  expect(switchCamera).toHaveBeenLastCalledWith("freefly");
  await expect(registry.execute("giveweapon rlauncher")).resolves.toBe("Error: Must be in FPS mode");
});
