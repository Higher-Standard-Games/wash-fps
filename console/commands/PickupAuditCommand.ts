import { Command, type CommandDef } from "../../../../engine/console/Command";
import { DroppedWeaponRenderer } from "../../client/DroppedWeaponRenderer";
import { FPSPickup } from "../../world/FPSPickup";

export default class PickupAuditCommand extends Command {
  readonly definition: CommandDef = {
    name: "pickup_audit",
    description: "Audit client/server pickup active-set reconciliation",
    usage: "pickup_audit",
    developer: true,
  };

  async execute(): Promise<string> {
    return `${FPSPickup.auditActiveSet()}\n${DroppedWeaponRenderer.auditModelState()}`;
  }
}
