import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../../../../../engine/console/CommandRegistry";
import { Cvar } from "../../../../../engine/core/Cvar";
import { EntityRegistry } from "../../../../../shared/entities/EntityRegistry";
import { BLADE, MACHINEGUN, PLASMAGUN, ROCKET_LAUNCHER, VOLTAIC } from "../../../shared/entities/definitions/weapons";
import { InventoryManager } from "../../../world/InventoryManager";
import GiveWeaponCommand from "../GiveWeaponCommand";

const context = vi.hoisted(() => ({
  inventory: null as InventoryManager | null,
  loadWeapon: vi.fn(),
  controllerType: "fps" as string | undefined,
  hasInventory: true,
}));

vi.mock("../../../../../engine/camera/CameraSystem", () => ({
  CameraSystem: {
    getInstance: () => ({
      getActiveController: () => ({
        type: context.controllerType,
        inventory: context.hasInventory ? context.inventory : null,
      }),
    }),
  },
}));
vi.mock("../../../../../engine/weapon/WeaponViewManager", () => ({
  WeaponViewManager: { getInstance: () => ({ loadWeapon: context.loadWeapon }) },
}));

const command = new GiveWeaponCommand();
let inventory: InventoryManager;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(Cvar, "getBool").mockReturnValue(true);
  const registry = EntityRegistry.getInstance();
  registry.clear();
  for (const weapon of [BLADE, MACHINEGUN, PLASMAGUN, ROCKET_LAUNCHER, VOLTAIC]) registry.register(weapon);
  inventory = new InventoryManager();
  vi.spyOn(inventory, "giveWeapon");
  vi.spyOn(inventory, "setAmmo");
  vi.spyOn(inventory, "equipWeapon");
  context.inventory = inventory;
  context.controllerType = "fps";
  context.hasInventory = true;
  context.loadWeapon.mockResolvedValue(true);
});

afterEach(() => {
  EntityRegistry.getInstance().clear();
  vi.restoreAllMocks();
});

function expectNoGrant(): void {
  expect(inventory.giveWeapon).not.toHaveBeenCalled();
  expect(inventory.setAmmo).not.toHaveBeenCalled();
  expect(inventory.equipWeapon).not.toHaveBeenCalled();
  expect(context.loadWeapon).not.toHaveBeenCalled();
}

async function checked(input: string) {
  const registry = CommandRegistry.getInstance();
  registry.register(command);
  try {
    return await registry.executeChecked(input);
  } finally {
    registry.unregister("giveweapon");
  }
}

describe("giveweapon command failures and help", () => {
  it("requires developer mode before changing inventory or loading a model", async () => {
    vi.mocked(Cvar.getBool).mockReturnValue(false);
    const result = await checked("giveweapon rlauncher");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("requires developer mode");
    expectNoGrant();
  });

  it("documents supported targets instead of the unsupported all operation", async () => {
    const help = await command.execute([]);
    expect(help).toContain("giveweapon <weapon_id|ammo_type> [amount]");
    expect(help).not.toContain("|all>");
    expectNoGrant();
  });

  it.each([
    ["freefly", true, "rlauncher", "Error: Must be in FPS mode"],
    [undefined, true, "rlauncher", "Error: Must be in FPS mode"],
    ["fps", false, "rlauncher", "Error: No inventory found"],
    ["fps", true, "all", "Giving all weapons is not supported."],
  ] as const)("reports unavailable operations: %j/%j/%j", async (type, hasInventory, item, output) => {
    context.controllerType = type;
    context.hasInventory = hasInventory;
    await expect(checked(`giveweapon ${item}`)).resolves.toEqual({ ok: false, output });
    expectNoGrant();
  });

  it.each(["typo", "__proto__", "rocket", "ammo_rockets"])("rejects unknown target %s", async (item) => {
    await expect(checked(`giveweapon ${item}`)).resolves.toEqual({
      ok: false,
      output: `Unknown weapon or ammo type: ${item}`,
    });
    expectNoGrant();
    expect(inventory.getAmmoCount(item)).toBe(0);
  });
});

