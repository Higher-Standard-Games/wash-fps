/**
 * Who in a recording is a bot, for the bot tools: a name from the bot list or
 * from the campaign's missions in `config/campaign.json` (read from the
 * working directory, the assembled root). Recordings do not mark bots.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { campaignBotNames } from "../../../lobby/Campaign";
import { isBotName } from "../shared/bot/BotNames";

export function botNameTest(): (name: string) => boolean {
  let campaign = new Set<string>();
  try {
    campaign = campaignBotNames(
      JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "campaign.json"), "utf8")),
    );
  } catch {
    // No campaign here: only the bot list's names
  }
  return (name) => isBotName(name) || campaign.has(name.toLowerCase());
}
