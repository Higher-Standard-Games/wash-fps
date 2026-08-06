import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CameraSystem } from "../../../../engine/camera/CameraSystem";
import { Command, type CommandDef } from "../../../../engine/console/Command";
import { getCollisionManager } from "../../../../engine/physics/CollisionManager";
import { ContentFlags, liquidKindOf } from "../../../../engine/physics/ContentFlags";
import { Game } from "../../Game";

/**
 * Ask the game what it thinks about liquid, right here, right now.
 *
 * Every number this feature runs on is invisible in play: the water level is
 * three probes up an invisible body, the camera's submersion is a separate
 * question again, and "why am I not swimming" has at least four possible
 * answers. This is the command that tells them apart.
 */
export default class WaterCommand extends Command {
  readonly definition: CommandDef = {
    name: "water",
    description: "Inspect liquid state at the camera and the player",
    usage: "water [sample|splash]",
  };

  async execute(args: string[]): Promise<string> {
    const sub = (args[0] ?? "sample").toLowerCase();

    switch (sub) {
      case "sample":
        return this.sample();
      case "splash":
        return this.splash();
      default:
        return `Unknown subcommand "${sub}".\n\n${this.help()}`;
    }
  }

  /**
   * Contents at the camera and at the player's three probe heights.
   *
   * Reported separately because they genuinely disagree: the camera is what
   * decides the underwater tint, the player's probes decide whether you swim,
   * and a spectator watching someone else has a camera nowhere near their own
   * body. Merging them into one "am I in water" line would hide the exact case
   * that goes wrong.
   */
  private sample(): string {
    const cm = getCollisionManager();
    if (!cm.isInitialized()) return "No collision world — load a map first.";

    const lines: string[] = [];

    const camera = CameraSystem.getInstance().getCamera();
    if (camera) {
      const p = camera.globalPosition;
      lines.push(`camera   (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})  ${this.describe(p)}`);
      lines.push(`         submersion ${Game.getInstance().cameraSubmersion.toFixed(2)}`);
    }

    const origin = Game.getInstance().getLocalPlayerPosition();
    if (!origin) {
      lines.push("player   no predicted position yet");
      return lines.join("\n");
    }

    // The same three heights the sampler uses. Printing them individually is
    // the point: a level of 1 that should be 2 is a waist probe question, and
    // no single number can say that.
    const feet = origin.y - 24;
    const probes: Array<[string, number]> = [
      ["foot ", feet + 1],
      ["waist", feet + (origin.y + 34 - feet) * 0.5],
      ["eye  ", origin.y + 34],
    ];

    lines.push(`player   (${origin.x.toFixed(0)}, ${origin.y.toFixed(0)}, ${origin.z.toFixed(0)})`);
    for (const [label, y] of probes) {
      lines.push(`  ${label}  y=${y.toFixed(1)}  ${this.describe(new Vector3(origin.x, y, origin.z))}`);
    }

    return lines.join("\n");
  }

  private describe(point: { x: number; y: number; z: number }): string {
    const contents = getCollisionManager().pointContents(new Vector3(point.x, point.y, point.z));
    if (contents === 0) return "empty";

    const kind = liquidKindOf(contents);
    const flags: string[] = [];
    if (contents & ContentFlags.SOLID) flags.push("solid");
    if (contents & ContentFlags.PLAYERCLIP) flags.push("playerclip");
    if (contents & ContentFlags.TRIGGER) flags.push("trigger");
    if (contents & ContentFlags.FOG) flags.push("fog");
    if (kind) flags.push(kind);

    return `0x${(contents >>> 0).toString(16)} ${flags.join("+") || "—"}`;
  }

  /** Fire a splash where the player is standing, to look at the ring. */
  private splash(): string {
    const origin = Game.getInstance().getLocalPlayerPosition();
    if (!origin) return "No player position yet.";

    Game.getInstance().debugSplash(origin);
    return `Splashed at (${origin.x.toFixed(0)}, ${origin.y.toFixed(0)}, ${origin.z.toFixed(0)}).`;
  }

  private help(): string {
    return [
      "water sample   contents at the camera and at each player probe height",
      "water splash   fire a ripple where you stand, to inspect the effect",
    ].join("\n");
  }
}