describe("giveweapon amount validation", () => {
  it.each(["-1", "0", "1.5", "12junk", "NaN", "Infinity", "9007199254740992", ""])(
    "rejects %j before changing inventory or loading a model",
    async (amount) => {
      await expect(command.execute(["rlauncher", amount])).resolves.toEqual({
        ok: false,
        output: "Amount must be a positive safe integer.",
      });
      expectNoGrant();
    },
  );

  it.each([
    [[], 100],
    [["25"], 25],
  ] as const)("grants default and explicit amounts to a real reserve: %j", async (args, expected) => {
    await expect(checked(`giveweapon machinegun ${args.join(" ")}`)).resolves.toEqual({
      ok: true,
      output: "Gave and equipped machinegun",
    });
    expect(inventory.getAmmoCount("bullets")).toBe(expected);
    expect(inventory.getAmmoCount("machinegun")).toBe(MACHINEGUN.clipSize + expected);
    expect(context.loadWeapon).toHaveBeenCalledExactlyOnceWith("machinegun");
  });
});

describe("giveweapon canonical ammo grants", () => {
  it("grants usable pool ammo and matching display totals", async () => {
    await command.execute(["RLAUNCHER", "5"]);
    expect(inventory.getLoadedAmmo("rlauncher")).toBe(5);
    expect(inventory.getAmmoCount("rockets")).toBe(5);
    expect(inventory.getAmmoCount("rlauncher")).toBe(5);
    expect(inventory.getCurrentWeaponId()).toBe("rlauncher");
  });

  it("tops up an owned weapon without changing the selected weapon or loading another model", async () => {
    await command.execute(["rlauncher", "5"]);
    inventory.giveWeapon("blade");
    await expect(command.execute(["rlauncher", "3"])).resolves.toBe("Gave ammo: 3 rockets");
    expect(inventory.getLoadedAmmo("rlauncher")).toBe(8);
    expect(inventory.getAmmoCount("rlauncher")).toBe(8);
    expect(inventory.getCurrentWeaponId()).toBe("blade");
    expect(context.loadWeapon).toHaveBeenCalledTimes(1);
  });

  it("accepts ammo types without acquiring weapons", async () => {
    await expect(command.execute(["rockets", "5"])).resolves.toBe("Gave ammo: 5 rockets");
    expect(inventory.getAmmoCount("rockets")).toBe(5);
    expect(inventory.getWeapons()).toEqual([]);
    expect(inventory.giveWeapon).not.toHaveBeenCalled();
    expect(context.loadWeapon).not.toHaveBeenCalled();
  });

  it("caps grants at the registered weapon limit and reports the actual addition", async () => {
    await command.execute(["rlauncher"]);
    expect(inventory.getLoadedAmmo("rlauncher")).toBe(ROCKET_LAUNCHER.maxAmmo);
    await expect(command.execute(["rockets", "5"])).resolves.toBe("Gave ammo: 0 rockets");
    expect(inventory.getAmmoCount("rlauncher")).toBe(ROCKET_LAUNCHER.maxAmmo);
  });

  it("does not subtract an existing pool that is already over the grant cap", async () => {
    inventory.syncFromServer(["rlauncher"], { rlauncher: 40 }, "rlauncher");
    await expect(command.execute(["rockets", "5"])).resolves.toBe("Gave ammo: 0 rockets");
    expect(inventory.getLoadedAmmo("rlauncher")).toBe(40);
    expect(inventory.getAmmoCount("rlauncher")).toBe(40);
  });

  it("preserves a partial clip while adding reserve and updating its display total", async () => {
    inventory.syncFromServer(["machinegun"], { machinegun: { clip: 7, reserve: 3 } }, "machinegun");
    await command.execute(["bullets", "5"]);
    expect(inventory.getLoadedAmmo("machinegun")).toBe(7);
    expect(inventory.getAmmoCount("bullets")).toBe(8);
    expect(inventory.getAmmoCount("machinegun")).toBe(15);
    expect(context.loadWeapon).not.toHaveBeenCalled();
  });

  it("keeps the plasma and beam reserves separate", async () => {
    inventory.giveWeapon("plasmagun");
    inventory.giveWeapon("voltaic");
    await command.execute(["lasers", "5"]);
    expect(inventory.getAmmoCount("cells")).toBe(0);
    expect(inventory.getAmmoCount("lasers")).toBe(5);
    expect(inventory.getAmmoCount("voltaic")).toBe(VOLTAIC.clipSize + 5);
  });

  it("does not create a finite ammo pool for the blade", async () => {
    await command.execute(["blade"]);
    await expect(command.execute(["blade"])).resolves.toBe("Blade does not use ammunition.");
    expect(inventory.getLoadedAmmo("blade")).toBe(Number.MAX_SAFE_INTEGER);
    expect(inventory.setAmmo).not.toHaveBeenCalled();
  });
});
