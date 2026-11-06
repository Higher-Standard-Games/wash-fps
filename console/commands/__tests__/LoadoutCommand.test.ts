import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../../../../../engine/console/CommandRegistry";
import LoadoutCommand from "../LoadoutCommand";

const context = vi.hoisted(() => ({
  sendLoadout: vi.fn(),
  loadoutMode: "round" as "round" | "respawn",
}));

vi.mock("../../../Game", () => ({
  Game: { getInstance: () => ({ sendLoadout: context.sendLoadout }) },
}));
vi.mock("../../../client/MatchStateManager", () => ({
  MatchStateManager: { getInstance: () => ({ loadoutMode: context.loadoutMode }) },
}));

let registry: CommandRegistry;
beforeEach(() => {
  context.sendLoadout.mockReset().mockReturnValue(true);
  context.loadoutMode = "round";
  registry = CommandRegistry.getInstance();
  registry.register(new LoadoutCommand());
});

afterEach(() => {
  registry.unregister("loadout");
});

describe("loadout command results", () => {
  it("shows help successfully without sending a choice", async () => {
    const result = await registry.executeChecked("loadout");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Usage: loadout <primary> <secondary>");
    expect(context.sendLoadout).not.toHaveBeenCalled();
  });

  it.each(["loadout unknown pg", "loadout rl"])("reports invalid choices as failures: %s", async (input) => {
    const result = await registry.executeChecked(input);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Unknown weapon:");
    expect(context.sendLoadout).not.toHaveBeenCalled();
  });

  it("reports a disconnected attempt as a failure", async () => {
    context.sendLoadout.mockReturnValue(false);
    await expect(registry.executeChecked("loadout rl pg")).resolves.toEqual({
      ok: false,
      output: "Not connected to a server.",
    });
  });

  it.each([
    ["round", "the next round"],
    ["respawn", "your next spawn"],
  ] as const)("keeps successful %s confirmations", async (mode, when) => {
    context.loadoutMode = mode;
    const result = await registry.executeChecked("loadout rl pg");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Rocket Launcher + Plasmagun");
    expect(result.output).toContain(when);
    expect(context.sendLoadout).toHaveBeenCalledExactlyOnceWith("rlauncher", "plasmagun");
  });
});
