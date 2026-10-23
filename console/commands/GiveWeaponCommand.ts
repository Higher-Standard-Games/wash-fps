import { CameraSystem } from "../../../../engine/camera/CameraSystem";
import { Command, type CommandDef } from "../../../../engine/console/Command";
import { WeaponViewManager } from "../../../../engine/weapon/WeaponViewManager";
import type { FPSController } from "../../camera/FPSController";

export default class GiveWeaponCommand extends Command {
  readonly definition: CommandDef = {
    name: "giveweapon",
    description: "Give weapon or ammo to player",
    usage: "giveweapon <weapon_id|all> [amount]",
  };

  async execute(args: string[]): Promise<string | undefined> {
    if (args.length < 1) {
      return this.getHelp();
    }

    const itemId = args[0].toLowerCase();
    const amount = args.length > 1 ? parseInt(args[1], 10) : 100;

    const cameraSystem = CameraSystem.getInstance();
    const controller = cameraSystem.getActiveController();

    if (controller?.type !== "fps") {
      return "Error: Must be in FPS mode";
    }

    const fpsController = controller as FPSController;
    if (!fpsController.inventory) {
      return "Error: No inventory found";
    }

    if (itemId === "all") {
      return "Give all not implemented yet";
    }

    // Try to give as weapon
    const result = fpsController.inventory.giveWeapon(itemId);
    if (result.acquired) {
      // Also give default ammo
      fpsController.inventory.giveAmmo(itemId, amount); // Most IDs are same for weapon/ammo in this simple ref

      // Equip it
      fpsController.inventory.equipWeapon(itemId);

      // Ensure model loads
      const success = await WeaponViewManager.getInstance().loadWeapon(itemId);
      if (success) {
        return `Gave and equipped ${itemId}`;
      } else {
        return `Gave ${itemId} (model load failed)`;
      }
    } else {
      // Try to give as ammo
      fpsController.inventory.giveAmmo(itemId, amount);
      return `Gave ammo: ${amount} ${itemId}`;
    }
  }
}
