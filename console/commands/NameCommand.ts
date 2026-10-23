/**
 * NameCommand — Set or display player name
 *
 * Usage:
 *   name              → Show current name
 *   name <newname>    → Rename your account when logged in to the lobby;
 *                       otherwise set the name for local play only
 */

import { Command, type CommandDef } from "../../../../engine/console/Command";
import { PlayerProfile } from "../../../../engine/player/PlayerProfile";
import { currentIdentity, renameAccount, renameFailureText } from "../../../../lobby/AccountSession";
import { NAME_PATTERN } from "../../../../lobby/PlayerIdentity";

export default class NameCommand extends Command {
  readonly definition: CommandDef = {
    name: "name",
    description: "Set or display player name",
    usage: "name [newname]",
  };

  async execute(args: string[]): Promise<string | undefined> {
    const profile = PlayerProfile.load();
    const account = currentIdentity();

    if (args.length === 0) {
      return account
        ? `Player name: ${account.name}  (account ${account.id})`
        : `Player name: ${profile.name}  (not logged in to the lobby)`;
    }

    const newName = args.join(" ").trim();
    if (!NAME_PATTERN.test(newName)) {
      return renameFailureText("name_invalid");
    }

    // Logged in: the account owns the name, and the profile follows it
    if (account) {
      const outcome = await renameAccount(newName);
      return outcome.ok ? `Name changed: ${account.name} → ${outcome.identity.name}` : renameFailureText(outcome.code);
    }

    const oldName = profile.name;
    profile.name = newName;
    profile.save();
    return `Name changed for local play: ${oldName} → ${newName}. Online, your account's name is used; rename again once logged in to the lobby.`;
  }
}
