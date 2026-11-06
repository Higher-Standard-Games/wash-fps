import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntityRegistry } from "../../../../shared/entities/EntityRegistry";
import { ROCKET_LAUNCHER } from "../../shared/entities/definitions/weapons/rlauncher";
import { InventoryManager } from "../InventoryManager";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  EntityRegistry.getInstance().clear();
  EntityRegistry.getInstance().register(ROCKET_LAUNCHER);
});

afterEach(() => {
  EntityRegistry.getInstance().clear();
  vi.restoreAllMocks();
});

describe("inventory ammo dictionary", () => {
  it.each(["__proto__", "constructor", "toString"])("treats %s as a plain ammo key", (key) => {
    const inventory = new InventoryManager();
    expect(inventory.getAmmoCount(key)).toBe(0);
    expect(inventory.giveAmmo(key, 5)).toBe(5);
    expect(inventory.getAmmoCount(key)).toBe(5);
    inventory.setAmmo(key, 9);
    expect(inventory.getAmmoCount(key)).toBe(9);
    expect(inventory.getAmmoCount("rockets")).toBe(0);
  });
});

describe("inventory ammo grants", () => {
  it.each([-5, 0, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "ignores invalid grant amounts: %s",
    (amount) => {
      const inventory = new InventoryManager();
      inventory.setAmmo("rockets", 7);
      expect(inventory.giveAmmo("rockets", amount)).toBe(0);
      expect(inventory.getAmmoCount("rockets")).toBe(7);
    },
  );

  it("returns only the amount added up to a registered weapon's cap", () => {
    const inventory = new InventoryManager();
    inventory.setAmmo("rlauncher", 18);
    expect(inventory.giveAmmo("rlauncher", 5)).toBe(2);
    expect(inventory.getAmmoCount("rlauncher")).toBe(ROCKET_LAUNCHER.maxAmmo);
  });

  it("keeps the fallback cap for other ammo keys", () => {
    const inventory = new InventoryManager();
    inventory.setAmmo("rockets", 198);
    expect(inventory.giveAmmo("rockets", 5)).toBe(2);
    expect(inventory.getAmmoCount("rockets")).toBe(200);
  });

  it.each([
    ["rlauncher", 40],
    ["rockets", 250],
  ] as const)("does not reduce over-cap ammo at %s", (key, count) => {
    const inventory = new InventoryManager();
    inventory.setAmmo(key, count);
    expect(inventory.giveAmmo(key, 5)).toBe(0);
    expect(inventory.getAmmoCount(key)).toBe(count);
  });
});
