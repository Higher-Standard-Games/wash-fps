/**
 * Names for the game server's own bots, from the list every bot plays under.
 */

import { BOT_NAMES } from "../../../shared/bot/BotNames";

/**
 * Get next available bot name, avoiding duplicates within the current match.
 * Takes the list in order; once every name is used, a name comes again with
 * `_2`, `_3`, …, the suffix the lobby reserves along with the names.
 */
export function getNextBotName(usedNames: Set<string>): string {
  for (const name of BOT_NAMES) {
    if (!usedNames.has(name)) return name;
  }
  for (let counter = 2; ; counter++) {
    for (const name of BOT_NAMES) {
      const candidate = `${name}_${counter}`;
      if (!usedNames.has(candidate)) return candidate;
    }
  }
}
