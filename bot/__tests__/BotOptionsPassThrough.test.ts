/**
 * Options reach the bot: the server passes every option through, and a bot's
 * match sense comes from its preset (the rating reference does not carry it).
 */

import { describe, expect, it } from "vitest";
import { BotClient } from "../BotClient";
import { botOptionsFor } from "../BotServer";

describe("botOptionsFor", () => {
  it("passes every option through and fills in the defaults", () => {
    const options = botOptionsFor({ difficulty: "hard", strategy: false, habitItem: "ra", chat: false }, "models");
    expect(options).toMatchObject({
      difficulty: "hard",
      strategy: false,
      habitItem: "ra",
      chat: false,
      modelDir: "models",
    });
    expect(options.name).toBeTruthy();
    expect(botOptionsFor(undefined, undefined).difficulty).toBe("medium");
  });
});

describe("a bot's match sense", () => {
  const senseOf = (bot: BotClient) =>
    (bot as unknown as { _difficulty: { matchSense?: number } })._difficulty.matchSense;

  it("comes from the preset", () => {
    expect(senseOf(new BotClient({ name: "a", difficulty: "hard", chat: false }))).toBe(0.8);
    expect(senseOf(new BotClient({ name: "b", difficulty: "easy", chat: false }))).toBe(0);
  });

  it("is off with strategy false", () => {
    expect(senseOf(new BotClient({ name: "c", difficulty: "insane", strategy: false, chat: false }))).toBe(0);
  });
});
