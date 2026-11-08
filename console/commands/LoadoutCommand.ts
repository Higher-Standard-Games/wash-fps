import { Command, type CommandDef, type CommandOutput, fail } from "../../../../engine/console/Command";
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
 * Choose a spawn kit and report whether it applies at the next round or spawn.
 * With no arguments, list weapon choices and aliases.
 */
export default class LoadoutCommand extends Command {
  readonly definition: CommandDef = {
    name: "loadout",
    description: "Choose your spawn kit (applies at the next round or spawn)",
    usage: "loadout <primary> <secondary>",
  };

  async execute(args: string[]): Promise<CommandOutput> {
    if (args.length === 0) return this.help();
    if (args.length === 1 && args[0].toLowerCase() === "status")
      return Game.getInstance().describeLoadoutStateForAudit();

    const choice = parseLoadout(args[0], args[1]);
    if (!choice) return fail(`Unknown weapon: "${args[0]} ${args[1] ?? ""}".\n\n${this.help()}`);

    if (!Game.getInstance().sendLoadout(choice.primary, choice.secondary)) {
      return fail("Not connected to a server.");
    }
    const when = MatchStateManager.getInstance().loadoutMode === "respawn" ? "your next spawn" : "the next round";
    return `Loadout set: ${describeLoadout(choice)} — from ${when}.`;
  }

  private help(): string {
    const list = (ids: readonly string[]) =>
      ids.map((id) => `  ${id.padEnd(14)}${WEAPON_LABELS[id as keyof typeof WEAPON_LABELS]}`).join("\n");
    return [
      "Usage: loadout <primary> <secondary>",
      "loadout status — inspect your selected kit, last server state, inventory and HUD",
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
