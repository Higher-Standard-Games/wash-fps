import { Command, type CommandDef } from "../../../../engine/console/Command";
import {
  describeLoadout,
  PRIMARY_CHOICES,
  parseLoadout,
  SECONDARY_CHOICES,
  WEAPON_LABELS,
} from "../../../../shared/server/gametype/Loadout";
import { MatchStateManager } from "../../client/MatchStateManager";
import { Game } from "../../Game";

/**
 * Choose the spawn kit, in a mode with kits (S&D, Amphi, Deathmatch). The match
 * menu's Loadout key does the same with a picker.
 *
 * A change applies at the next round or the next spawn, as the mode says, and
 * the confirmation says which: a player who types this mid-round and then
 * wonders why nothing happened has been failed by the tool, not by the rule.
 */
export default class LoadoutCommand extends Command {
  readonly definition: CommandDef = {
    name: "loadout",
    description: "Choose your spawn kit (applies at the next round or spawn)",
    usage: "loadout <primary> <secondary>",
  };

  async execute(args: string[]): Promise<string> {
    if (args.length === 0) return this.help();

    const choice = parseLoadout(args[0], args[1]);
    if (!choice) return `Unknown weapon: "${args[0]} ${args[1] ?? ""}".\n\n${this.help()}`;

    if (!Game.getInstance().sendLoadout(choice.primary, choice.secondary)) {
      return "Not connected to a server.";
    }
    const when = MatchStateManager.getInstance().loadoutMode === "respawn" ? "your next spawn" : "the next round";
    return `Loadout set: ${describeLoadout(choice)} — from ${when}.`;
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
