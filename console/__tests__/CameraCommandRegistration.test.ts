// @vitest-environment jsdom

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { afterEach, expect, it, vi } from "vitest";
import { CameraSystem } from "../../../../engine/camera/CameraSystem";
import type { ICameraController } from "../../../../engine/camera/controllers/ICameraController";
import { CommandRegistry } from "../../../../engine/console/CommandRegistry";
import { registerEngineCommands } from "../../../../engine/console/commands";
import { Cvar } from "../../../../engine/core/Cvar";
import { CommandBindings } from "../../../../engine/input/CommandBindings";
import { EntityManager } from "../../world/EntityManager";
import { registerFpsCommands } from "../index";

afterEach(() => {
  CommandBindings.detach();
  CommandRegistry.getInstance().unregister("spectator");
  CommandRegistry.getInstance().unregister("giveweapon");
  CommandRegistry.getInstance().unregister("spawn_pickable_entity");
  CommandRegistry.getInstance().unregister("name");
  vi.restoreAllMocks();
});

it("discovers the moved commands only in the game and preserves their responses", async () => {
  const registry = CommandRegistry.getInstance();
  registry.unregister("name");
  await registerEngineCommands();
  expect(registry.getDefinition("name")).toBeUndefined();
  expect(registry.getDefinition("spectator")).toBeUndefined();
  expect(registry.getDefinition("giveweapon")).toBeUndefined();
  expect(registry.getDefinition("spawn_pickable_entity")).toBeUndefined();
  await registerFpsCommands();
  expect(registry.getDefinition("name")?.usage).toBe("name [newname]");
  expect(registry.getDefinition("spectator")?.usage).toBe("spectator [0|1]");
  expect(registry.getDefinition("giveweapon")?.usage).toBe("giveweapon <weapon_id|all> [amount]");
  expect(registry.getDefinition("spawn_pickable_entity")?.usage).toBe("spawn_pickable_entity <entity_id>");

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

  const scene = {} as Scene;
  const camera = { position: new Vector3(10, 20, 30), getDirection: () => new Vector3(0, 0, 1), getScene: () => scene };
  vi.spyOn(cameras, "getCamera").mockReturnValue(camera as unknown as ReturnType<typeof cameras.getCamera>);
  const spawn = vi.spyOn(EntityManager.getInstance(), "spawnEntityById").mockResolvedValue(true);
  await expect(registry.execute("spawn_pickable_entity rlauncher")).resolves.toContain("requires developer mode");
  const developer = Cvar.get("developer") ?? 0;
  expect((await registry.executeChecked("developer 1")).ok).toBe(true);
  try {
    await expect(registry.execute("spawn_pickable_entity rlauncher")).resolves.toContain("Spawned rlauncher");
  } finally {
    Cvar.set("developer", developer);
  }
  expect(spawn).toHaveBeenCalledWith("rlauncher", new Vector3(10, 30, 230), scene, { gravity: true });
});
