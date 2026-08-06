import { Command, type CommandDef } from "../../../../engine/console/Command";
import {
  describeLoadout,
  PRIMARY_CHOICES,
  parseLoadout,
  SECONDARY_CHOICES,
  WEAPON_LABELS,
} from "../../../../shared/server/gametype/Loadout";
import { Game } from "../../Game";

/**
 * Choose the spawn kit for Search & Destroy.
 *
 * The console is the whole interface for now — a menu comes later. Changes
 * apply from the NEXT round, which is deliberate and worth saying out loud in
 * the confirmation: a player who types this mid-round and then wonders why
 * nothing happened has been failed by the tool, not by the rule.
 */
export default class LoadoutCommand extends Command {
  readonly definition: CommandDef = {
    name: "loadout",
    description: "Choose your Search & Destroy spawn kit (applies next round)",
    usage: "loadout <primary> <secondary>",
  };

  async execute(args: string[]): Promise<string> {
    if (args.length === 0) return this.help();

    const choice = parseLoadout(args[0], args[1]);
    if (!choice) return `Unknown weapon: "${args[0]} ${args[1] ?? ""}".\n\n${this.help()}`;

    if (!Game.getInstance().sendLoadout(choice.primary, choice.secondary)) {
      return "Not connected to a server.";
    }
    return `Loadout set: ${describeLoadout(choice)} — from the next round.`;
  }

  private help(): string {
    const list = (ids: readonly string[]) =>
      ids.map((id) => `  ${id.padEnd(14)}${WEAPON_LABELS[id as keyof typeof WEAPON_LABELS]}`).join("\n");
    return [
      "Usage: loadout <primary> <secondary>",
      "",
      "Primary (pick one):",
      list(PRIMARY_CHOICES),
      "",
      "Secondary (pick one):",
      list(SECONDARY_CHOICES),
      "",
      "You always carry the blade. Short names work: rl, eb, lg, rg, pg, gl, mg.",
      "Example: loadout rl pg",
    ].join("\n");
  }
}
