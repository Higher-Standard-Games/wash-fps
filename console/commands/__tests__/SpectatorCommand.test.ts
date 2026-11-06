import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../../../../../engine/console/CommandRegistry";
import { Cvar } from "../../../../../engine/core/Cvar";
import SpectatorCommand from "../SpectatorCommand";

const context = vi.hoisted(() => ({
  activeType: "fps",
  getActiveController: vi.fn(),
  getController: vi.fn(),
  registerController: vi.fn(),
  setController: vi.fn(),
}));

vi.mock("../../../../../engine/camera/CameraSystem", () => ({
  CameraSystem: { getInstance: () => context },
}));
vi.mock("../../../../../engine/camera/controllers/FreeflyController", () => ({
  FreeflyController: class {
    readonly type = "freefly";
  },
}));
vi.mock("../../../camera/FPSController", () => ({
  FPSController: class {
    readonly type = "fps";
  },
}));

let registry: CommandRegistry;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Cvar, "getBool").mockReturnValue(false);
  context.activeType = "fps";
  context.getActiveController.mockImplementation(() => ({ type: context.activeType }));
  context.getController.mockReturnValue({});
  context.setController.mockReturnValue(true);
  registry = CommandRegistry.getInstance();
  registry.register(new SpectatorCommand());
});

afterEach(() => {
  registry.unregister("spectator");
  vi.restoreAllMocks();
});

describe("spectator camera command", () => {
  it.each(["1junk", "1.5", "01", "-1", "2", "NaN", "0 extra"])(
    "rejects invalid input before camera work: %s",
    async (input) => {
      await expect(registry.executeChecked(`spectator ${input}`)).resolves.toEqual({
        ok: false,
        output: "Usage: spectator [0|1]",
      });
      expect(context.getActiveController).not.toHaveBeenCalled();
      expect(context.getController).not.toHaveBeenCalled();
      expect(context.registerController).not.toHaveBeenCalled();
      expect(context.setController).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["spectator 0", "freefly", "fps", "FPS mode (gravity, physics)"],
    ["spectator 1", "fps", "freefly", "Spectator mode (freefly)"],
    ["spectator", "freefly", "fps", "FPS mode (gravity, physics)"],
    ["spectator", "fps", "freefly", "Spectator mode (freefly)"],
  ])("preserves valid selection and toggling: %s from %s", async (input, active, target, output) => {
    context.activeType = active;
    await expect(registry.executeChecked(input)).resolves.toEqual({ ok: true, output });
    expect(context.setController).toHaveBeenCalledExactlyOnceWith(target);
    expect(context.registerController).not.toHaveBeenCalled();
  });

  it("registers missing controllers before a valid switch", async () => {
    context.getController.mockReturnValue(undefined);
    expect((await registry.executeChecked("spectator 1")).ok).toBe(true);
    expect(context.registerController).toHaveBeenCalledWith("fps", expect.objectContaining({ type: "fps" }));
    expect(context.registerController).toHaveBeenCalledWith("freefly", expect.objectContaining({ type: "freefly" }));
  });

  it.each(["0", "1"])("reports a failed camera switch for %s", async (arg) => {
    context.setController.mockReturnValue(false);
    const result = await registry.executeChecked(`spectator ${arg}`);
    expect(result.ok).toBe(false);
    expect(result.output).toBe(`Failed to switch to ${arg === "0" ? "fps" : "freefly"} camera.`);
  });
});
