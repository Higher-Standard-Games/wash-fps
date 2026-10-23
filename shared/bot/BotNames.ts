/**
 * Names bots play under: the bot server's bots and the game server's own. The
 * lobby reserves them, so a bot and a player never share a name in a room, a
 * scoreboard or a demo.
 *
 * When the list runs out a bot takes a name again with `_2`, `_3`, …; those
 * forms are reserved too. Udon and Soba are the team names, so neither is here.
 */

export const BOT_NAMES: readonly string[] = [
  "Ramen",
  "Washiki!",
  "Noodlesoup",
  "Tonkotsu",
  "Shoyu",
  "Miso",
  "Tempura",
  "Mochi",
  "Wasabi",
  "Onigiri",
  "Takoyaki",
  "Gyoza",
  "Narutomaki",
  "Chashu",
  "Menma",
  "Ajitama",
  "Kaedama",
  "Nori",
  "Katsudon",
  "Dango",
  "Edamame",
  "Furikake",
  "Umeboshi",
  "Natto",
  "Bento",
  "Karaage",
  "Tamago",
  "Taiyaki",
  "Oden",
  "Dashi",
  "Slurp-san",
  "Extra Spicy",
  "Noodle Ninja",
  "Chopsticks",
  "Kamaboko",
  "Broth Lord",
];

const RESERVED = new Set(BOT_NAMES.map((name) => name.toLowerCase()));

/** Whether `name` is a bot name, in any capitals, with or without a `_<digits>` suffix. */
export function isBotName(name: string): boolean {
  return RESERVED.has(name.toLowerCase().replace(/_\d+$/, ""));
}
