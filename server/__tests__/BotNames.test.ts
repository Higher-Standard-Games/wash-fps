import { describe, expect, it } from "vitest";
import { BOT_NAMES, isBotName } from "../../shared/bot/BotNames";
import { getNextBotName } from "../BotNames";

describe("getNextBotName", () => {
  it("takes the shared list in order, then numbered copies the lobby reserves", () => {
    const used = new Set<string>();
    for (const name of BOT_NAMES) {
      expect(getNextBotName(used)).toBe(name);
      used.add(name);
    }
    const again = getNextBotName(used);
    expect(again).toBe(`${BOT_NAMES[0]}_2`);
    expect(isBotName(again)).toBe(true);
  });

  it("never names a bot after a team", () => {
    expect(isBotName("Udon")).toBe(false);
    expect(isBotName("Soba")).toBe(false);
  });
});
