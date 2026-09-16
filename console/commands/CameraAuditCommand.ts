import { CameraSystem } from "../../../../engine/camera/CameraSystem";
import { Command, type CommandDef } from "../../../../engine/console/Command";
import { Game } from "../../Game";

/**
 * Report what is rolling the view and what owns the camera.
 *
 * Run it while the view is tilted. The controller zeroes roll every frame, so a
 * non-zero `roll` names its writer: a `deathCam.phase` above zero is the 40°
 * death fallback, and `effects=false` means the camera block never ran.
 */
export default class CameraAuditCommand extends Command {
  readonly definition: CommandDef = {
    name: "camera_audit",
    description: "Report what owns the camera and what is rolling the view",
    usage: "camera_audit",
    developer: true,
  };

  async execute(): Promise<string> {
    const controller = CameraSystem.getInstance().getController("fps");
    const view =
      controller && "describeViewForAudit" in controller
        ? (controller as { describeViewForAudit(): string }).describeViewForAudit()
        : "view: no fps controller";
    return `${view}\n${Game.getInstance().describeCameraOwnershipForAudit()}`;
  }
}
