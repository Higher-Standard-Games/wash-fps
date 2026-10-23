import { afterEach, expect, it, vi } from "vitest";
import { EntityHandlerRegistry } from "../../../../engine/core/EntityHandlerRegistry";
import { EntityRegistry } from "../../../../shared/entities/EntityRegistry";
import { EntityManager } from "../EntityManager";
import { fpsMapEntities } from "../FpsMapEntities";

afterEach(() => {
  EntityHandlerRegistry.clear();
  vi.restoreAllMocks();
});

it("installs Washoi definitions and primary/alias handlers, and delegates map disposal", () => {
  fpsMapEntities.initializeDefinitions();
  expect(EntityRegistry.getInstance().getAllIds()).toHaveLength(31);
  fpsMapEntities.registerHandlers();
  for (const id of ["rlauncher", "health_medium", "ammo_shells"]) {
    const def = EntityRegistry.getInstance().get(id)!;
    expect(def).toBeDefined();
    expect(EntityHandlerRegistry.getHandler(def.classname!)).toBeTypeOf("function");
    for (const alias of def.classnameAliases ?? []) {
      expect(EntityHandlerRegistry.getHandler(alias)).toBe(EntityHandlerRegistry.getHandler(def.classname!));
    }
  }
  const dispose = vi.spyOn(EntityManager.getInstance(), "disposeMapEntities");
  fpsMapEntities.disposeMapEntities();
  expect(dispose).toHaveBeenCalledOnce();
});
