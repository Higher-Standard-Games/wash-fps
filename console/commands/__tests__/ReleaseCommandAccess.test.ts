// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { Command } from "../../../../../engine/console/Command";
import { CommandRegistry } from "../../../../../engine/console/CommandRegistry";
import { Cvar } from "../../../../../engine/core/Cvar";

const modules = {
  ...import.meta.glob<{ default: new () => Command }>("../../../../../engine/console/commands/*Command.ts", {
    eager: true,
  }),
  ...import.meta.glob<{ default: new () => Command }>("../*Command.ts", { eager: true }),
};

afterEach(() => vi.restoreAllMocks());

it("enforces actual discovered developer-command definitions before execution, including aliases", async () => {
  const registry = CommandRegistry.getInstance();
  Cvar.register("developer", 0);
  const gated = new Set<string>();
  for (const module of Object.values(modules)) {
    const command = new module.default();
    if (!command.definition.developer) continue;
    gated.add(command.definition.name);
    const execute = vi.spyOn(command, "execute").mockResolvedValue("entered");
    registry.register(command);
    try {
      Cvar.set("developer", 0);
      for (const name of [command.definition.name, ...(command.definition.aliases ?? [])]) {
        const result = await registry.executeChecked(name);
        expect(result.ok, name).toBe(false);
        expect(result.output, name).toContain("requires developer mode");
      }
      expect(execute).not.toHaveBeenCalled();
      Cvar.set("developer", 1);
      expect(await registry.executeChecked(command.definition.name)).toEqual({ ok: true, output: "entered" });
    } finally {
      registry.unregister(command.definition.name);
    }
  }
  for (const name of ["bsp", "shader", "pvs", "scene", "arealight", "godrays", "weapon", "netsim", "water"]) {
    expect(gated.has(name), name).toBe(true);
  }
  expect(gated.has("spectator")).toBe(false);
  expect(gated.has("map")).toBe(false);
  expect(gated.has("camera")).toBe(false);
  Cvar.set("developer", 0);
});
