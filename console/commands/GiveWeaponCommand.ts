import { CameraSystem } from "../../../../engine/camera/CameraSystem";
import { Command, type CommandDef, type CommandOutput, fail } from "../../../../engine/console/Command";
import { WeaponViewManager } from "../../../../engine/weapon/WeaponViewManager";
import { EntityRegistry } from "../../../../shared/entities/EntityRegistry";
import { EntityType } from "../../../../shared/entities/EntityType";
import type { WeaponDef } from "../../../../shared/entities/WeaponDef";
import type { FPSController } from "../../camera/FPSController";
import type { InventoryManager } from "../../world/InventoryManager";

export default class GiveWeaponCommand extends Command {
  readonly definition: CommandDef = {
    name: "giveweapon",
    description: "Give weapon or ammo to player",
    usage: "giveweapon <weapon_id|ammo_type> [amount]",
    developer: true,
  };

  async execute(args: string[]): Promise<CommandOutput> {
    if (args.length < 1) {
      return this.getHelp();
    }

    const itemId = args[0].toLowerCase();
    const amount = args.length > 1 ? Number(args[1]) : 100;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return fail("Amount must be a positive safe integer.");
    }

    const cameraSystem = CameraSystem.getInstance();
    const controller = cameraSystem.getActiveController();

    if (controller?.type !== "fps") {
      return fail("Error: Must be in FPS mode");
    }

    const fpsController = controller as FPSController;
    if (!fpsController.inventory) {
      return fail("Error: No inventory found");
    }

    if (itemId === "all") {
      return fail("Giving all weapons is not supported.");
    }

    const weapons = EntityRegistry.getInstance().getByType<WeaponDef>(EntityType.WEAPON);
    const weapon = weapons.find((def) => def.id === itemId);
    const ammoWeapon = weapon ?? weapons.find((def) => def.reloadModel !== "none" && def.ammoType === itemId);
    if (!ammoWeapon) {
      return fail(`Unknown weapon or ammo type: ${itemId}`);
    }

    const inventory = fpsController.inventory;
    const acquired = weapon ? inventory.giveWeapon(weapon.id).acquired : false;
    const added = this.grantAmmo(inventory, ammoWeapon, amount, weapons);
    if (acquired && weapon) {
      inventory.equipWeapon(weapon.id);

      const success = await WeaponViewManager.getInstance().loadWeapon(weapon.id);
      if (success) {
        return `Gave and equipped ${itemId}`;
      } else {
        return `Gave ${itemId} (model load failed)`;
      }
    }
    if (ammoWeapon.reloadModel === "none") return `${ammoWeapon.name} does not use ammunition.`;
    return `Gave ammo: ${added} ${ammoWeapon.ammoType}`;
  }

  private grantAmmo(inventory: InventoryManager, weapon: WeaponDef, amount: number, weapons: WeaponDef[]): number {
    if (!weapon.ammoType || weapon.reloadModel === "none") return 0;
    const current = inventory.getAmmoCount(weapon.ammoType);
    const added = Math.max(0, Math.min(amount, weapon.maxAmmo - current));
    const total = current + added;
    inventory.setAmmo(weapon.ammoType, total);

    // Keep weapon-ID display totals aligned with the ammo-type pool and existing clips.
    for (const def of weapons) {
      if (def.ammoType !== weapon.ammoType || !inventory.hasWeapon(def.id)) continue;
      inventory.setAmmo(def.id, total + (def.reloadModel === "clip" ? inventory.getLoadedAmmo(def.id) : 0));
    }
    return added;
  }
}
